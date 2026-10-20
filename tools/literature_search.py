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
_source_runner = importlib.import_module("literature_source_runner")

# Explicit in-process unit-test injection only. No HTTP/config/CLI field sets
# this seam; production always invokes the fixed, killable 60-second worker.
injected_source_runner = None


def _run_source(*args, **kwargs):
    runner = injected_source_runner or _source_runner.run_source
    return runner(*args, **kwargs)

emit = _common.emit
safe_url = _common.safe_url
safe_csv_cell = _common.safe_csv_cell

CSV_FIELDS = [
    "candidate_id", "source", "query", "retrieved_at", "title", "byline", "snippet",
    "result_url", "fulltext_links", "screening_status", "evidence_level",
    "doi", "year", "authors", "venue", "source_key", "batch_index", "pmid", "transport",
]
SOURCE_PREFIXES = {"google-scholar": "GSC", "cnki": "CNKI", "web-of-science": "WOS",
                   "wanfang": "WF", "scopus": "SCOPUS", "pubmed": "PMID"}
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
        if len(set(years)) == 1 and not re.search(r"\b(?:19|20)\d{2}\s*[-/]\s*\d{1,4}(?!\d)", second):
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


def metadata_pmid(value: object) -> str:
    """Preserve a reported numeric PMID; a candidate identifier is not a PMID."""
    text = str(value).strip() if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
    return text if re.fullmatch(r"[1-9]\d{0,19}", text) else ""


def metadata_transport(value: object) -> str:
    """Only an adapter label may leave the process, never a URL or token."""
    return value if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value) else ""


def normalize_candidates(
    raw: list[dict],
    query: str,
    retrieved_at: str,
    *,
    batch_index: int = 1,
    source_key: str = "google-scholar",
    source_label: str = "Google Scholar",
    transport: str = "",
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
            "retrieved_at": item.get("_retrieved_at") or retrieved_at,
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
            "pmid": metadata_pmid(item.get("pmid")),
            "transport": metadata_transport(item.get("transport")) or metadata_transport(transport),
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
    record.setdefault("pmid", "")
    record.setdefault("transport", "")
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
    records = normalize_candidates(search.get("results") or [], query, retrieved_at,
                                   batch_index=batch_index, transport=metadata_transport(search.get("transport")))
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
        "status": "partial" if search.get("pending_source") or search.get("deferred_sources") else "complete",
    }
    if source_status:
        batch["source_status"] = source_status
    if search.get("pending_source"):
        batch["pending_source"] = search["pending_source"]
    if "deferred_sources" in search:
        batch["deferred_sources"] = list(search["deferred_sources"])
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
        "scope": ("accessible_pages_until_end" if (config or {}).get("stopMode") == "end" else "paged_candidates_up_to_source_limit")
                 if (config or {}).get("searchMode") == "formal" else "first_page_candidates_only",
        "applied_filters": batch["applied_filters"],
        "deferred_rules": batch["deferred_rules"],
        "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
        "batches": batches,
        "records": all_records,
        "discovery_complete": not bool(search.get("pending_source") or search.get("deferred_sources")),
    }
    if source_status:
        report["source_status"] = source_status
    if search.get("pending_source"):
        report["pending_source"] = search["pending_source"]
    if "deferred_sources" in search:
        report["deferred_sources"] = list(search["deferred_sources"])
    paths = _common.job_paths(output_dir)
    _common.atomic_write_json(paths["candidates_json"], report)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS)
    writer.writeheader()
    for record in all_records:
        writer.writerow(csv_cells(record))
    _common.atomic_write_text(paths["candidates_csv"], buffer.getvalue(), encoding="utf-8-sig")
    result = {"count": len(records), "total": len(all_records), "batch_index": batch_index, "files": ["candidates.json", "candidates.csv"]}
    if "deferred_sources" in search:
        result["deferred_sources"] = list(search["deferred_sources"])
    return result


