#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""文献清单导入：把人工检索得到的题录并入候选池。

为什么需要它
------------
知网 / 万方 / Web of Science / Scopus 这几个源**程序化直连一定会被拦**（登录态、
人机验证、订阅授权）。本工具**不绕过验证码、不代持订阅凭据**（设计底线），
所以唯一诚实的路径是：**用你自己的账号在源站检索，导出题录清单，再导入这里**。
注册表里给这四个源登记了 ``importFormats: [ris, bibtex, csv]``，本模块把这条路径做实。

导入的语义
----------
* 导入的条目**与检索来的条目同构**，直接进 ``candidates.json`` 的 ``records``，
  后续的去重 → 全文获取 → 参数提取 → 校验 → 导出五个阶段**零改动**。
* 导入批次 ``batch_index = 0``（与检索批次 1/2/… 区分开），来源前缀取注册表的 idPrefix
  （CNK / WFX / WOS / SCP），便于回溯"这条是哪来的"。
* 同批重复导入 = **整批替换**（与检索重跑同语义），不会越导越多。
* 导入的条目一律 ``screening_status = pending_review``：**不自动判"不相关"**，
  是否纳入由人工初筛决定（与检索来的条目一样）。

用法
----
    python tools/literature_import.py --config <run_config.json> --output-dir <作业目录> \\
        --file <清单路径> [--source cnki]

也可以直接当库用（离线解析，不落盘）::

    from literature_import import parse_list
    items = parse_list(Path("refs.ris"), "ris")
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import importlib

_common = importlib.import_module("literature-common")
_sources = importlib.import_module("literature_sources")

#: 导入批次固定用 0（检索批次是 1/2/…）
IMPORT_BATCH_INDEX = 0


# ---------------------------------------------------------------------------
# 解析：三种清单格式
# ---------------------------------------------------------------------------

def _clean(value: object) -> str:
    if value is None:
        return ""
    text = str(value).replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def _norm_doi(value: object) -> str:
    text = _clean(value)
    text = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", text, flags=re.I)
    text = re.sub(r"^doi:\s*", "", text, flags=re.I)
    return text.strip().lower()


def _year_of(text: object) -> int | None:
    match = re.search(r"\b(1[89]\d{2}|20\d{2})\b", _clean(text))
    return int(match.group(1)) if match else None


def parse_ris(text: str, source_key: str) -> list[dict]:
    """解析 RIS（知网/万方/WoS/Scopus/EndNote 通用导出格式）。"""
    items: list[dict] = []
    current: dict = {}
    tag = None

    def flush() -> None:
        nonlocal current
        if current:
            items.append(current)
        current = {}

    for raw in text.splitlines():
        line = raw.rstrip()
        match = re.match(r"^([A-Z][A-Z0-9])\s{2}-\s?(.*)$", line)
        if not match:
            if not line.strip():
                flush()
            continue
        tag, value = match.group(1), match.group(2).strip()
        if tag == "TY":
            flush()
            current = {"_type": value}
            continue
        if not current:
            continue
        if tag == "ER":
            flush()
            continue
        if tag in ("AU", "A1"):
            current.setdefault("authors", []).append(value)
        elif tag == "TI" or tag == "T1":
            current["title"] = value
        elif tag == "AB" or tag == "N2":
            current.setdefault("abstract", value)
        elif tag == "JO" or tag == "JF" or tag == "T2":
            current.setdefault("venue", value)
        elif tag == "PY" or tag == "Y1":
            current.setdefault("year_text", value)
        elif tag == "DO":
            current["doi"] = value
        elif tag == "UR" or tag == "L1":
            current.setdefault("url", value)
        elif tag == "PB" or tag == "CY":
            current.setdefault("publisher", value)
    flush()

    results = []
    for item in items:
        title = _clean(item.get("title"))
        if not title:
            continue
        authors = item.get("authors") or []
        year = _year_of(item.get("year_text"))
        results.append({
            "title": title,
            "byline": ". ".join([_clean(", ".join(authors)), _clean(item.get("venue")),
                                 str(year) if year else ""]),
            "snippet": _clean(item.get("abstract")),
            "doi": _norm_doi(item.get("doi")),
            "year": year,
            "authors": _clean(", ".join(authors)),
            "venue": _clean(item.get("venue")),
            "result_url": _clean(item.get("url")),
            "fulltext_links": [],
            "source_key": source_key,
        })
    return results


