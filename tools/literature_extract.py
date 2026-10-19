"""Literature-mining extract stage — the Python half.

Frozen contract: ``docs/literature-mining-stage2-design.md`` §2.4.4 / §3.2 / §3.6.

Two modes:

* ``--prepare``  build one bundle per paper at ``extraction/inputs/<paper_id>.json``
  from the effective confirmed field definitions (``confirmations.json``, see §3.2)
  plus ``fulltext/status.json``; bundles already carrying the same schema hash are
  reused unless ``--force`` is given.
* ``--check``    verify every ``extraction/<paper_id>.json`` result against the
  frozen 7-key contract (keys, ``paper_id`` == file stem, legal row fields,
  traceable evidence, legal provenance marker).  Any missing/illegal result
  ends the stage with an ``error`` event and exit code 1.

The LLM fill-in itself lives in ``tools/literature-extract.js`` (the Node half);
this script never talks to a model.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _load_literature_common():
    """引用 I1 的 tools/literature-common.py（设计 §9.1「引用」）。"""
    for name in ("literature_common", "literature-common"):
        try:
            module = importlib.import_module(name)
        except Exception:
            continue
        if callable(getattr(module, "emit", None)):
            return module
    return None


_COMMON = _load_literature_common()


def _shared(name: str, fallback):
    function = getattr(_COMMON, name, None) if _COMMON is not None else None
    return function if callable(function) else fallback


def _fallback_emit(kind: str, **values: object) -> None:
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


def _fallback_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fallback_atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _fallback_atomic_write_json(path: Path, obj: object, *, indent: int = 2) -> None:
    _fallback_atomic_write_text(Path(path), json.dumps(obj, ensure_ascii=False, indent=indent) + "\n")


def _fallback_safe_csv_cell(value: object) -> str:
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def _fallback_safe_url(value: object) -> str:
    if not isinstance(value, str):
        return ""
    parsed = urlparse(value.strip())
    return value.strip() if parsed.scheme in {"http", "https"} and parsed.netloc else ""


emit = _shared("emit", _fallback_emit)
now_iso = _shared("now_iso", _fallback_now_iso)
atomic_write_json = _shared("atomic_write_json", _fallback_atomic_write_json)
atomic_write_text = _shared("atomic_write_text", _fallback_atomic_write_text)
safe_csv_cell = _shared("safe_csv_cell", _fallback_safe_csv_cell)
safe_url = _shared("safe_url", _fallback_safe_url)


TOP_KEYS = ("paper_id", "source_pdf", "status", "classification_reason", "rows", "warnings", "skip_reason")
INSTRUCTIONS_VERSION = "extract-contract-v1"
DEFAULT_MAX_CHARS = 120000
FULLTEXT_READY = {"fetched_pdf", "fetched_html"}
FIGURE_PROVENANCE = re.compile(r"^figure-extracted from \S+( .+)?$")
CALCULATED_PROVENANCE = re.compile(r"^calculated: .+$")


class StageError(Exception):
    """Stage-level failure: reported as a single ``error`` event, exit code 1."""


# --------------------------------------------------------------------------- config

def load_config(path: Path) -> dict:
    """Self-check the frozen run_config (second line of defence, §2.4)."""
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise StageError("运行配置不存在") from None
    except json.JSONDecodeError as error:
        raise StageError(f"运行配置不是合法 JSON：{error}") from None
    if not isinstance(config, dict):
        raise StageError("运行配置无效：必须是 JSON 对象")
    extraction = config.get("extraction")
    if extraction is not None:
        if not isinstance(extraction, dict):
            raise StageError("运行配置无效：extraction 必须是对象")
        limit = extraction.get("maxCharsPerPaper")
        if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0):
            raise StageError("运行配置无效：extraction.maxCharsPerPaper 必须是正整数")
    return config


def max_chars_per_paper(config: dict) -> int:
    extraction = config.get("extraction")
    if isinstance(extraction, dict):
        value = extraction.get("maxCharsPerPaper")
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return DEFAULT_MAX_CHARS


# --------------------------------------------------------------------------- schema

def load_effective_schema(job_dir: Path) -> dict | None:
    """Effective schema = latest ``kind="fieldDefinitions"`` record (§3.2).

    Returns ``{"fields", "sha256", "source", "at"}`` or ``None`` when the
    researcher has not confirmed any field definitions yet.
    """
    path = Path(job_dir) / "confirmations.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    records = data.get("records") if isinstance(data, dict) else None
    latest = None
    for record in records or []:
        if isinstance(record, dict) and record.get("kind") == "fieldDefinitions" and isinstance(record.get("fields"), list):
            latest = record
    if latest is None:
        return None
    fields = []
    for entry in latest["fields"]:
        if not isinstance(entry, dict):
            raise StageError("已确认的字段定义无效：每个字段必须是对象")
        key = str(entry.get("key") or "").strip()
        if not key:
            raise StageError("已确认的字段定义无效：缺少 key")
        fields.append(entry)
    seen: set[str] = set()
    for entry in fields:
        key = str(entry["key"]).strip()
        if key in seen:
            raise StageError(f"已确认的字段定义无效：key 重复（{key}）")
        seen.add(key)
    sha = hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    at = str(latest.get("at") or "")
    return {"fields": fields, "sha256": sha, "at": at, "source": f"confirmations.json#fieldDefinitions@{at}"}


def require_schema(job_dir: Path) -> dict:
    schema = load_effective_schema(job_dir)
    if schema is None:
        raise StageError("提取前需先在研究者确认参数字段含义与单位")
    return schema


def schema_keys(schema: dict) -> list[str]:
    keys: list[str] = []
    for entry in schema.get("fields") or []:
        key = str(entry.get("key") or "").strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def condition_keys(schema: dict) -> list[str]:
    """Union of every field's ``conditionKeys``, first-seen order (§3.6)."""
    keys: list[str] = []
    for entry in schema.get("fields") or []:
        values = entry.get("conditionKeys")
        if not isinstance(values, list):
            continue
        for value in values:
            text = str(value or "").strip()
            if text and text not in keys:
                keys.append(text)
    return keys