def validate_config(config: object) -> None:
    """入口自校验（Python 侧第二防线，读来源注册表；设计 §2.4.1/§7）。"""
    if not isinstance(config, dict):
        raise ValueError("运行配置缺少检索式或包含未接通来源")
    query = config.get("query")
    limit = config.get("limit", 0)
    if not isinstance(query, str) or not query.strip() or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
        raise ValueError("运行配置缺少检索式或包含未接通来源")
    mode = config.get("searchMode")
    stop_mode = config.get("stopMode", "count")
    if stop_mode not in ("count", "end"):
        raise ValueError("检索停止方式必须是 count 或 end")
    if stop_mode == "end" and mode != "formal":
        raise ValueError("只有正式检索可以检索到末页")
    if mode is not None:
        if mode not in ("test", "formal"):
            raise ValueError("检索模式必须是 test 或 formal")
        target = config.get("perSourceLimit", None if stop_mode == "end" else 10 if mode == "test" else 100)
        if stop_mode == "end":
            if target is not None:
                raise ValueError("检索到末页不设置候选数量上限")
        elif isinstance(target, bool) or not isinstance(target, int) or not 1 <= target <= 1000:
            raise ValueError("每来源候选上限必须为 1–1000")
        if mode == "test" and (target != 10 or limit != 10):
            raise ValueError("测试运行固定每来源10条")
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
    if config.get("searchMode") is not None:
        inputs["searchMode"] = config["searchMode"]
        inputs["perSourceLimit"] = config.get("perSourceLimit", 10 if config["searchMode"] == "test" else 100)
        if config.get("stopMode") == "end":
            inputs["stopMode"] = "end"
            inputs["perSourceLimit"] = None
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def filtered_source_results(search: dict, config: dict, source: str, query: str, *, full_page: bool = False) -> dict:
    """Normalize metadata and honestly distinguish UI filters from post-filters."""
    low, high = config.get("publicationYearFrom"), config.get("publicationYearTo")
    retrieved_at = datetime.now(timezone.utc).isoformat()
    raw = [item for item in search.get("results", []) if isinstance(item, dict)][:200 if full_page else batch_size(config)]
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
        clean = {key: item.get(key) for key in ("title", "byline", "snippet", "result_url", "fulltext_links", "doi", "year", "authors", "venue", "pmid", "transport") if key in item}
        clean["pmid"] = metadata_pmid(clean.get("pmid"))
        clean["transport"] = metadata_transport(clean.get("transport")) or metadata_transport(search.get("transport"))
        clean.update(source_key=source, _query=query, _retrieved_at=retrieved_at)
        results.append(clean)
    if need_post_filter:
        if unknown:
            deferred = list(dict.fromkeys(deferred + requested_years + ["unknown_publication_year_review"]))
        else:
            applied = list(dict.fromkeys(applied + requested_years))
            deferred = [name for name in deferred if name not in requested_years]
    return {
        "status": search["status"], "query": query, "url": safe_url(search.get("url")),
        "transport": metadata_transport(search.get("transport")),
        "retrieved_at": retrieved_at,
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
                         "source_status": statuses, "pending_source": state.get("pending_source"),
                         "deferred_sources": list(state.get("deferred_sources", []))},
                         config, batch_index=state["batch_index"])