def parse_bibtex(text: str, source_key: str) -> list[dict]:
    """解析 BibTeX（常见字段：title/author/year/journal/abstract/doi/url）。"""
    entries = re.findall(r"@\w+\s*\{.*?\n\}", text, flags=re.S)
    results = []
    for entry in entries:
        fields: dict[str, str] = {}
        body = entry[entry.find("{") + 1:entry.rfind("}")]
        for key, value in re.findall(r"(\w+)\s*=\s*[{\"](.*?)[}\"]\s*,?\s*(?=\n\s*\w+\s*=|\s*$)",
                                     body, flags=re.S):
            fields[key.lower()] = _clean(value)
        title = _clean(fields.get("title"))
        if not title:
            continue
        authors = _clean(fields.get("author")).replace(" and ", ", ")
        year = _year_of(fields.get("year"))
        results.append({
            "title": title,
            "byline": ". ".join([authors, _clean(fields.get("journal")),
                                 str(year) if year else ""]),
            "snippet": _clean(fields.get("abstract")),
            "doi": _norm_doi(fields.get("doi")),
            "year": year,
            "authors": authors,
            "venue": _clean(fields.get("journal") or fields.get("booktitle")),
            "result_url": _clean(fields.get("url")),
            "fulltext_links": [],
            "source_key": source_key,
        })
    return results


def parse_csv(text: str, source_key: str) -> list[dict]:
    """解析 CSV（表头需含 title/标题 这类列名；字段按常见名匹配）。"""
    reader = csv.DictReader(io.StringIO(text))
    results = []
    for row in reader:
        lowered = {str(k).strip().lower(): v for k, v in row.items() if k}
        title = ""
        for key in ("title", "题名", "标题", "文章标题", "篇名", "论文题目"):
            if lowered.get(key):
                title = _clean(lowered[key])
                break
        if not title:
            continue
        authors = ""
        for key in ("authors", "author", "作者"):
            if lowered.get(key):
                authors = _clean(lowered[key])
                break
        venue = ""
        for key in ("journal", "venue", "期刊", "来源", "刊名", "出版物"):
            if lowered.get(key):
                venue = _clean(lowered[key])
                break
        year = None
        for key in ("year", "年份", "发表年份", "出版年"):
            if lowered.get(key):
                year = _year_of(lowered[key])
                break
        doi = ""
        for key in ("doi", "DOI", "doi号"):
            if lowered.get(key):
                doi = _norm_doi(lowered[key])
                break
        url = ""
        for key in ("url", "link", "链接", "下载地址"):
            if lowered.get(key):
                url = _clean(lowered[key])
                break
        abstract = ""
        for key in ("abstract", "摘要", "summary"):
            if lowered.get(key):
                abstract = _clean(lowered[key])
                break
        results.append({
            "title": title,
            "byline": ". ".join([authors, venue, str(year) if year else ""]),
            "snippet": abstract,
            "doi": doi,
            "year": year,
            "authors": authors,
            "venue": venue,
            "result_url": url,
            "fulltext_links": [],
            "source_key": source_key,
        })
    return results


def detect_format(path: Path, text: str) -> str:
    """按扩展名猜格式，猜不出就看内容（RIS 行首是 `TY  - `，BibTeX 有 `@`）。"""
    suffix = path.suffix.lower()
    if suffix == ".ris":
        return "ris"
    if suffix in (".bib", ".bibtex"):
        return "bibtex"
    if suffix == ".csv":
        return "csv"
    head = text.lstrip()[:400]
    if re.search(r"^@\w+\s*\{", head, flags=re.M):
        return "bibtex"
    if re.search(r"^TY\s{2}-", head, flags=re.M):
        return "ris"
    if "," in head:
        return "csv"
    return "ris"


def parse_list(path: Path, fmt: str | None = None, source_key: str = "cnki") -> list[dict]:
    """解析清单文件 → 候选原始条目。"""
    path = Path(path)
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    kind = fmt or detect_format(path, text)
    if kind == "bibtex":
        return parse_bibtex(text, source_key)
    if kind == "csv":
        return parse_csv(text, source_key)
    return parse_ris(text, source_key)


