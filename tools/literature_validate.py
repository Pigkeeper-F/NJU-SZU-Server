"""Literature-mining validate stage: blocking (B1–B7) + pending (P1–P4) rules.

Frozen contract: ``docs/literature-mining-stage2-design.md`` §2.4.5 / §3.7 / §6.1 / §6.2,
rules traced to ``docs/literature-mining-alignment.md`` L21–L23.

* Blocking rows are **not** written to the main tables; each one is listed in
  ``validation.json`` ``blocking[]`` and in ``export_report.md``.
* Pending rows **are** written (``validation_status=pending_review``) and listed in
  ``validation.md``; nothing is silently filled, converted or deleted.
* Blocking/pending rows do **not** fail the stage: the run still exits 0 and only
  reports counts.  Exit 1 is reserved for internal errors.
"""
from __future__ import annotations

import argparse
import importlib
import json
import math
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from literature_extract import StageError, load_config  # noqa: E402
from literature_export import (  # noqa: E402
    literature_entries,
    literature_rows,
    load_inputs,
)


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


def _fallback_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


emit = _shared("emit", _fallback_emit)
now_iso = _shared("now_iso", _fallback_now_iso)
atomic_write_json = _shared("atomic_write_json", _fallback_atomic_write_json)
atomic_write_text = _shared("atomic_write_text", _fallback_atomic_write_text)

# §6.1 / §6.2 —— 编号与规则名一一对应（BLOCKING_RULES / PENDING_RULES）
BLOCKING_RULES = [
    "B1:missing_paper_link",
    "B2:missing_evidence",
    "B3:missing_field",
    "B4:missing_value",
    "B5:invalid_number",
    "B6:unknown_field",
    "B7:invalid_paper_id",
]
PENDING_RULES = [
    "P1:missing_doi",
    "P2:missing_unit",
    "P3:probable_duplicate",
    "P4:value_out_of_range",
]

SUGGESTIONS = {
    "missing_paper_link": "核对参数行 paper_id 与文献表的对应关系，修正后重跑校验",
    "missing_evidence": "回到原文补录出处（页码/表号/原文摘录）后重跑提取校验",
    "missing_field": "补上字段名（须在本次已确认的字段定义内）",
    "missing_value": "补上原文报告值；无法补齐则把该行标为待补充",
    "invalid_number": "核对原值与归一值，确认是否为有效数字（必要时补换算说明）",
    "unknown_field": "改回已确认字段，或先追加字段确认记录再重跑",
    "invalid_paper_id": "补上/修正 paper_id，保持一篇一行且全局唯一",
    "missing_doi": "人工复核题录后补 DOI；不得猜测（缺 DOI 不影响主表写入）",
    "missing_unit": "确认单位处理方式并写入字段定义或补充 unit_raw",
    "probable_duplicate": "人工比较合并组内记录，确认是否同一研究（不静默合并）",
    "value_out_of_range": "人工复核该值；如属合理值先在字段定义中确认范围/取值域",
}

PARAMETER_FULLTEXT_BLANK = {"", None}


# --------------------------------------------------------------------------- helpers

