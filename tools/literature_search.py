"""Run one small Google Scholar discovery batch using the reusable SOC browser script.

This stage only collects search-result metadata. Snippets are not abstracts or
full-text evidence, and no paper is automatically included in an analysis.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SOC_FETCH = ROOT / "SOC-database-pipeline-clean" / ".codex" / "skills" / "soc-paper-fetch" / "scripts"


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


def safe_url(value: object) -> str:
    if not isinstance(value, str):
        return ""
    parsed = urlparse(value.strip())
    return value.strip() if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def safe_csv_cell(value: object) -> str:
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def normalize_candidates(raw: list[dict], query: str, retrieved_at: str) -> list[dict]:
    records: list[dict] = []
    seen: set[str] = set()
    for item in raw:
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
        records.append({
            "candidate_id": f"GSC-{len(records) + 1:03d}",
            "source": "Google Scholar",
            "query": query,
            "retrieved_at": retrieved_at,
            "title": title,
            "byline": str(item.get("byline") or "").strip()[:500],
            "snippet": str(item.get("snippet") or "").strip()[:2000],
            "result_url": safe_url(item.get("result_url")),
            "fulltext_links": links,
            "screening_status": "pending_review",
            "evidence_level": "search_result_snippet",
        })
    return records


def write_results(output_dir: Path, query: str, search: dict, config: dict | None = None) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    records = normalize_candidates(search.get("results") or [], query, retrieved_at)
    report = {
        "source": "Google Scholar",
        "query": query,
        "run_config": config,
        "search_url": safe_url(search.get("url")),
        "retrieved_at": retrieved_at,
        "count": len(records),
        "scope": "first_page_candidates_only",
        "applied_filters": ["query"] + (["publicationYearFrom"] if config and config.get("publicationYearFrom") is not None else [])
        + (["publicationYearTo"] if config and config.get("publicationYearTo") is not None else []),
        "deferred_rules": ["geography", "language", "studyTypes", "inclusion", "exclusion", "targetFields"] if config else [],
        "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
        "records": records,
    }
    (output_dir / "candidates.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    fields = ["candidate_id", "source", "query", "retrieved_at", "title", "byline", "snippet", "result_url", "fulltext_links", "screening_status", "evidence_level"]
    with (output_dir / "candidates.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for record in records:
            cells = {**record, "fulltext_links": json.dumps(record["fulltext_links"], ensure_ascii=False)}
            writer.writerow({name: safe_csv_cell(cells[name]) for name in fields})
    return {"count": len(records), "files": ["candidates.json", "candidates.csv"]}


def run(config: dict, output_dir: Path, scrape_current: bool = False) -> int:
    sys.path.insert(0, str(SOC_FETCH))
    import browser  # noqa: PLC0415 - reuse SOC discovery implementation
    import google_scholar_search  # noqa: PLC0415

    emit("stage", stage="browser", message="连接 SOC 持久浏览器")
    launched = browser.launch()
    if launched.get("status") not in {"already_running", "launched"}:
        emit("error", message=str(launched.get("message") or launched.get("status") or "浏览器启动失败"))
        return 1
    emit("stage", stage="search", message="读取验证后的结果页" if scrape_current else "按已确认配置进行 Google Scholar 首批检索")
    search = google_scholar_search.run(config["query"], scrape_current, config["limit"], config["publicationYearFrom"], config["publicationYearTo"])
    if search.get("status") == "captcha":
        emit("attention", stage="verification", message="Google Scholar 要求人机验证。请在刚打开的浏览器中完成验证，然后点击重新检索；不会自动绕过验证码。")
        return 0
    if search.get("status") not in {"ok", "no_results"}:
        emit("error", message=str(search.get("message") or "检索失败"))
        return 1
    emit("stage", stage="save", message="去重并保存候选清单")
    result = write_results(output_dir, config["query"], search, config)
    emit("result", stage="completed", message=f"已保存 {result['count']} 条待复核候选", **result)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--scrape-current", action="store_true", help="After manual verification, read the current Scholar page without navigating again")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if not isinstance(config, dict) or not isinstance(config.get("query"), str) or not config["query"].strip() or not 1 <= config.get("limit", 0) <= 10 or config.get("sources") != ["google-scholar"]:
            raise ValueError("运行配置缺少检索式或包含未接通来源")
        for key in ("publicationYearFrom", "publicationYearTo"):
            value = config.get(key)
            if value is not None and (not isinstance(value, int) or not 1800 <= value <= datetime.now(timezone.utc).year + 1):
                raise ValueError(f"{key} 无效")
        return run(config, args.output_dir, args.scrape_current)
    except Exception as error:
        emit("error", message=f"检索失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