def _prepare_source_schedule(config: dict, state: dict, *, resume: bool, scrape_current: bool,
                             defer_source: str | None) -> tuple[list[str], str | None]:
    """Validate the whole queue before mutating any scheduling state."""
    selected, entries = config["sources"], state.get("sources")
    queue = state.get("deferred_sources", [])
    if (not isinstance(entries, dict) or not isinstance(queue, list)
            or any(not isinstance(source, str) or source not in selected for source in queue)
            or len(set(queue)) != len(queue)
            or any(not isinstance(entries.get(source), dict) for source in queue)):
        raise ValueError("暂缓来源检查点无效；请保留已有成果并核对原任务")
    pending = state.get("pending_source")
    if defer_source is not None:
        if (not resume or not isinstance(defer_source, str) or defer_source not in selected
                or pending != defer_source or not isinstance(entries.get(defer_source), dict)
                or entries[defer_source].get("status") != "attention"):
            raise ValueError("只能在原任务续跑时暂缓当前等待人工处理的已选来源")
    queue = [source for source in queue if entries[source].get("status") not in {"ok", "no_results"}]
    resumed_source = pending if (resume or scrape_current) and state.get("pending_reason") in ATTENTION_REASONS else None
    if defer_source is not None:
        queue = [source for source in queue if source != defer_source] + [defer_source]
        resumed_source = None
    elif (resume or scrape_current) and pending:
        queue = [source for source in queue if source != pending]
    if queue or "deferred_sources" in state or defer_source is not None:
        state["deferred_sources"] = queue
    return [source for source in selected if source not in queue], resumed_source


def _next_pending_source(config: dict, state: dict) -> str | None:
    queue = state.get("deferred_sources", [])
    order = [source for source in config["sources"] if source not in queue] + queue
    return next((source for source in order if (state["sources"].get(source) or {}).get("status") not in {"ok", "no_results"}), None)


def _pause_deferred_sources(output_dir: Path, config: dict, state: dict) -> bool:
    queue = [source for source in state.get("deferred_sources", [])
             if (state["sources"].get(source) or {}).get("status") not in {"ok", "no_results"}]
    if not queue:
        return False
    state["deferred_sources"] = queue
    source = queue[0]
    entry = state["sources"][source]
    reason = entry.get("reason") if entry.get("reason") in ATTENTION_REASONS else "results_unrecognized"
    entry["status"] = "attention"
    state.update(pending_source=source, pending_reason=reason)
    _common.atomic_write_json(output_dir / "discovery-state.json", state)
    result = checkpoint_report(output_dir, config, state)
    previous_message = str(entry.get("message") or "").strip()
    emit("attention", stage="verification", source=source, reason=reason,
         message="其余未暂缓来源已尝试；仍有待补检来源：" + "、".join(_sources.label_of(key) for key in queue)
                 + "。已有成果保留。" + (previous_message + " " if previous_message else "")
                 + "请处理当前来源后检查并继续，或继续暂缓。", **result)
    return True


def _record_keys(row: dict) -> set[str]:
    """Source-local identities, including the legacy normalized-title key."""
    keys = set()
    title = re.sub(r"\W+", "", str(row.get("title") or "").strip()[:500]).casefold()
    if title:
        keys.add("title:" + title)
    doi, pmid = normalize_doi(row.get("doi")), metadata_pmid(row.get("pmid"))
    if doi:
        keys.add("doi:" + doi)
    if pmid:
        keys.add("pmid:" + pmid)
    url = safe_url(row.get("result_url"))
    if url:
        keys.add("url:" + url)
    return keys


def _page_fingerprint(rows: list[dict]) -> str:
    # Ignore transient result-link tracking parameters and result order. A
    # repeated page must not count toward the target after a failed Next click.
    identities = [sorted(key for key in _record_keys(row) if not key.startswith("url:"))
                  or sorted(_record_keys(row)) for row in rows]
    return hashlib.sha256(json.dumps(sorted(identities), ensure_ascii=False).encode("utf-8")).hexdigest()