# --------------------------------------------------------------------------- fulltext -> bundle

def safe_paper_id(paper_id: str) -> bool:
    return bool(paper_id) and "/" not in paper_id and "\\" not in paper_id and paper_id not in {".", ".."} and not paper_id.startswith(".")


def extract_pdf_text(path: Path) -> tuple[str, str]:
    """Return ``(text, degraded_reason)``; PDF parsing failures degrade, never abort (V5)."""
    try:
        import pypdf  # noqa: PLC0415 - optional dependency, imported lazily
    except Exception:
        return "", "pypdf 未安装，无法解析 PDF 正文（该篇标为待补充）"
    try:
        reader = pypdf.PdfReader(str(path))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n".join(pages).strip()
    except Exception as error:  # corrupt/encrypted/unsupported PDF
        return "", f"PDF 正文解析失败（{type(error).__name__}: {error}）（待补充）"
    if not text:
        return "", "PDF 未解析出可读文本（可能为扫描件）（待补充）"
    return text, ""


def read_fulltext_text(job_dir: Path, item: dict) -> tuple[str, str]:
    """Return ``(text, degraded_reason)`` for one ``fulltext/status.json`` item."""
    kind = str(item.get("kind") or "").strip()
    relative = str(item.get("path") or "").strip()
    if not relative:
        return "", "全文文件未落盘（待补充）"
    target = (Path(job_dir) / relative).resolve()
    try:
        target.relative_to(Path(job_dir).resolve())
    except ValueError:
        return "", "全文路径越出任务目录（待补充）"
    if not target.is_file():
        return "", "全文文件不存在（待补充）"
    if kind == "pdf" or target.suffix.lower() == ".pdf":
        return extract_pdf_text(target)
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        return "", f"全文文本读取失败（{error}）"
    if not text.strip():
        return "", "全文文本为空（待补充）"
    return text, ""