def _blank(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return False
    return str(value).strip() == ""


def _as_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None
    return None


def is_valid_number(value: object) -> bool:
    return _as_number(value) is not None


def _range_problem(definition: dict, row: dict) -> str:
    """P4 — 仅当字段定义显式给出 allowedRange/allowedValues 时检测（L22）。"""
    allowed_values = definition.get("allowedValues")
    if isinstance(allowed_values, list) and allowed_values:
        value = row.get("value_normalized")
        if _blank(value):
            value = row.get("value_raw")
        if _blank(value):
            return ""
        texts = [str(entry).strip() for entry in allowed_values]
        if str(value).strip() not in texts:
            return f"值 {value!r} 不在已确认取值域 {texts} 内"
        return ""
    allowed_range = definition.get("allowedRange")
    if isinstance(allowed_range, dict):
        number = _as_number(row.get("value_normalized"))
        if number is None:
            number = _as_number(row.get("value_raw"))
        if number is None:
            return ""
        low = _as_number(allowed_range.get("min"))
        high = _as_number(allowed_range.get("max"))
        if (low is not None and number < low) or (high is not None and number > high):
            return f"值 {number} 超出已确认范围 [{low if low is not None else '-∞'}, {high if high is not None else '+∞'}]"
    return ""


def _parameter_rules(row: dict, paper_id: str, fields: dict, literature_ids: set) -> tuple[list[str], list[str]]:
    """Apply §6.1/§6.2 to one parameter row → (blocking_rules, pending_rules)."""
    blocking: list[str] = []
    pending: list[str] = []
    field = str(row.get("field") or "").strip()
    evidence = row.get("evidence") if isinstance(row.get("evidence"), dict) else {}
    if not paper_id or paper_id not in literature_ids:
        blocking.append("missing_paper_link")
    if _blank(evidence.get("where")) and _blank(evidence.get("quote")):
        blocking.append("missing_evidence")
    if not field:
        blocking.append("missing_field")
    if _blank(row.get("value_raw")):
        blocking.append("missing_value")
    definition = fields.get(field) if field else None
    if field and definition is None:
        blocking.append("unknown_field")
    if definition is not None:
        if str(definition.get("valueType") or "").strip().lower() == "number":
            if not is_valid_number(row.get("value_normalized")):
                blocking.append("invalid_number")
            if _blank(row.get("unit_raw")):
                pending.append("missing_unit")
        if _range_problem(definition, row):
            pending.append("value_out_of_range")
    return blocking, pending


def _parameter_message(row: dict, rules: list[str], definition: dict | None) -> str:
    field = str(row.get("field") or "").strip() or "（未命名字段）"
    parts: list[str] = []
    for rule in rules:
        if rule == "missing_paper_link":
            parts.append("参数行缺少论文 ID 或无法关联文献")
        elif rule == "missing_evidence":
            parts.append("参数行缺少可追溯来源（evidence.where 与 evidence.quote 均为空）")
        elif rule == "missing_field":
            parts.append("参数行缺少字段名（field 为空）")
        elif rule == "missing_value":
            parts.append("参数行缺少原值（value_raw 为空）")
        elif rule == "invalid_number":
            parts.append(f"字段 {field} 声明为数值，但 value_normalized={row.get('value_normalized')!r} 不是有效数字")
        elif rule == "unknown_field":
            parts.append(f"字段 {field} 不在本次确认的字段定义中")
        elif rule == "missing_unit":
            parts.append(f"字段 {field} 为数值字段但未给出单位（unit_raw 为空）")
        elif rule == "value_out_of_range":
            parts.append(f"字段 {field} 出现异常值：{_range_problem(definition or {}, row) or '超出已确认取值域'}")
    return "；".join(parts)


# --------------------------------------------------------------------------- rules per entity

def literature_issues(inputs: dict) -> list[dict]:
    """B7 + P1 + P3 for literature rows (§6.1/§6.2)."""
    issues: list[dict] = []
    seen: set[str] = set()
    for entry in literature_entries(inputs):
        paper_id = entry["paper_id"]
        record = entry["record"]
        group = entry["group"] or {}
        is_canonical = paper_id == entry["canonical_id"]
        if not paper_id:
            issues.append({"level": "blocking", "entity": "literature", "paper_id": "", "rules": ["invalid_paper_id"],
                           "message": "文献行缺少 paper_id，无法关联候选记录"})
            continue
        if paper_id in seen:
            issues.append({"level": "blocking", "entity": "literature", "paper_id": paper_id, "rules": ["invalid_paper_id"],
                           "message": f"文献行 paper_id 重复：{paper_id}（一行不写入主表）"})
            continue
        seen.add(paper_id)
        doi = str(record.get("doi") or (group.get("doi") if is_canonical else "") or "").strip()
        if not doi:
            issues.append({"level": "pending", "entity": "literature", "paper_id": paper_id, "rules": ["missing_doi"],
                           "message": "缺少 DOI（不擅自补值，人工复核后补录）"})
    for group in inputs.get("groups") or []:
        if group.get("needs_review"):
            canonical_id = str(group.get("canonical_id") or "")
            score = group.get("max_score")
            issues.append({"level": "pending", "entity": "literature", "paper_id": canonical_id, "rules": ["probable_duplicate"],
                           "message": f"疑似重复：组 {canonical_id} 标记 needs_review（得分 {score}），人工确认前不静默合并"})
    return issues


def parameter_issues(inputs: dict, schema: dict | None) -> list[dict]:
    """B1–B6 + P2 + P4 for parameter rows (§6.1/§6.2)."""
    fields = {str(entry.get("key") or "").strip(): entry for entry in (schema or {}).get("fields") or []}
    literature_ids = {row["paper_id"] for row in literature_rows(inputs)}
    issues: list[dict] = []
    for paper_id, document in inputs.get("extractions") or []:
        if str(document.get("status") or "") == "skipped":
            continue
        for index, row in enumerate(document.get("rows") or []):
            if not isinstance(row, dict):
                continue
            blocking, pending = _parameter_rules(row, paper_id, fields, literature_ids)
            if blocking:
                definition = fields.get(str(row.get("field") or "").strip())
                issues.append({
                    "level": "blocking", "entity": "parameter", "row_id": str(row.get("row_id") or ""),
                    "paper_id": paper_id, "index": index, "rules": blocking,
                    "message": _parameter_message(row, blocking, definition),
                })
            elif pending:
                definition = fields.get(str(row.get("field") or "").strip())
                issues.append({
                    "level": "pending", "entity": "parameter", "row_id": str(row.get("row_id") or ""),
                    "paper_id": paper_id, "index": index, "rules": pending,
                    "message": _parameter_message(row, pending, definition),
                })
    return issues


def validate_literature(job_dir: Path) -> list[dict]:
    """§9.5 public entry: literature-row issues for one job."""
    inputs = load_inputs(job_dir, require_validation=False)
    return literature_issues(inputs)


def validate_parameters(job_dir: Path, schema: list | dict | None = None) -> list[dict]:
    """§9.5 public entry: parameter-row issues for one job (schema optional)."""
    inputs = load_inputs(job_dir, require_validation=False)
    if schema is None:
        schema = inputs.get("schema")
    elif isinstance(schema, list):
        schema = {"fields": schema}
    return parameter_issues(inputs, schema)


# --------------------------------------------------------------------------- outputs

def _collect(job_dir: Path) -> tuple[dict, list[dict], list[dict]]:
    inputs = load_inputs(Path(job_dir), require_validation=False)
    return inputs, literature_issues(inputs), parameter_issues(inputs, inputs.get("schema"))


def _public(issue: dict) -> dict:
    public = {key: value for key, value in issue.items() if key != "level"}
    return public


def _evidence_text(issue: dict, rows_index: dict, entries_index: dict) -> str:
    if issue.get("entity") == "parameter":
        row = rows_index.get((issue.get("paper_id"), issue.get("index")))
        if isinstance(row, dict):
            evidence = row.get("evidence") if isinstance(row.get("evidence"), dict) else {}
            where = str(evidence.get("where") or "").strip()
            quote = str(evidence.get("quote") or "").strip()
            parts = []
            if row.get("field"):
                parts.append(f"字段 {row['field']}")
            if row.get("value_raw") not in PARAMETER_FULLTEXT_BLANK:
                parts.append(f"原值 {row.get('value_raw')!r}")
            if where:
                parts.append(f"出处 {where}")
            if quote:
                parts.append(f"原文摘录 {quote[:80]}")
            return "；".join(parts) or "（无）"
        return "（无）"
    entry = entries_index.get(issue.get("paper_id"))
    if entry:
        record = entry["record"]
        parts = [f"题名 {str(record.get('title') or '')[:60]}"]
        if record.get("year") is not None:
            parts.append(f"年份 {record['year']}")
        parts.append(f"DOI {record.get('doi') or '（空）'}")
        return "；".join(parts)
    return "（无）"


def write_markdown(path: Path, counts: dict, blocking: list[dict], pending: list[dict], rows_index: dict, entries_index: dict) -> None:
    lines = [
        "# 校验待审清单（validation）",
        "",
        f"- 生成时间：{now_iso()}",
        f"- 字段定义来源：{counts.get('schema_source') or '（未确认字段定义）'}",
        f"- 参数行：共 {counts.get('parameters_total', 0)}，通过 {counts.get('ok', 0)}，阻断 {counts.get('blocking', 0)}，待审核 {counts.get('pending', 0)}",
        f"- 文献行：共 {counts.get('literature_total', 0)}，阻断 {counts.get('literature_blocking', 0)}，待审核 {counts.get('literature_pending', 0)}",
        "",
        "阻断行不写入主表，逐条列在 export_report.md 的错误报告中；待审核行写入主表（validation_status=pending_review）。不擅自补值、换算或删除。",
        "",
        "## 阻断（不写入主表）",
        "",
    ]
    if not blocking:
        lines.append("（无）")
    else:
        lines.append("| 记录 | 论文 | 规则 | 问题 | 已有证据 | 建议动作 |")
        lines.append("|---|---|---|---|---|---|")
        for issue in blocking:
            record = str(issue.get("row_id") or "-")
            lines.append("| {record} | {paper} | {rules} | {message} | {evidence} | {action} |".format(
                record=record.replace("|", "｜"),
                paper=str(issue.get("paper_id") or "").replace("|", "｜"),
                rules="、".join(issue.get("rules") or []),
                message=str(issue.get("message") or "").replace("|", "｜"),
                evidence=_evidence_text(issue, rows_index, entries_index).replace("|", "｜"),
                action="、".join(SUGGESTIONS.get(rule, "人工复核") for rule in issue.get("rules") or []).replace("|", "｜"),
            ))
    lines += ["", "## 待审核（写入主表并列入本清单）", ""]
    if not pending:
        lines.append("（无）")
    else:
        lines.append("| 记录 | 论文 | 规则 | 问题 | 已有证据 | 建议动作 |")
        lines.append("|---|---|---|---|---|---|")
        for issue in pending:
            record = str(issue.get("row_id") or "-")
            lines.append("| {record} | {paper} | {rules} | {message} | {evidence} | {action} |".format(
                record=record.replace("|", "｜"),
                paper=str(issue.get("paper_id") or "").replace("|", "｜"),
                rules="、".join(issue.get("rules") or []),
                message=str(issue.get("message") or "").replace("|", "｜"),
                evidence=_evidence_text(issue, rows_index, entries_index).replace("|", "｜"),
                action="、".join(SUGGESTIONS.get(rule, "人工复核") for rule in issue.get("rules") or []).replace("|", "｜"),
            ))
    atomic_write_text(Path(path), "\n".join(lines).rstrip() + "\n")


def run(config: dict, job_dir: Path) -> dict:
    job_dir = Path(job_dir)
    inputs, literature_issue_list, parameter_issue_list = _collect(job_dir)
    blocking = [issue for issue in literature_issue_list + parameter_issue_list if issue["level"] == "blocking"]
    pending = [issue for issue in literature_issue_list + parameter_issue_list if issue["level"] == "pending"]

    parameters_total = 0
    rows_index: dict = {}
    for paper_id, document in inputs.get("extractions") or []:
        if str(document.get("status") or "") == "skipped":
            continue
        for index, row in enumerate(document.get("rows") or []):
            parameters_total += 1
            if isinstance(row, dict):
                rows_index[(paper_id, index)] = row
    entries_index = {}
    for entry in literature_entries(inputs):
        entries_index.setdefault(entry["paper_id"], entry)

    parameter_blocking = [issue for issue in blocking if issue.get("entity") == "parameter"]
    parameter_pending = [issue for issue in pending if issue.get("entity") == "parameter"]
    literature_blocking = [issue for issue in blocking if issue.get("entity") == "literature"]
    literature_pending = [issue for issue in pending if issue.get("entity") == "literature"]

    schema = inputs.get("schema") or {}
    counts = {
        "parameters_total": parameters_total,
        "ok": max(0, parameters_total - len(parameter_blocking) - len(parameter_pending)),
        "blocking": len(parameter_blocking),
        "pending": len(parameter_pending),
        "literature_total": len(entries_index),
        "literature_blocking": len(literature_blocking),
        "literature_pending": len(literature_pending),
    }
    validation = {
        "version": 1,
        "generated_at": now_iso(),
        "schema_source": schema.get("source") or "（未确认字段定义）",
        "counts": counts,
        "blocking": [_public(issue) for issue in blocking],
        "pending": [_public(issue) for issue in pending],
    }
    validation_dir = job_dir / "validation"
    validation_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(validation_dir / "validation.json", validation)
    write_markdown(validation_dir / "validation.md", {**counts, "schema_source": validation["schema_source"]},
                   blocking, pending, rows_index, entries_index)
    return {
        "count": parameters_total,
        "counts": {"ok": counts["ok"], "blocking": counts["blocking"], "pending": counts["pending"]},
        "files": ["validation/validation.json", "validation/validation.md"],
    }


# --------------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献挖掘 validate 阶段：阻断（B1–B7）与待审核（P1–P4）规则校验")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--resume", action="store_true", help="与普通运行等价（validate 无条件全量重算，仅作 CLI 对称性）")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        emit("stage", stage="validation", message="按已确认字段定义校验提取结果")
        result = run(config, args.output_dir)
        counts = result["counts"]
        message = f"校验完成：共 {result['count']} 个参数行（通过 {counts['ok']}，阻断 {counts['blocking']}，待审核 {counts['pending']}）"
        emit("result", stage="validation", message=message, count=result["count"], counts=counts, files=result["files"])
        return 0
    except StageError as error:
        emit("error", message=str(error))
        return 1
    except Exception as error:  # noqa: BLE001 - stage boundary: any failure becomes one error event
        emit("error", message=f"校验阶段失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
