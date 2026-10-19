"""文献挖掘共享工具（设计文档 §9.2 冻结的公开函数）。

文件名按设计 §9.1 冻结为 ``literature-common.py``（含连字符，不能用 ``import``
语句直接导入）。阶段脚本统一按下列片段引用（已实测可行）：

    import importlib
    import sys
    from pathlib import Path

    TOOLS = Path(__file__).resolve().parent
    if str(TOOLS) not in sys.path:
        sys.path.insert(0, str(TOOLS))
    common = importlib.import_module("literature-common")

约定（设计 §2.1/§4.1/§4.2/§4.4）：
- stdout 只输出 NDJSON 事件行（``emit``）；除事件外不得输出任何内容；
- 所有 JSON 落盘走「同目录临时文件 + 原子替换」（``atomic_write_json``）；
- CSV 用 utf-8-sig 写入（``atomic_write_text(..., encoding="utf-8-sig")``）；
- job 目录结构与文件名集中由 ``job_paths()`` 定义；
- ``events.jsonl`` 只由任务驱动方追加（连接器 / literature_pipeline.py）。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 管道编码二次防线（设计 §8.2）

#: 六阶段冻结顺序（设计 §2）
STAGES = ["discover", "dedupe", "fulltext", "extract", "validate", "export"]

#: NDJSON 事件四类型（设计 §2.2）
EVENT_TYPES = ("stage", "attention", "error", "result")

#: 各阶段默认超时（秒，设计 §3.1 limits 表缺省）
DEFAULT_LIMITS = {
    "discover": 180,
    "dedupe": 120,
    "fulltext": 3600,
    "extract": 1800,
    "validate": 300,
    "export": 600,
}

#: 证据等级取值域（全链共享，设计 §3.5）
EVIDENCE_LEVELS = ("search_result_snippet", "abstract_only", "fulltext_html", "fulltext_pdf")


def emit(kind: str, **values: Any) -> None:
    """stdout 输出一行 NDJSON 事件（utf-8、逐行 flush；设计 §2.2）。"""
    sys.stdout.write(json.dumps({"type": str(kind), **values}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_iso() -> str:
    """UTC ISO-8601 时间戳（与既有产物口径一致，+00:00 后缀）。"""
    return datetime.now(timezone.utc).isoformat()


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """同目录临时文件 + ``os.replace`` 原子替换（设计 §2.1）。"""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    temp = Path(temp_name)
    try:
        with os.fdopen(handle, "w", encoding=encoding, newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, obj: Any, *, indent: int = 2) -> None:
    """原子写 JSON（ensure_ascii=False，末尾换行，与既有产物风格一致）。"""
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=indent) + "\n")


def load_json(path: Path, default: Any = None) -> Any:
    """读取 JSON；文件缺失或内容非法时返回 ``default``（不抛出）。"""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def safe_csv_cell(value: object) -> str:
    """防公式注入（与 literature_search.py 原实现逐字一致，设计 §10 不回归）。"""
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def safe_url(value: object) -> str:
    """仅放行 http/https 绝对地址，其余返回空串。"""
    if not isinstance(value, str):
        return ""
    parsed = urlparse(value.strip())
    return value.strip() if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def job_paths(job_dir: Path) -> dict:
    """任务目录（§4.1）内的全部目录/文件常量（集中定义，双方驱动共用）。"""
    root = Path(job_dir)
    return {
        "root": root,
        "job": root / "job.json",
        "run_config": root / "run_config.json",
        "confirmations": root / "confirmations.json",
        "events": root / "events.jsonl",
        "candidates_json": root / "candidates.json",
        "candidates_csv": root / "candidates.csv",
        "dedupe_dir": root / "dedupe",
        "dedupe_json": root / "dedupe" / "dedupe.json",
        "dedupe_csv": root / "dedupe" / "dedupe.csv",
        "fulltext_dir": root / "fulltext",
        "fulltext_status": root / "fulltext" / "status.json",
        "fulltext_files": root / "fulltext" / "files",
        "extraction_dir": root / "extraction",
        "extraction_inputs": root / "extraction" / "inputs",
        "extraction_check": root / "extraction" / "check_report.json",
        "validation_dir": root / "validation",
        "validation_json": root / "validation" / "validation.json",
        "validation_md": root / "validation" / "validation.md",
        "export_dir": root / "export",
        "export_history": root / "export" / "history",
        "export_literature_csv": root / "export" / "literature.csv",
        "export_literature_xlsx": root / "export" / "literature.xlsx",
        "export_parameters_csv": root / "export" / "parameters.csv",
        "export_parameters_xlsx": root / "export" / "parameters.xlsx",
        "export_report": root / "export" / "export_report.md",
    }


def append_event_log(job_dir: Path, event: dict) -> None:
    """追加一行到 ``<job>/events.jsonl``（§4.2 格式：at/type/stage/message/extra?）。

    只由任务驱动方调用；阶段脚本不得写入（避免双写交错）。
    """
    if not isinstance(event, dict):
        return
    record = {
        "at": now_iso(),
        "type": str(event.get("type") or ""),
        "stage": str(event.get("stage") or ""),
        "message": str(event.get("message") or ""),
    }
    extra = {key: value for key, value in event.items() if key not in {"type", "stage", "message"}}
    if extra:
        record["extra"] = extra
    path = job_paths(job_dir)["events"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()


def resolve_limits(config: dict | None) -> dict:
    """合并 run_config.limits 与默认超时表（设计 §3.1/§8.3）。"""
    limits = dict(DEFAULT_LIMITS)
    if isinstance(config, dict):
        sources = config.get("sources")
        source_count = len(sources) if isinstance(sources, list) else 1
        target = config.get("perSourceLimit", 100) if config.get("searchMode") == "formal" else 10
        if not isinstance(target, int) or isinstance(target, bool) or not 1 <= target <= 1000:
            target = 100 if config.get("searchMode") == "formal" else 10
        pages = (target + 9) // 10
        limits["discover"] = min(86400, 180 * min(6, max(1, source_count)) * pages)
    if isinstance(config, dict) and isinstance(config.get("limits"), dict):
        for stage, value in config["limits"].items():
            if stage in limits and isinstance(value, int) and not isinstance(value, bool) and value > 0:
                limits[stage] = value
    return limits


def extraction_result_ok(payload: Any, stem: str) -> bool:
    """提取结果骨架（7 顶层键中与全链相关的关键键）。

    完整校验归 I4 的 ``literature_extract.py --check``；这里只做编排层判定：
    dict + ``paper_id`` 等于文件名 stem + ``status`` ∈ {ok, partial, skipped} + rows 为列表。
    """
    if not isinstance(payload, dict):
        return False
    if str(payload.get("paper_id") or "") != stem:
        return False
    if str(payload.get("status") or "") not in {"ok", "partial", "skipped"}:
        return False
    return isinstance(payload.get("rows"), list)


def extraction_coverage(job_dir: Path) -> dict:
    """bundle 与提取结果的覆盖情况（pipeline 编排 + 阶段完成判定共用）。

    - ``bundles``: ``extraction/inputs/*.json`` 数量；
    - ``results``: 骨架合法的结果文件数；
    - ``pending``: 尚无结果文件的 stem 列表；
    - ``invalid``: 有结果文件但骨架非法的 stem 列表。
    """
    paths = job_paths(job_dir)
    inputs_dir = paths["extraction_inputs"]
    stems = sorted(item.stem for item in inputs_dir.glob("*.json")) if inputs_dir.is_dir() else []
    results_dir = paths["extraction_dir"]
    pending: list[str] = []
    invalid: list[str] = []
    ok_count = 0
    for stem in stems:
        candidate = results_dir / f"{stem}.json"
        if not candidate.is_file():
            pending.append(stem)
            continue
        payload = load_json(candidate)
        if extraction_result_ok(payload, stem):
            ok_count += 1
        else:
            invalid.append(stem)
    return {"bundles": len(stems), "results": ok_count, "pending": pending, "invalid": invalid}


def detect_completed_stages(job_dir: Path) -> dict:
    """§4.4 产物判定表 → ``{"<stage>": "done" | "pending"}``（键序同 STAGES）。"""
    paths = job_paths(job_dir)
    detected: dict[str, str] = {}

    candidates = load_json(paths["candidates_json"])
    batches = candidates.get("batches") if isinstance(candidates, dict) else None
    detected["discover"] = "done" if isinstance(batches, list) and batches and candidates.get("discovery_complete") is not False else "pending"

    dedupe = load_json(paths["dedupe_json"])
    dedupe_ok = (
        isinstance(dedupe, dict)
        and isinstance(dedupe.get("version"), int)
        and not isinstance(dedupe.get("version"), bool)
        and dedupe["version"] >= 1
        and isinstance(dedupe.get("groups"), list)
    )
    detected["dedupe"] = "done" if dedupe_ok else "pending"

    status = load_json(paths["fulltext_status"])
    items = status.get("items") if isinstance(status, dict) else None
    fulltext_ok = (
        isinstance(items, list)
        and bool(items)
        and all(isinstance(item, dict) and str(item.get("status") or "") != "pending" for item in items)
    )
    detected["fulltext"] = "done" if fulltext_ok else "pending"

    coverage = extraction_coverage(job_dir)
    extract_ok = bool(coverage["bundles"]) and not coverage["pending"] and not coverage["invalid"]
    detected["extract"] = "done" if extract_ok else "pending"

    validation = load_json(paths["validation_json"])
    detected["validate"] = "done" if isinstance(validation, dict) else "pending"

    export_ok = paths["export_literature_xlsx"].is_file() and paths["export_parameters_xlsx"].is_file()
    detected["export"] = "done" if export_ok else "pending"

    return {stage: detected[stage] for stage in STAGES}


def stage_counts(job_dir: Path) -> dict:
    """counters 汇总（§4.3；读取不到的阶段计数为 None）。"""
    paths = job_paths(job_dir)
    counts: dict[str, Any] = {
        "candidates": None,
        "uniqueGroups": None,
        "fulltextFetched": None,
        "extractedPapers": None,
        "parameterRows": None,
    }
    candidates = load_json(paths["candidates_json"])
    if isinstance(candidates, dict):
        value = candidates.get("count")
        if not isinstance(value, int) or isinstance(value, bool):
            value = len(candidates.get("records") or [])
        counts["candidates"] = value
    dedupe = load_json(paths["dedupe_json"])
    if isinstance(dedupe, dict) and isinstance(dedupe.get("counts"), dict):
        counts["uniqueGroups"] = dedupe["counts"].get("groups")
    fulltext = load_json(paths["fulltext_status"])
    if isinstance(fulltext, dict) and isinstance(fulltext.get("counts"), dict):
        detail = fulltext["counts"]
        counts["fulltextFetched"] = sum(
            value for value in (detail.get("fetched_pdf"), detail.get("fetched_html")) if isinstance(value, int)
        )
    coverage = extraction_coverage(job_dir)
    if coverage["bundles"]:
        counts["extractedPapers"] = coverage["results"]
    validation = load_json(paths["validation_json"])
    if isinstance(validation, dict) and isinstance(validation.get("counts"), dict):
        counts["parameterRows"] = validation["counts"].get("parameters_total")
    return counts
