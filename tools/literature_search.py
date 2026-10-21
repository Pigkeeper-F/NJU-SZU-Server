"""Run one small Google Scholar discovery batch using the reusable SOC browser script.

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


def candidate_prefix(source_key: str, batch_index: int) -> str:
    """候选 id 前缀：Google Scholar 保持历史行为（GSC / GSC-B<n>），
    其它来源按来源注册表里的 idPrefix 取（PMD / PMC / OAX / EPM …）。"""
    key = str(source_key or "google-scholar")
    if key == "google-scholar":
        return "GSC" if batch_index <= 1 else f"GSC-B{batch_index}"
    registered = _sources.id_prefix_of(key)
    if registered:
        return str(registered)
    return re.sub(r"[^A-Za-z0-9]", "", key).upper()[:4] or "SRC"


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
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:500]
        key = re.sub(r"\W+", "", title).casefold()
        if not title or not key or key in seen:
            continue
        seen.add(key)
        links = []
        for link in item.get("fulltext_links") or []:
            if not isinstance(link, dict):
                continue
            url = safe_url(link.get("url"))
            if url:
                links.append({"label": str(link.get("label") or "")[:100], "url": url})
        item_source_key = str(item.get("source_key") or source_key)
        byline = str(item.get("byline") or "").strip()[:500]
        parsed = parse_byline(byline)
        # 结构化来源（PubMed / OpenAlex / Europe PMC）本身就带 year/authors/venue，
        # 优先用它们；只有 Scholar 的题录片段才需要从 byline 字符串里猜。
        item_year = item.get("year")
        if item_year in (None, ""):
            item_year = parsed["year"]
        item_authors = str(item.get("authors") or "").strip() or parsed["authors"]
        item_venue = str(item.get("venue") or "").strip() or parsed["venue"]
        records.append({
            "candidate_id": f"{candidate_prefix(item_source_key, batch_index)}-{len(records) + 1:03d}",
            "source": _sources.label_of(item_source_key) or source_label,
            "query": query,
            "retrieved_at": retrieved_at,
            "title": title,
            "byline": byline,
            "snippet": str(item.get("snippet") or "").strip()[:2000],
            "result_url": safe_url(item.get("result_url")),
            "fulltext_links": links,
            "screening_status": "pending_review",
            "evidence_level": "search_result_snippet",
            "doi": normalize_doi(item.get("doi")),
            "year": item_year,
            "authors": item_authors,
            "venue": item_venue,
            "source_key": item_source_key,
            "batch_index": batch_index,
        })
    return records


def open_source_keys(sources: list[str]) -> list[str]:
    """给定的来源里，哪些由开放 API 模块负责（PubMed / PMC / OpenAlex / Europe PMC）。"""
    try:
        open_mod = importlib.import_module("literature_search_open")
    except Exception:
        return []
    return [key for key in (sources or []) if open_mod.supports(key)]


def _open_item_to_raw(item: dict, source_key: str) -> dict:
    """开放 API 的结果 → 候选记录构造器认识的原始形状。"""
    authors = str(item.get("authors") or "").strip()
    venue = str(item.get("venue") or "").strip()
    year = item.get("year")
    parts = [part for part in (authors, venue, str(year) if year else "") if part]
    return {
        "title": str(item.get("title") or ""),
        "byline": ". ".join(parts),
        "snippet": str(item.get("abstract") or item.get("snippet") or ""),
        "doi": str(item.get("doi") or ""),
        "year": item.get("year"),
        "authors": authors,
        "venue": venue,
        "result_url": str(item.get("result_url") or ""),
        "fulltext_links": item.get("fulltext_links") or [],
        "source_key": source_key,
    }


def collect_open_results(config: dict, query: str) -> tuple[list[dict], list[dict]]:
    """跑配置里的开放 API 来源。

    返回 ``(原始条目列表, 各源检索元信息)``。单个源失败不拖垮整批：
    失败记进元信息的 error 字段，其余源照常。
    """
    open_mod = importlib.import_module("literature_search_open")
    limit = int(config.get("limit") or 10)
    year_from = config.get("publicationYearFrom")
    year_to = config.get("publicationYearTo")
    items: list[dict] = []
    metas: list[dict] = []
    for key in open_source_keys(list(config.get("sources") or [])):
        try:
            outcome = open_mod.run(key, query, limit, year_from, year_to)
        except Exception as error:  # 单源失败不影响其它源
            metas.append({
                "source_key": key,
                "label": _sources.label_of(key),
                "url": "",
                "count": 0,
                "status": "error",
                "error": str(error)[:300],
            })
            continue
        for raw in outcome.get("results") or []:
            items.append(_open_item_to_raw(raw, key))
        metas.append({
            "source_key": key,
            "label": _sources.label_of(key),
            "url": outcome.get("url") or "",
            "count": int(outcome.get("count") or 0),
            "status": outcome.get("status") or "ok",
        })
    return items, metas


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


def write_results(
    output_dir: Path,
    query: str,
    search: dict,
    config: dict | None = None,
    *,
    batch_index: int = 1,
    source_label: str = "Google Scholar",
    scope: str = "first_page_candidates_only",
    source_metas: list[dict] | None = None,
) -> dict:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    records = normalize_candidates(search.get("results") or [], query, retrieved_at, batch_index=batch_index)
    batch = {
        "batch_index": batch_index,
        "query": query,
        "search_url": safe_url(search.get("url")),
        "retrieved_at": retrieved_at,
        "count": len(records),
        "applied_filters": applied_filters(config),
        "deferred_rules": deferred_rules(config),
        "status": "complete",
    }
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
        "source": source_label,
        "query": query,
        "run_config": config,
        "search_url": batch["search_url"],
        "retrieved_at": retrieved_at,
        "count": len(all_records),
        "scope": scope,
        "applied_filters": batch["applied_filters"],
        "deferred_rules": batch["deferred_rules"],
        "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
        "batches": batches,
        "records": all_records,
    }
    if source_metas:
        report["sources"] = source_metas
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


def run(config: dict, output_dir: Path, scrape_current: bool = False, *, batch_index: int | None = None, resume: bool = False) -> int:
    output_dir = Path(output_dir)
    index = resolve_batch_index(output_dir, config, requested=batch_index, resume=resume)
    if index < 1:
        emit("error", message="检索失败：批次号必须为正整数")
        return 1
    max_batches = batch_max(config)
    if index > max_batches:
        emit("error", message=f"检索失败：已达本任务批数上限（{max_batches}）；如需追加批次请新建任务并调整批数上限")
        return 1

    sources = list(config.get("sources") or ["google-scholar"])
    query = str(config.get("query") or "").strip()
    open_keys = open_source_keys(sources)
    scholar_keys = [key for key in sources if key not in open_keys]

    # 纯开放 API 组合：完全不碰浏览器（不启动持久 Chromium，不需要过验证码）。
    if open_keys and not scholar_keys:
        items, metas = collect_open_results(config, query)
        if not items:
            emit("error", message="检索没有结果：开放来源均未返回候选")
            return 1
        search_payload = {
            "results": items,
            "url": metas[0].get("url") if metas else "",
        }
        labels = [str(meta.get("label") or meta.get("source_key")) for meta in metas]
        write_results(
            output_dir,
            query,
            search_payload,
            config,
            batch_index=index,
            source_label="、".join(labels) or "开放 API 来源",
            scope="open_api_candidates",
            source_metas=metas,
        )
        emit("stage", stage="search", message="开放 API 检索完成：" + "、".join(labels))
        return 0

    sys.path.insert(0, str(SOC_FETCH))
    import browser  # noqa: PLC0415 - reuse SOC discovery implementation
    import google_scholar_search  # noqa: PLC0415

    emit("stage", stage="browser", message="连接 SOC 持久浏览器")
    launched = browser.launch()
    if launched.get("status") not in {"already_running", "launched"}:
        emit("error", message=str(launched.get("message") or launched.get("status") or "浏览器启动失败"))
        return 1
    if scrape_current:
        message = "读取验证后的结果页"
    elif index > 1:
        message = f"按已确认配置进行 Google Scholar 第 {index} 批检索"
    else:
        message = "按已确认配置进行 Google Scholar 首批检索"
    emit("stage", stage="search", message=message)

    limit = batch_size(config)
    raw_results: list[dict] = []
    search_url = ""
    for source in _sources.executable_sources():
        if source["key"] not in config["sources"]:
            continue
        search = google_scholar_search.run(config["query"], scrape_current, limit, config["publicationYearFrom"], config["publicationYearTo"])
        if search.get("status") == "captcha":
            emit("attention", stage="verification", message="Google Scholar 要求人机验证。请在刚打开的浏览器中完成验证，然后点击重新检索；不会自动绕过验证码。")
            return 0
        if search.get("status") not in {"ok", "no_results"}:
            emit("error", message=str(search.get("message") or "检索失败"))
            return 1
        search_url = search_url or safe_url(search.get("url"))
        for item in search.get("results") or []:
            if isinstance(item, dict):
                raw_results.append({**item, "source_key": source["key"]})

    emit("stage", stage="save", message="去重并保存候选清单")
    result = write_results(output_dir, config["query"], {"url": search_url, "results": raw_results}, config, batch_index=index)
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
    parser.add_argument("--scrape-current", action="store_true", help="After manual verification, read the current Scholar page without navigating again")
    parser.add_argument("--batch-index", type=int, default=None, help="续批/重试指定批次号；缺省 = 1 + 已有最大批号（新批次）")
    parser.add_argument("--resume", action="store_true", help="断点续跑：重跑最近一批（同批号整批替换）")
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