def run_formal(config: dict, output_dir: Path, scrape_current: bool = False, *,
               batch_index: int | None = None, resume: bool = False, defer_source: str | None = None) -> int:
    """One discovery batch, many pages; commit every page before advancing."""

    output_dir = Path(output_dir)
    validate_config(config)
    to_end = config.get("stopMode") == "end"
    target = None if to_end else config.get("perSourceLimit", 100)
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
        emit("error", message="当前来源尚未完成；请继续原任务，不要创建新批次")
        return 1
    if state and state.get("pending_source") and index != state["batch_index"]:
        emit("error", message="待处理来源属于原批次；请继续原批次或新建任务")
        return 1
    if index < 1 or index > batch_max(config):
        emit("error", message=f"检索批次无效或已达本任务批数上限（{batch_max(config)}）")
        return 1
    if not state or state["batch_index"] != index:
        state = {"version": 2, "config_fingerprint": fingerprint, "batch_index": index,
                 "sources": {}, "pending_source": None, "pending_reason": None}
    try:
        scheduled_sources, resumed_source = _prepare_source_schedule(
            config, state, resume=resume, scrape_current=scrape_current, defer_source=defer_source)
    except ValueError as error:
        emit("error", message=str(error))
        return 1
    output_dir.mkdir(parents=True, exist_ok=True)

    def persist():
        _common.atomic_write_json(checkpoint_path, state)
        return checkpoint_report(output_dir, config, state)

    def stop(entry, source, *, reason="results_unrecognized", message="", error=False):
        # Keep this source's completed pages as well as previous sources.
        error = error and not to_end
        entry.update(status="error" if error else "attention", reason=reason,
                     stop_reason="error" if error else "needs_attention", message=message)
        state.update(pending_source=source, pending_reason=None if error else reason)
        result = persist()
        emit("error" if error else "attention", stage="search" if error else "verification",
             source=source, reason=reason,
             message=message or "无法确认下一检索页；已有候选已保留，请核对官方页面后检查并继续。", **result)
        return 1 if error else 0

    if defer_source is not None:
        state.update(pending_source=_next_pending_source(config, state), pending_reason=None)
        persist()
    for source in scheduled_sources:
        entry = state["sources"].get(source)
        if entry and entry.get("status") in {"ok", "no_results"}:
            continue
        query = (config.get("sourceQueries") or {}).get(source, config["query"])
        if entry is None:
            entry = {"status": "running", "query": query, "url": "", "results": [],
                     "applied_filters": [], "deferred_rules": deferred_rules(config),
                     "pages": [], "next_page": 0, "pages_fetched": 0, "retrieved_count": 0,
                     "count": 0, "total_count": None, "stop_reason": None}
            state["sources"][source] = entry
        entry.update(status="running", stop_reason=None)
        state.update(pending_source=source, pending_reason=None)
        persist()
        seen = set().union(*(_record_keys(row) for row in entry["results"])) if entry["results"] else set()
        while target is None or len(entry["results"]) < target:
            page_index = entry["next_page"]
            if not to_end and page_index >= 1000:
                return stop(entry, source, message="已达单来源1000页保护上限，已有结果保留。请缩小检索范围后新建任务。")
            quantity = f"已保留{len(entry['results'])}条候选，检索到可访问末页" if to_end else f"已保留{len(entry['results'])}/{target}条候选"
            emit("stage", stage="search", source=source,
                 message=f"{_sources.label_of(source)}：正在获取第{page_index + 1}页，{quantity}",
                 deferred_sources=list(state.get("deferred_sources", [])))
            search = _run_source(source, query, source == resumed_source, batch_size(config),
                                            config.get("publicationYearFrom"), config.get("publicationYearTo"),
                                            job_dir=output_dir, page_index=page_index, full_page=True)
            resumed_source = None  # only the paused page may read a manual tab
            if search.get("status") in {"attention", "captcha"}:
                reason = search.get("reason", "verification" if search.get("status") == "captcha" else "results_unrecognized")
                if reason not in ATTENTION_REASONS:
                    reason = "results_unrecognized"
                return stop(entry, source, reason=reason, message=search.get("message") or "当前来源需要人工处理；登录或验证后检查并继续。")
            if search.get("status") not in {"ok", "no_results"}:
                return stop(entry, source, message=search.get("message") or "本页检索失败，已完成页已保留。", error=True)
            previous_transport = entry.get("transport")
            next_transport = metadata_transport(search.get("transport"))
            if source == "pubmed" and entry["pages"] and previous_transport and next_transport and previous_transport != next_transport:
                return stop(entry, source, message="PubMed获取方式发生变化，页大小可能不同；已保留已有候选，请按原方式重试本页。", error=True)
            if search.get("page_index", page_index) != page_index:
                return stop(entry, source, message="返回页码与当前等待页不一致，已有成果已保留，请核对后继续。")
            raw = [row for row in search.get("results", []) if isinstance(row, dict)][:200]
            signature = _page_fingerprint(raw)
            if raw and any(page.get("fingerprint") == signature for page in entry["pages"]):
                return stop(entry, source, message="检测到重复检索页，已停止累加。请核对下一页是否加载成功后检查并继续。")
            if not raw and search.get("status") != "no_results" and search.get("has_next") is not False:
                return stop(entry, source, message="本页没有可核对的题录，无法确认是末页；请核对后检查并继续。")
            page = filtered_source_results(search, config, source, query, full_page=True)
            for row in page["results"]:
                keys = _record_keys(row)
                if not keys or keys & seen:
                    continue
                seen.update(keys)
                entry["results"].append(row)
                if target is not None and len(entry["results"]) >= target:
                    break
            if not entry["pages"]:
                entry["applied_filters"] = page["applied_filters"]
            else:
                entry["applied_filters"] = [name for name in entry["applied_filters"] if name in page["applied_filters"]]
            entry["deferred_rules"] = list(dict.fromkeys(entry["deferred_rules"] + page["deferred_rules"]))
            entry["url"] = page["url"]
            entry["transport"] = page["transport"]
            entry["retrieved_at"] = page["retrieved_at"]
            filtering = entry.setdefault("year_filtering", {"mode": page["year_filtering"]["mode"], "excluded": 0, "unknown_year_retained": 0})
            if filtering["mode"] != page["year_filtering"]["mode"]:
                filtering["mode"] = "mixed_source_and_post_filter"
            for key in ("excluded", "unknown_year_retained"):
                filtering[key] += page["year_filtering"][key]
            total_count = search.get("total_count")
            if isinstance(total_count, int) and not isinstance(total_count, bool) and total_count >= 0:
                entry["total_count"] = total_count
            entry["pages"].append({"page_index": page_index, "fingerprint": signature, "returned": len(raw)})
            entry["next_page"] = page_index + 1
            entry["pages_fetched"] = len(entry["pages"])
            entry["retrieved_count"] += len(raw)
            entry["returned"] = entry["retrieved_count"]
            entry["count"] = len(entry["results"])
            source_limited = search.get("source_limit_reached") is True
            ended = (search.get("has_next") is False or search.get("status") == "no_results") and not source_limited
            if target is not None and entry["count"] >= target:
                entry.update(status="ok", stop_reason="limit_reached")
            elif ended:
                entry.update(status="ok" if entry["count"] else "no_results", stop_reason="exhausted")
            result = persist()
            total_hint = f"，来源报告总命中{entry['total_count']}条" if entry["total_count"] is not None else ""
            quantity = f"已保留{entry['count']}条候选" if to_end else f"已保留{entry['count']}/{target}条候选"
            emit("stage", stage="search", source=source,
                 message=f"{_sources.label_of(source)}：第{page_index + 1}页已保存，{quantity}{total_hint}", **result)
            if entry["status"] in {"ok", "no_results"}:
                break
            if source_limited:
                return stop(entry, source, message=str(search.get("source_limit_message") or "已触及来源可访问结果上限，已有结果已保存；尚不能确认主题文献已全部获取。请核对或缩小检索范围。"))
            if search.get("has_next") is not True:
                return stop(entry, source, message="本页已保存，但无法确认后续页。请核对官方分页控件后检查并继续。")
        state.update(pending_source=_next_pending_source(config, state),
                     pending_reason=None)
        persist()
    if _pause_deferred_sources(output_dir, config, state):
        return 0
    result = persist()
    counts = "；".join((f"{_sources.label_of(source)} {state['sources'][source]['count']}条" if to_end
                       else f"{_sources.label_of(source)} {state['sources'][source]['count']}/{target}条")
                      + ("（已到末页）" if state["sources"][source].get("stop_reason") == "exhausted" else "（已达上限）")
                      for source in config["sources"])
    emit("result", stage="completed", message=("已检索到各来源可访问末页：" if to_end else "正式检索已保存：")
         + counts + "；仍待人工筛选与跨来源去重。", **result)
    return 0