def build_bundles(config: dict, job_dir: Path, *, force: bool = False) -> dict:
    """Write ``extraction/inputs/<paper_id>.json`` bundles; returns counts + files."""
    job_dir = Path(job_dir)
    schema = require_schema(job_dir)
    status_path = job_dir / "fulltext" / "status.json"
    if not status_path.is_file():
        raise StageError("尚未完成全文获取")
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise StageError(f"全文状态文件损坏：{error}") from None
    items = [item for item in (status.get("items") or []) if isinstance(item, dict)]
    max_chars = max_chars_per_paper(config)
    keys = schema_keys(schema)
    conditions = condition_keys(schema)
    inputs_dir = job_dir / "extraction" / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)

    # 先整体扫描过期 bundle（schema 已变化）：不静默重建，要求 --force（§2.4.4 关口）。
    stale: list[str] = []
    for item in items:
        paper_id = str(item.get("paper_id") or "").strip()
        if not safe_paper_id(paper_id):
            continue
        bundle_path = inputs_dir / f"{paper_id}.json"
        if not bundle_path.is_file():
            continue
        existing = None
        try:
            existing = json.loads(bundle_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = None
        if isinstance(existing, dict) and existing.get("schema_sha256") != schema["sha256"]:
            stale.append(paper_id)
    if stale and not force:
        shown = "、".join(stale[:5]) + ("…" if len(stale) > 5 else "")
        raise StageError(f"提取输入包与当前已确认字段定义不一致（{shown}）；请使用 --force 重建提取输入包后重跑")

    created: list[str] = []
    reused: list[str] = []
    degraded: list[dict] = []
    skipped: list[dict] = []
    files: list[str] = []

    for item in items:
        paper_id = str(item.get("paper_id") or "").strip()
        if not safe_paper_id(paper_id):
            skipped.append({"paper_id": paper_id, "reason": "论文 ID 缺失或非法，无法生成提取输入包"})
            continue
        relative = f"extraction/inputs/{paper_id}.json"
        bundle_path = inputs_dir / f"{paper_id}.json"
        if bundle_path.is_file() and not force:
            existing = None
            try:
                existing = json.loads(bundle_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = None
            if isinstance(existing, dict) and existing.get("schema_sha256") == schema["sha256"]:
                reused.append(paper_id)
                files.append(relative)
                continue
        item_status = str(item.get("status") or "")
        if item_status not in FULLTEXT_READY:
            skipped.append({"paper_id": paper_id, "reason": f"全文状态为 {item_status or '未知'}，不生成提取输入包"})
            continue
        text, degraded_reason = read_fulltext_text(job_dir, item)
        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars]
        bundle = {
            "schema_version": 1,
            "instructions_version": INSTRUCTIONS_VERSION,
            "schema_sha256": schema["sha256"],
            "paper_id": paper_id,
            "title": str(item.get("title") or ""),
            "doi": str(item.get("doi") or ""),
            "source_url": safe_url(item.get("source_url")),
            "fulltext": {
                "kind": str(item.get("kind") or ""),
                "path": str(item.get("path") or ""),
                "text": text,
                "chars": len(text),
                "truncated": truncated,
            },
            "field_definitions": schema["fields"],
            "condition_keys": conditions,
        }
        if degraded_reason:
            bundle["degraded"] = {"reason": degraded_reason}
            degraded.append({"paper_id": paper_id, "reason": degraded_reason})
        atomic_write_json(bundle_path, bundle)
        created.append(paper_id)
        files.append(relative)

    return {
        "count": len(created),
        "counts": {
            "bundles": len(created) + len(reused),
            "created": len(created),
            "reused": len(reused),
            "degraded": len(degraded),
            "skipped": len(skipped),
        },
        "files": files,
        "created": created,
        "reused": reused,
        "degraded": degraded,
        "skipped": skipped,
        "schema_sha256": schema["sha256"],
        "keys": keys,
    }


# --------------------------------------------------------------------------- --check

def check_skeleton(data: object, paper_id: str, allowed_fields: set[str]) -> list[str]:
    """Skeleton validation of one extraction result (§2.4.4). Returns reasons."""
    problems: list[str] = []
    if not isinstance(data, dict):
        return ["顶层必须是 JSON 对象"]
    missing = [key for key in TOP_KEYS if key not in data]
    if missing:
        problems.append("缺少顶层键：" + "、".join(missing))
    if str(data.get("paper_id") or "") != paper_id:
        problems.append(f"paper_id={data.get('paper_id')!r} 与文件名 {paper_id!r} 不一致")
    status = data.get("status")
    if status not in {"ok", "partial", "skipped"}:
        problems.append(f"status={status!r} 不在 ok/partial/skipped")
    if status == "skipped" and not str(data.get("skip_reason") or "").strip():
        problems.append("status=skipped 必须给出 skip_reason")
    rows = data.get("rows")
    if not isinstance(rows, list):
        return problems + ["rows 必须是数组"]
    if status in {"ok", "partial"} and not rows:
        problems.append("status=ok/partial 但 rows 为空")
    for index, row in enumerate(rows):
        label = f"rows[{index}]"
        if not isinstance(row, dict):
            problems.append(f"{label} 不是对象")
            continue
        if not str(row.get("row_id") or "").strip():
            problems.append(f"{label} 缺少 row_id")
        field = str(row.get("field") or "").strip()
        if not field:
            problems.append(f"{label} 缺少 field")
        elif field not in allowed_fields:
            problems.append(f"{label}.field={field!r} 不在已确认字段定义中")
        evidence = row.get("evidence") if isinstance(row.get("evidence"), dict) else {}
        if not str(evidence.get("where") or "").strip() and not str(evidence.get("quote") or "").strip():
            problems.append(f"{label} 缺少可追溯出处（evidence.where 与 evidence.quote 均为空）")
        provenance = str(row.get("provenance") or "").strip()
        if provenance and not (FIGURE_PROVENANCE.match(provenance) or CALCULATED_PROVENANCE.match(provenance)):
            problems.append(f"{label}.provenance={provenance!r} 不符合冻结格式（figure-extracted from … / calculated: …）")
    return problems


def check_results(job_dir: Path, config: dict) -> dict:
    """Validate every extraction result against its bundle; writes ``check_report.json``."""
    job_dir = Path(job_dir)
    schema = require_schema(job_dir)
    allowed = set(schema_keys(schema))
    inputs_dir = job_dir / "extraction" / "inputs"
    bundles = sorted(path for path in inputs_dir.glob("*.json") if path.is_file()) if inputs_dir.is_dir() else []
    if not bundles:
        raise StageError("尚未生成提取输入包，请先运行 --prepare")

    ok_ids: list[str] = []
    failures: list[dict] = []
    degraded: list[dict] = []
    for bundle_path in bundles:
        paper_id = bundle_path.stem
        result_path = job_dir / "extraction" / f"{paper_id}.json"
        if not result_path.is_file():
            failures.append({"paper_id": paper_id, "reasons": ["缺少提取结果文件"]})
            continue
        try:
            data = json.loads(result_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            failures.append({"paper_id": paper_id, "reasons": [f"JSON 解析失败：{error}"]})
            continue
        reasons = check_skeleton(data, paper_id, allowed)
        if reasons:
            failures.append({"paper_id": paper_id, "reasons": reasons})
        else:
            ok_ids.append(paper_id)
            if isinstance(data, dict) and data.get("status") == "skipped":
                degraded.append({"paper_id": paper_id, "reason": str(data.get("skip_reason") or "")})

    report = {
        "version": 1,
        "generated_at": now_iso(),
        "schema_sha256": schema["sha256"],
        "bundles": len(bundles),
        "ok": len(ok_ids),
        "failed": len(failures),
        "degraded": degraded,
        "failures": failures,
    }
    atomic_write_json(job_dir / "extraction" / "check_report.json", report)
    return report


# --------------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献挖掘 extract 阶段（Python 半）：bundle 生成 + 结果骨架校验")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true", help="生成 extraction/inputs/<paper_id>.json")
    mode.add_argument("--check", action="store_true", help="校验 extraction/<paper_id>.json 结果")
    parser.add_argument("--force", action="store_true", help="--prepare 时强制重建已存在的 bundle")
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
        if args.prepare:
            emit("stage", stage="extraction", message="按已确认字段定义生成逐篇提取输入包")
            result = build_bundles(config, args.output_dir, force=args.force)
            detail = f"已生成 {result['count']} 个提取输入包"
            if result["reused"]:
                detail += f"，复用 {len(result['reused'])} 个"
            if result["degraded"]:
                detail += f"（{len(result['degraded'])} 篇正文待补充）"
            emit("result", stage="extraction", message=detail, count=result["count"], counts=result["counts"], files=result["files"])
            return 0
        emit("stage", stage="extraction", message="校验逐篇提取结果")
        report = check_results(args.output_dir, config)
        if report["failed"]:
            summary = "；".join(f"{item['paper_id']}: {' / '.join(item['reasons'][:3])}" for item in report["failures"][:5])
            emit("error", message=f"提取结果校验未通过（{report['failed']} 篇）：{summary}")
            return 1
        message = f"提取结果全部通过（{report['ok']} 篇）"
        if report["degraded"]:
            message += f"；其中 {len(report['degraded'])} 篇标为待补充"
        emit("result", stage="extraction", message=message, count=report["ok"],
             counts={"bundles": report["bundles"], "ok": report["ok"], "failed": 0, "degraded": len(report["degraded"])},
             files=["extraction/check_report.json"])
        return 0
    except StageError as error:
        emit("error", message=str(error))
        return 1
    except Exception as error:  # noqa: BLE001 - stage boundary: any failure becomes one error event
        emit("error", message=f"提取阶段失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