# ---------------------------------------------------------------------------
# 并入候选池
# ---------------------------------------------------------------------------

def append_imported(job_dir: Path, items: list[dict], source_key: str, query: str = "") -> dict:
    """把导入条目并入作业的 candidates.json（整批替换，batch_index=0）。

    返回 ``{"added": n, "total": m, "files": [...]}``。
    """
    job_dir = Path(job_dir)
    paths = _common.job_paths(job_dir)
    existing = _common.load_json(paths["candidates_json"], default=None) or {}
    records = [r for r in (existing.get("records") or []) if isinstance(r, dict)]
    kept = []
    for record in records:
        if record.get("batch_index") == IMPORT_BATCH_INDEX:
            continue          # 同批替换
        kept.append(record)

    retrieved_at = datetime.now(timezone.utc).isoformat()
    import literature_search as _search
    new_records = _search.normalize_candidates(
        items, query or (existing.get("query") or ""), retrieved_at,
        batch_index=IMPORT_BATCH_INDEX, source_key=source_key,
        source_label=_sources.label_of(source_key) or source_key,
    )
    # 导入的前缀按来源取（如 CNK/WFX），与检索批次不撞
    for index, record in enumerate(new_records, 1):
        record["candidate_id"] = "%s-I%03d" % (_search.candidate_prefix(source_key, IMPORT_BATCH_INDEX), index)
        record["screening_status"] = "pending_review"
        record["imported"] = True

    all_records = kept + new_records
    batch = {
        "batch_index": IMPORT_BATCH_INDEX,
        "query": query or (existing.get("query") or ""),
        "search_url": "",
        "retrieved_at": retrieved_at,
        "count": len(new_records),
        "applied_filters": ["imported-list"],
        "deferred_rules": ["geography", "language", "studyTypes", "inclusion", "exclusion", "targetFields"],
        "status": "complete",
        "source_key": source_key,
        "imported": True,
    }
    batches = [b for b in (existing.get("batches") or [])
               if isinstance(b, dict) and b.get("batch_index") != IMPORT_BATCH_INDEX]
    batches.append(batch)
    batches.sort(key=lambda item: item.get("batch_index") if isinstance(item.get("batch_index"), int) else 0)

    report = dict(existing)
    report.update({
        "version": existing.get("version", 2),
        "query": query or existing.get("query") or "",
        "retrieved_at": retrieved_at,
        "count": len(all_records),
        "batches": batches,
        "records": all_records,
    })
    report.setdefault("scope", "first_page_candidates_only")
    report.setdefault("run_config", existing.get("run_config"))
    _common.atomic_write_json(paths["candidates_json"], report)

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=_search.CSV_FIELDS)
    writer.writeheader()
    for record in all_records:
        writer.writerow(_search.csv_cells(record))
    _common.atomic_write_text(paths["candidates_csv"], buffer.getvalue(), encoding="utf-8-sig")
    return {"added": len(new_records), "total": len(all_records), "files": ["candidates.json", "candidates.csv"]}


def main() -> int:
    parser = argparse.ArgumentParser(description="导入人工检索的文献清单（RIS/BibTeX/CSV）")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--file", type=Path, required=True, help="清单文件路径")
    parser.add_argument("--source", default="cnki", help="来源 key（cnki/wanfang/web-of-science/scopus）")
    parser.add_argument("--format", default=None, choices=["ris", "bibtex", "csv"])
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8")) if args.config.is_file() else {}
    if not args.file.is_file():
        print(json.dumps({"status": "error", "message": "清单文件不存在：" + str(args.file)}, ensure_ascii=False))
        return 1
    try:
        items = parse_list(args.file, args.format, args.source)
    except Exception as error:
        print(json.dumps({"status": "error", "message": "解析失败：" + str(error)}, ensure_ascii=False))
        return 1
    if not items:
        print(json.dumps({"status": "no_results", "message": "清单里没有解析出可用的题录"}, ensure_ascii=False))
        return 1
    result = append_imported(args.output_dir, items, args.source, str(config.get("query") or ""))
    print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