def run(config: dict, output_dir: Path, scrape_current: bool = False, *, batch_index: int | None = None,
        resume: bool = False, defer_source: str | None = None) -> int:
    if config.get("searchMode") == "formal":
        return run_formal(config, output_dir, scrape_current, batch_index=batch_index, resume=resume, defer_source=defer_source)
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

    if not state or state["batch_index"] != index:
        state = {"version": 1, "config_fingerprint": fingerprint, "batch_index": index, "sources": {},
                 "pending_source": None, "pending_reason": None}
    try:
        scheduled_sources, resumed_source = _prepare_source_schedule(
            config, state, resume=resume, scrape_current=scrape_current, defer_source=defer_source)
    except ValueError as error:
        emit("error", message=str(error))
        return 1
    output_dir.mkdir(parents=True, exist_ok=True)
    if defer_source is not None:
        state.update(pending_source=_next_pending_source(config, state), pending_reason=None)
        _common.atomic_write_json(checkpoint_path, state)
        checkpoint_report(output_dir, config, state)
    for source in scheduled_sources:
        if (state["sources"].get(source) or {}).get("status") in {"ok", "no_results"}:
            continue
        query = (config.get("sourceQueries") or {}).get(source, config["query"])
        emit("stage", stage="search", source=source, message=f"按已确认配置检索 {_sources.label_of(source)}（第 {index} 批）",
             deferred_sources=list(state.get("deferred_sources", [])))
        state.update(pending_source=source, pending_reason=None)
        _common.atomic_write_json(checkpoint_path, state)
        search = _run_source(source, query, source == resumed_source, batch_size(config),
                                        config.get("publicationYearFrom"), config.get("publicationYearTo"), job_dir=output_dir)
        if search.get("status") in {"attention", "captcha"}:
            reason = search.get("reason", "verification" if search.get("status") == "captcha" else "results_unrecognized")
            if reason not in ATTENTION_REASONS:
                reason = "results_unrecognized"
            state["sources"][source] = {"status": "attention", "reason": reason, "query": query,
                                         "message": str(search.get("message") or ""),
                                         "url": safe_url(search.get("url")), "results": [],
                                         "transport": metadata_transport(search.get("transport")),
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
                                         "transport": metadata_transport(search.get("transport")),
                                         "results": [], "applied_filters": [], "deferred_rules": deferred_rules(config)}
            _common.atomic_write_json(checkpoint_path, state)
            result = checkpoint_report(output_dir, config, state)
            emit("error", source=source, message=str(search.get("message") or "检索失败"), **result)
            return 1
        state["sources"][source] = filtered_source_results(search, config, source, query)
        state.update(pending_source=None, pending_reason=None)
        _common.atomic_write_json(checkpoint_path, state)
        # Sources not attempted yet make this a partial artifact after interruption.
        state["pending_source"] = _next_pending_source(config, state)
        _common.atomic_write_json(checkpoint_path, state)
        checkpoint_report(output_dir, config, state)

    if _pause_deferred_sources(output_dir, config, state):
        return 0
    emit("stage", stage="save", message="保存各来源候选；跨来源重复留待去重阶段处理",
         deferred_sources=list(state.get("deferred_sources", [])))
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
    parser.add_argument("--defer-source", default=None, help="配合 --resume 暂缓当前等待来源，先继续其他来源")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_config(config)
        return run(config, args.output_dir, args.scrape_current, batch_index=args.batch_index, resume=args.resume, defer_source=args.defer_source)
    except Exception as error:
        emit("error", message=f"检索失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
