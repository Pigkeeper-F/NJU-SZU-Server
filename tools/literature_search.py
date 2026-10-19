"""Run a small, resumable multi-source discovery batch in the persistent browser.

This stage only collects search-result metadata. Snippets are not abstracts or
full-text evidence, and no paper is automatically included in an analysis.

第二阶段（设计 §2.4.1/§3.3）：来源校验读注册表；新增 ``--batch-index``/``--resume``；
``candidates.json`` 升级为累计视图（``batches[]`` + 记录新增 doi/year/authors/venue/
source_key/batch_index 字段——仅在结果页真实可得时填充；第 1 批 ``GSC-###`` 不变，
第 n≥2 批 ``GSC-B<n>-###``）。同批号重跑 = 该批整体替换；跨批去重交 dedupe 阶段。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = Path(__file__).resolve().parent
SOC_FETCH = ROOT / "SOC-database-pipeline-clean" / ".codex" / "skills" / "soc-paper-fetch" / "scripts"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
_common = importlib.import_module("literature-common")  # 文件名含连字符，见 literature-common.py 头部说明
_sources = importlib.import_module("literature_sources")

emit = _common.emit
safe_url = _common.safe_url
safe_csv_cell = _common.safe_csv_cell

CSV_FIELDS = [
    "candidate_id", "source", "query", "retrieved_at", "title", "byline", "snippet",
    "result_url", "fulltext_links", "screening_status", "evidence_level",
    "doi", "year", "authors", "venue", "source_key", "batch_index",
]
SOURCE_PREFIXES = {"google-scholar": "GSC", "cnki": "CNKI", "web-of-science": "WOS"}
ATTENTION_REASONS = {"login", "verification", "access_required", "results_unrecognized"}


def normalize_doi(value: object) -> str:
    """DOI 归一化（小写、去 doi.org 前缀）；拿不到时返回空串，不猜。"""
    text = str(value or "").strip().lower()
    text = re.sub(r"^https?://(dx\.)?doi\.org/", "", text)
    text = re.sub(r"^doi:\s*", "", text)
    return text[:200]


def parse_byline(byline: str) -> dict:
    """从 Scholar 结果行 byline（``作者 - 期刊, 年份 - 域名``）保守解析作者/期刊/年份。

    仅在结果页真实给出的文本上解析：拿不到一律留空，不编造 DOI/年份（设计 §3.3）。
    """
    text = " ".join(str(byline or "").split())
    if not text:
        return {"authors": "", "venue": "", "year": None}
    parts = [part.strip() for part in text.split(" - ") if part.strip()]
    authors = parts[0][:500] if parts else ""
    venue = ""
    year: int | None = None
    if len(parts) >= 2:
        second = parts[1]
        years = re.findall(r"\b(19\d{2}|20\d{2})\b", second)
        if years:
            year = int(years[-1])
        venue = re.sub(r"[,\s]*\b(19\d{2}|20\d{2})\b.*$", "", second).strip(" ,")[:300]
    return {"authors": authors, "venue": venue, "year": year}


def result_year(item: dict) -> int | None:
    """Use the explicit publication year first; never infer an experimental year."""
    raw = item.get("year")
    if isinstance(raw, str):
        # Database publication-date cells commonly contain e.g. "JAN 2020" or
        # "2020-01-05". A range/multiple years remains unknown, never guessed.
        years = re.findall(r"(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)", raw)
        if len(years) == 1:
            raw = int(years[0])
    if isinstance(raw, int) and not isinstance(raw, bool) and 1800 <= raw <= datetime.now(timezone.utc).year + 1:
        return raw
    return parse_byline(str(item.get("byline") or ""))["year"]


def metadata_text(value: object, maximum: int) -> str:
    if isinstance(value, list):
        value = "; ".join(str(entry) for entry in value if entry is not None)
    return str(value or "").strip()[:maximum]


def normalize_candidates(
    raw: list[dict],
    query: str,
    retrieved_at: str,
    *,
    batch_index: int = 1,
    source_key: str = "google-scholar",
    source_label: str = "Google Scholar",
) -> list[dict]:
    records: list[dict] = []
    seen: set[tuple[str, str]] = set()
    counters: dict[str, int] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:500]
        key = re.sub(r"\W+", "", title).casefold()
        item_source_key = str(item.get("source_key") or source_key)
        source_title = (item_source_key, key)
        if not title or not key or source_title in seen:
            continue
        seen.add(source_title)
        links = []
        for link in item.get("fulltext_links") or []:
            if not isinstance(link, dict):
                continue
            url = safe_url(link.get("url"))
            if url:
                links.append({"label": str(link.get("label") or "")[:100], "url": url})
        byline = str(item.get("byline") or "").strip()[:500]
        parsed = parse_byline(byline)
        source_prefix = SOURCE_PREFIXES.get(item_source_key, item_source_key.upper())
        prefix = source_prefix if batch_index <= 1 else f"{source_prefix}-B{batch_index}"
        counters[item_source_key] = counters.get(item_source_key, 0) + 1
        records.append({
            "candidate_id": f"{prefix}-{counters[item_source_key]:03d}",
            "source": _sources.label_of(item_source_key) or source_label,
            "query": str(item.get("_query") or query),
            "retrieved_at": retrieved_at,
            "title": title,
            "byline": byline,
            "snippet": str(item.get("snippet") or "").strip()[:2000],
            "result_url": safe_url(item.get("result_url")),
            "fulltext_links": links,
            "screening_status": "pending_review",
            "evidence_level": "search_result_snippet",
            "doi": normalize_doi(item.get("doi")),
            "year": result_year(item),
            "authors": metadata_text(item.get("authors"), 500) or parsed["authors"],
            "venue": metadata_text(item.get("venue"), 300) or parsed["venue"],
            "source_key": item_source_key,
            "batch_index": batch_index,
        })
    return records


def applied_filters(config: dict | None) -> list[str]:
    filters = ["query"]
    if config and config.get("publicationYearFrom") is not None:
        filters.append("publicationYearFrom")
    if config and config.get("publicationYearTo") is not None:
        filters.append("publicationYearTo")
    return filters


def deferred_rules(config: dict | None) -> list[str]:
    return ["geography", "language", "studyTypes", "inclusion", "exclusion", "targetFields"] if config else []


def load_existing_report(output_dir: Path) -> dict:
    report = _common.load_json(_common.job_paths(output_dir)["candidates_json"], default=None)
    return report if isinstance(report, dict) else {}


def normalize_existing_record(record: dict) -> dict:
    """v1 旧记录读入时补全可确定的新字段（v1 只可能是 Google Scholar 首批）。"""
    if not isinstance(record.get("source_key"), str) or not record.get("source_key"):
        record["source_key"] = "google-scholar"
    if not isinstance(record.get("batch_index"), int) or isinstance(record.get("batch_index"), bool):
        record["batch_index"] = 1
    record.setdefault("doi", "")
    record.setdefault("year", None)
    record.setdefault("authors", "")
    record.setdefault("venue", "")
    if not record.get("source"):
        record["source"] = "Google Scholar"
    return record


def csv_cells(record: dict) -> dict:
    cells: dict[str, str] = {}
    for name in CSV_FIELDS:
        value = record.get(name)
        if name == "fulltext_links":
            cells[name] = json.dumps(value if isinstance(value, list) else [], ensure_ascii=False)
        elif value is None:
            cells[name] = ""
        elif isinstance(value, (list, dict)):
            cells[name] = json.dumps(value, ensure_ascii=False)
        else:
            cells[name] = str(value)
    return {name: safe_csv_cell(cells[name]) for name in CSV_FIELDS}


def resolve_batch_index(output_dir: Path, config: dict, *, requested: int | None = None, resume: bool = False) -> int:
    """批次号：显式 ``--batch-index`` > ``--resume``（重跑最近一批）> 1 + 已有最大批号（新批次）。"""
    if requested is not None:
        return requested
    existing = load_existing_report(output_dir)
    indexes: list[int] = []
    batches = existing.get("batches")
    if isinstance(batches, list):
        for item in batches:
            if isinstance(item, dict) and isinstance(item.get("batch_index"), int) and not isinstance(item.get("batch_index"), bool):
                indexes.append(item["batch_index"])
    elif isinstance(existing.get("records"), list) and existing.get("records"):
        indexes.append(1)  # v1 单批旧文件视为第 1 批
    latest = max(indexes) if indexes else 0
    return latest if resume and latest else latest + 1


def batch_max(config: dict) -> int:
    value = config.get("batch")
    if isinstance(value, dict):
        raw = value.get("maxBatches")
        if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 1:
            return raw
    return 1


def batch_size(config: dict) -> int:
    value = config.get("batch")
    if isinstance(value, dict):
        raw = value.get("size")
        if isinstance(raw, int) and not isinstance(raw, bool) and 1 <= raw <= 10:
            return raw
    return int(config["limit"])


def write_results(output_dir: Path, query: str, search: dict, config: dict | None = None, *, batch_index: int = 1) -> dict:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    records = normalize_candidates(search.get("results") or [], query, retrieved_at, batch_index=batch_index)
    source_status = search.get("source_status")
    if not isinstance(source_status, dict):
        source_status = {}
    # Existing Scholar-only callers keep the v1 report keys and their semantics.
    # Multi-source callers provide actual per-source execution and filter status.
    if source_status:
        completed = [entry for entry in source_status.values() if entry.get("status") in {"ok", "no_results"}]
        applied = [name for name in applied_filters(config) if completed and all(name in entry.get("applied_filters", []) for entry in completed)]
        deferred = list(dict.fromkeys(name for entry in source_status.values() for name in entry.get("deferred_rules", [])))
    else:
        applied, deferred = applied_filters(config), deferred_rules(config)
    batch = {
        "batch_index": batch_index,
        "query": query,
        "search_url": safe_url(search.get("url")),
        "retrieved_at": retrieved_at,
        "count": len(records),
        "applied_filters": applied,
        "deferred_rules": deferred,
        "status": "partial" if search.get("pending_source") else "complete",
    }
    if source_status:
        batch["source_status"] = source_status
    if search.get("pending_source"):
        batch["pending_source"] = search["pending_source"]
    existing = load_existing_report(output_dir)
    grouped: dict[int, list[dict]] = {}
    for record in existing.get("records") or []:
        if not isinstance(record, dict):
            continue
        normalize_existing_record(record)
        if record.get("batch_index") == batch_index:
            continue
        grouped.setdefault(record["batch_index"], []).append(record)
    grouped[batch_index] = records
    batches: list[dict] = []
    for item in existing.get("batches") or []:
        if isinstance(item, dict) and item.get("batch_index") != batch_index:
            batches.append(item)
    batches.append(batch)
    batches.sort(key=lambda item: item.get("batch_index") if isinstance(item.get("batch_index"), int) else 0)
    all_records = [record for index in sorted(grouped) for record in grouped[index]]  # 批次升序 + 批内原序
    report = {
        "version": 2,
        "source": " / ".join(_sources.label_of(key) or key for key in (config or {}).get("sources", [])) or "Google Scholar",
        "query": query,
        "run_config": config,
        "search_url": batch["search_url"],
        "retrieved_at": retrieved_at,
        "count": len(all_records),
        "scope": "first_page_candidates_only",
        "applied_filters": batch["applied_filters"],
        "deferred_rules": batch["deferred_rules"],
        "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
        "batches": batches,
        "records": all_records,
        "discovery_complete": not bool(search.get("pending_source")),
    }
    if source_status:
        report["source_status"] = source_status
    if search.get("pending_source"):
        report["pending_source"] = search["pending_source"]
    paths = _common.job_paths(output_dir)
    _common.atomic_write_json(paths["candidates_json"], report)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS)
    writer.writeheader()
    for record in all_records:
        writer.writerow(csv_cells(record))
    _common.atomic_write_text(paths["candidates_csv"], buffer.getvalue(), encoding="utf-8-sig")
    return {"count": len(records), "total": len(all_records), "batch_index": batch_index, "files": ["candidates.json", "candidates.csv"]}


def validate_config(config: object) -> None:
    """入口自校验（Python 侧第二防线，读来源注册表；设计 §2.4.1/§7）。"""
    if not isinstance(config, dict):
        raise ValueError("运行配置缺少检索式或包含未接通来源")
    query = config.get("query")
    limit = config.get("limit", 0)
    if not isinstance(query, str) or not query.strip() or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
        raise ValueError("运行配置缺少检索式或包含未接通来源")
    for key in ("publicationYearFrom", "publicationYearTo"):
        value = config.get(key)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or not 1800 <= value <= datetime.now(timezone.utc).year + 1):
            raise ValueError(f"{key} 无效")
    if config.get("publicationYearFrom") and config.get("publicationYearTo") and config["publicationYearFrom"] > config["publicationYearTo"]:
        raise ValueError("发表起始年份不能晚于截止年份")
    batch = config.get("batch")
    if isinstance(batch, dict) and batch.get("size") is not None:
        size = batch["size"]
        if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 10:
            raise ValueError("每批检索数量必须为 1–10")
    sources = config.get("sources")
    if (
        not isinstance(sources, list)
        or not sources
        or any(not isinstance(item, str) or not item for item in sources)
        or len(set(sources)) != len(sources)
        or any(not _sources.is_known(item) for item in sources)
    ):
        raise ValueError("运行配置缺少检索式或包含未接通来源")
    blocked = [item for item in sources if not _sources.is_executable(item)]
    if blocked:
        raise ValueError(_sources.unconnected_message(blocked))
    source_queries = config.get("sourceQueries")
    if source_queries is None:
        source_queries = {}
    if not isinstance(source_queries, dict):
        raise ValueError("分来源检索式必须是对象")
    for key, value in source_queries.items():
        if not _sources.is_known(key):
            raise ValueError(f"分来源检索式包含未知来源：{key}")
        if not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise ValueError(f"{key} 检索式不能为空或超过 2000 字")


def config_fingerprint(config: dict) -> str:
    """Only frozen discovery inputs; old tasks without sourceQueries equal {}."""
    inputs = {key: config.get(key) for key in ("query", "sources", "publicationYearFrom", "publicationYearTo", "limit")}
    inputs["sourceQueries"] = config.get("sourceQueries") or {}
    inputs["batch"] = {"size": batch_size(config), "maxBatches": batch_max(config)}
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def filtered_source_results(search: dict, config: dict, source: str, query: str) -> dict:
    """Normalize metadata and honestly distinguish UI filters from post-filters."""
    low, high = config.get("publicationYearFrom"), config.get("publicationYearTo")
    raw = [item for item in search.get("results", []) if isinstance(item, dict)][:batch_size(config)]
    supplied_applied = search.get("applied_filters")
    if isinstance(supplied_applied, dict):
        supplied_applied = list(supplied_applied)
    if not isinstance(supplied_applied, list):
        supplied_applied = applied_filters(config) if source == "google-scholar" else ["query"]
    applied = [name for name in supplied_applied if isinstance(name, str)]
    if "query" not in applied:
        applied.insert(0, "query")
    deferred = list(dict.fromkeys(deferred_rules(config) + [name for name in search.get("deferred_rules", []) if isinstance(name, str)]))
    requested_years = [name for name, value in (("publicationYearFrom", low), ("publicationYearTo", high)) if value is not None]
    need_post_filter = any(name not in applied for name in requested_years)
    results: list[dict] = []
    unknown, excluded = 0, 0
    for item in raw:
        publication_year = result_year(item)
        if need_post_filter and publication_year is not None and ((low is not None and publication_year < low) or (high is not None and publication_year > high)):
            excluded += 1
            continue
        if need_post_filter and publication_year is None:
            unknown += 1
        # Keep only the published metadata contract, never browser/debug state.
        clean = {key: item.get(key) for key in ("title", "byline", "snippet", "result_url", "fulltext_links", "doi", "year", "authors", "venue") if key in item}
        clean.update(source_key=source, _query=query)
        results.append(clean)
    if need_post_filter:
        if unknown:
            deferred = list(dict.fromkeys(deferred + requested_years + ["unknown_publication_year_review"]))
        else:
            applied = list(dict.fromkeys(applied + requested_years))
            deferred = [name for name in deferred if name not in requested_years]
    return {
        "status": search["status"], "query": query, "url": safe_url(search.get("url")),
        "results": results, "count": len(results), "returned": len(raw),
        "applied_filters": applied, "deferred_rules": deferred,
        "year_filtering": {"mode": "post_filter_known_years" if need_post_filter else "source_ui" if requested_years else "not_requested",
                           "excluded": excluded, "unknown_year_retained": unknown},
    }


def checkpoint_report(output_dir: Path, config: dict, state: dict) -> dict:
    """Persist cumulative results even when a later source needs a human."""
    entries = state.get("sources", {})
    raw, statuses, search_url = [], {}, ""
    for source in config["sources"]:
        entry = entries.get(source) or {"status": "pending", "query": (config.get("sourceQueries") or {}).get(source, config["query"]),
                                      "applied_filters": [], "deferred_rules": deferred_rules(config)}
        raw.extend(entry.get("results") or [])
        search_url = search_url or safe_url(entry.get("url"))
        statuses[source] = {key: value for key, value in entry.items() if key != "results"}
    return write_results(output_dir, config["query"], {"url": search_url, "results": raw,
                         "source_status": statuses, "pending_source": state.get("pending_source")},
                         config, batch_index=state["batch_index"])


def run(config: dict, output_dir: Path, scrape_current: bool = False, *, batch_index: int | None = None, resume: bool = False) -> int:
    output_dir = Path(output_dir)
    validate_config(config)
    checkpoint_path = output_dir / "discovery-state.json"
    state = _common.load_json(checkpoint_path, default=None)
    fingerprint = config_fingerprint(config)
    if checkpoint_path.exists() and not isinstance(state, dict):
        emit("error", message="检索检查点损坏；请新建任务，避免混用已有成果")
        return 1
    if state and state.get("config_fingerprint") != fingerprint:
        emit("error", message="检索配置已更改；请新建任务，不能与已保存的来源结果混用")
        return 1
    index = resolve_batch_index(output_dir, config, requested=batch_index, resume=resume)
    if state and (resume or scrape_current) and batch_index is None:
        index = state["batch_index"]
    if state and state.get("pending_source") and not (resume or scrape_current):
        emit("error", message="当前来源等待人工处理；请在原任务中检查并继续，不要创建新批次")
        return 1
    if state and state.get("pending_source") and index != state["batch_index"]:
        emit("error", message="待处理来源属于原批次；请继续原批次或新建任务")
        return 1
    if index < 1:
        emit("error", message="检索失败：批次号必须为正整数")
        return 1
    max_batches = batch_max(config)
    if index > max_batches:
        emit("error", message=f"检索失败：已达本任务批数上限（{max_batches}）；如需追加批次请新建任务并调整批数上限")
        return 1

    import literature_browser  # noqa: PLC0415 - task/source bound persistent tabs

    if not state or state["batch_index"] != index:
        state = {"version": 1, "config_fingerprint": fingerprint, "batch_index": index, "sources": {},
                 "pending_source": None, "pending_reason": None}
    # Determine this once: only the source that was paused may read its current tab.
    resumed_source = state.get("pending_source") if (resume or scrape_current) and state.get("pending_reason") in ATTENTION_REASONS else None
    output_dir.mkdir(parents=True, exist_ok=True)
    for source in config["sources"]:
        if (state["sources"].get(source) or {}).get("status") in {"ok", "no_results"}:
            continue
        query = (config.get("sourceQueries") or {}).get(source, config["query"])
        emit("stage", stage="search", source=source, message=f"按已确认配置检索 {_sources.label_of(source)}（第 {index} 批）")
        state.update(pending_source=source, pending_reason=None)
        _common.atomic_write_json(checkpoint_path, state)
        search = literature_browser.run(source, query, source == resumed_source, batch_size(config),
                                        config.get("publicationYearFrom"), config.get("publicationYearTo"), job_dir=output_dir)
        if search.get("status") in {"attention", "captcha"}:
            reason = search.get("reason", "verification" if search.get("status") == "captcha" else "results_unrecognized")
            if reason not in ATTENTION_REASONS:
                reason = "results_unrecognized"
            state["sources"][source] = {"status": "attention", "reason": reason, "query": query,
                                         "url": safe_url(search.get("url")), "results": [],
                                         "applied_filters": [], "deferred_rules": deferred_rules(config)}
            state["pending_reason"] = reason
            _common.atomic_write_json(checkpoint_path, state)
            result = checkpoint_report(output_dir, config, state)
            emit("attention", stage="verification", source=source, reason=reason,
                 message=str(search.get("message") or f"{_sources.label_of(source)} 需要人工处理；请在官方页面完成后检查并继续"), **result)
            return 0
        if search.get("status") not in {"ok", "no_results"}:
            # Keep the pending source and earlier completed sources for retry.
            # A technical failure is retried normally, not as a verified page.
            state["pending_reason"] = None
            state["sources"][source] = {"status": "error", "query": query, "url": safe_url(search.get("url")),
                                         "results": [], "applied_filters": [], "deferred_rules": deferred_rules(config)}
            _common.atomic_write_json(checkpoint_path, state)
            result = checkpoint_report(output_dir, config, state)
            emit("error", source=source, message=str(search.get("message") or "检索失败"), **result)
            return 1
        state["sources"][source] = filtered_source_results(search, config, source, query)
        state.update(pending_source=None, pending_reason=None)
        _common.atomic_write_json(checkpoint_path, state)
        # Sources not attempted yet make this a partial artifact after interruption.
        state["pending_source"] = next((key for key in config["sources"] if (state["sources"].get(key) or {}).get("status") not in {"ok", "no_results"}), None)
        _common.atomic_write_json(checkpoint_path, state)
        checkpoint_report(output_dir, config, state)

    emit("stage", stage="save", message="保存各来源候选；跨来源重复留待去重阶段处理")
    result = checkpoint_report(output_dir, config, state)
    if index > 1:
        summary = f"已保存 {result['count']} 条待复核候选（第 {index} 批，累计 {result['total']} 条）"
    else:
        summary = f"已保存 {result['count']} 条待复核候选"
    emit("result", stage="completed", message=summary, **result)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--scrape-current", action="store_true", help="After manual login/verification, read only the pending source's bound tab")
    parser.add_argument("--batch-index", type=int, default=None, help="续批/重试指定批次号；缺省 = 1 + 已有最大批号（新批次）")
    parser.add_argument("--resume", action="store_true", help="断点续跑最近一批：保留已完成来源，仅继续待处理来源")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_config(config)
        return run(config, args.output_dir, args.scrape_current, batch_index=args.batch_index, resume=args.resume)
    except Exception as error:
        emit("error", message=f"检索失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
