#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""文献清单导入：把人工检索得到的题录并入候选池。

为什么需要它
------------
接收研究者从已授权知网、万方、Web of Science、Scopus 等来源导出的题录。
离线保存完整摘要、关键词及原库标识，并保留每个导出批次，供后续筛选与获取全文。

导入的语义
----------
* 导入的条目**与检索来的条目同构**，直接进 ``candidates.json`` 的 ``records``，
  后续的去重 → 全文获取 → 参数提取 → 校验 → 导出五个阶段**零改动**。
* 导入批次 ``batch_index = 0``，每个实际导出另有稳定 import_batch_id；同来源多批累计。
* 同批重复导入幂等；仅强身份相同的记录补齐元数据，保留既有ID、状态和全部来源批次。
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
import copy
import csv
import io
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import importlib
import literature_identity as _identity

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


def _keywords(value):
    values = value if isinstance(value, list) else re.split(r"[;；|]", str(value or ""))
    return list(dict.fromkeys(_clean(v) for v in values if _clean(v)))


def _parsed_item(fields, source_key, *, raw=None):
    """Keep the complete exported evidence, separate from preview snippets."""
    title = _clean(fields.get("title"))
    authors = fields.get("authors") or ""
    if isinstance(authors, list):
        authors = ", ".join(authors)
    year = _year_of(fields.get("year"))
    abstract = str(fields.get("abstract") or "").strip()
    item = {"title": title, "authors": _clean(authors), "year": year,
            "venue": _clean(fields.get("venue")), "doi": _norm_doi(fields.get("doi")),
            "abstract": abstract, "snippet": abstract, "abstract_source": "imported_export" if abstract else "",
            "author_keywords": _keywords(fields.get("author_keywords")),
            "index_keywords": _keywords(fields.get("index_keywords")),
            "result_url": _clean(fields.get("url")), "fulltext_links": [],
            "source_key": source_key, "document_type": _clean(fields.get("document_type")),
            "ut": _clean(fields.get("ut")), "eid": _clean(fields.get("eid")),
            "accession_number": _clean(fields.get("accession_number")),
            "language": _clean(fields.get("language")), "raw_import_fields": raw or fields}
    item["keywords"] = list(dict.fromkeys(item["author_keywords"] + item["index_keywords"]))
    item["source_identifiers"] = _identity.source_ids(item)
    item["byline"] = ". ".join(v for v in (item["authors"], item["venue"], str(year) if year else "") if v)
    return item


def parse_ris(text: str, source_key: str) -> list[dict]:
    """RIS with continuation lines, repeated keywords and native accession IDs."""
    records, current, tag = [], {}, None
    def flush():
        nonlocal current, tag
        if current:
            records.append(current)
        current, tag = {}, None
    for line in text.splitlines():
        match = re.match(r"^([A-Z][A-Z0-9])\s{2}-\s?(.*)$", line)
        if not match:
            if tag and line.strip():
                current[tag][-1] += "\n" + line.strip()
            continue
        tag, value = match.group(1), match.group(2).strip()
        if tag == "TY":
            flush()
            tag = "TY"
        if tag == "ER":
            flush()
        else:
            current.setdefault(tag, []).append(value)
    flush()
    result = []
    for raw in records:
        def first(*keys):
            return next((raw[k][0] for k in keys if raw.get(k)), "")
        fields = {"title": first("TI", "T1"), "authors": raw.get("AU") or raw.get("A1") or [],
                  "year": first("PY", "Y1"), "venue": first("JO", "JF", "T2"),
                  "abstract": first("AB", "N2"), "doi": first("DO"), "url": first("UR", "L1"),
                  "author_keywords": raw.get("KW", []), "document_type": first("TY"),
                  "accession_number": first("AN"), "ut": first("UT"), "eid": first("EID"),
                  "language": first("LA")}
        if fields["title"]:
            result.append(_parsed_item(fields, source_key, raw=raw))
    return result


def parse_bibtex(text: str, source_key: str) -> list[dict]:
    """Read balanced BibTeX values, including nested braces and one-line exports."""
    results = []
    for match in re.finditer(r"@(\w+)\s*\{", text):
        start, depth, quoted, escaped, end = match.end(), 1, False, False, match.end()
        for end in range(start, len(text)):
            char = text[end]
            if escaped:
                escaped = False
                continue
            if char == "\\":
                escaped = True
            elif char == '"':
                quoted = not quoted
            elif not quoted:
                depth += (char == "{") - (char == "}")
                if depth == 0:
                    break
        body, fields = text[start:end], {}
        pos = body.find(",") + 1
        while pos > 0 and pos < len(body):
            field = re.match(r"\s*,?\s*([\w-]+)\s*=\s*", body[pos:])
            if not field:
                break
            key = field.group(1).lower()
            pos += field.end()
            if pos >= len(body):
                break
            opener = body[pos]
            if opener in '{"':
                pos += 1
                value_start, nested, escaped = pos, 1, False
                while pos < len(body):
                    char = body[pos]
                    if escaped:
                        escaped = False
                    elif char == "\\":
                        escaped = True
                    elif opener == "{" and char == "{":
                        nested += 1
                    elif (opener == "{" and char == "}") or (opener == '"' and char == '"'):
                        nested -= 1
                        if nested == 0:
                            break
                    pos += 1
                fields[key] = body[value_start:pos].strip()
                pos += 1
            else:
                value_start = pos
                while pos < len(body) and body[pos] != ",":
                    pos += 1
                fields[key] = body[value_start:pos].strip()
        if not fields.get("title"):
            continue
        values = {"title": fields.get("title"), "authors": fields.get("author", "").replace(" and ", ", "),
                  "year": fields.get("year"), "venue": fields.get("journal") or fields.get("booktitle"),
                  "abstract": fields.get("abstract"), "doi": fields.get("doi"), "url": fields.get("url"),
                  "author_keywords": fields.get("keywords"), "index_keywords": fields.get("keywords-plus"),
                  "ut": fields.get("unique-id") or fields.get("ut"), "eid": fields.get("eid"),
                  "accession_number": fields.get("accession-number"), "document_type": match.group(1),
                  "language": fields.get("language")}
        results.append(_parsed_item(values, source_key, raw=fields))
    return results


def parse_csv(text: str, source_key: str) -> list[dict]:
    """CSV/TSV including WoS and Scopus native export headings."""
    if not text.strip():
        return []
    try:
        dialect = csv.Sniffer().sniff(text[:16384], delimiters=",\t")
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    except csv.Error:
        reader = csv.DictReader(io.StringIO(text), delimiter="\t" if "\t" in text.splitlines()[0] else ",")
    results = []
    for row in reader:
        raw = {str(k).strip(): v for k, v in row.items() if k}
        lowered = {k.casefold().lstrip("\ufeff"): v for k, v in raw.items()}
        def first(*keys):
            return next((lowered[k] for k in keys if lowered.get(k)), "")
        values = {
            "title": first("title", "article title", "ti", "题名", "标题", "文章标题", "篇名", "论文题目"),
            "authors": first("authors", "author", "au", "作者"),
            "venue": first("source title", "publication name", "journal", "venue", "so", "期刊", "来源", "刊名", "出版物"),
            "year": first("year", "publication year", "py", "年份", "发表年份", "出版年"),
            "doi": first("doi", "di", "doi号"), "url": first("url", "link", "链接", "下载地址"),
            "abstract": first("abstract", "ab", "摘要", "summary"),
            "author_keywords": first("author keywords", "keywords", "de", "关键词"),
            "index_keywords": first("index keywords", "keywords plus", "id"),
            "ut": first("ut", "ut (unique wos id)", "wos accession number"), "eid": first("eid"),
            "accession_number": first("accession number", "accession_number", "an", "入藏号"),
            "document_type": first("document type", "document_type", "dt", "文献类型"),
            "language": first("language", "la", "语种")}
        if values["title"]:
            results.append(_parsed_item(values, source_key, raw=raw))
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
    if "," in head or "\t" in head:
        return "csv"
    return "ris"


def parse_list(path: Path, fmt: str | None = None, source_key: str = "cnki") -> list[dict]:
    """解析清单文件 → 候选原始条目。"""
    path = Path(path)
    blob = path.read_bytes()
    if blob.startswith((b"PK\x03\x04", b"\xd0\xcf\x11\xe0")):
        raise ValueError("这是二进制Excel工作簿，请从原库导出CSV/制表符文本/RIS/BibTeX；不会把二进制内容当题录。")
    if blob.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = blob.decode("utf-16")
    else:
        try:
            text = blob.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = blob.decode("gb18030")
    kind = fmt or detect_format(path, text)
    if kind == "bibtex":
        return parse_bibtex(text, source_key)
    if kind == "csv":
        return parse_csv(text, source_key)
    return parse_ris(text, source_key)


# ---------------------------------------------------------------------------
# 并入候选池
# ---------------------------------------------------------------------------

def append_imported(job_dir: Path, items: list[dict], source_key: str, query: str = "", **options) -> dict:
    """Serialize imports so simultaneous uploads cannot overwrite another batch."""
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    lock = job_dir / ".literature-import.lock"
    try:
        handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise ValueError("另一个题录导入尚未结束；请等待。若上次进程异常退出，请先核查导入锁，不会覆盖候选池。") from error
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
        return _append_imported(job_dir, items, source_key, query, **options)
    finally:
        lock.unlink(missing_ok=True)


def _append_imported(job_dir: Path, items: list[dict], source_key: str, query: str = "", *,
                    batch_id: str | None = None, batch_metadata: dict | None = None) -> dict:
    """Accumulate batches, preserving IDs, decisions, complete evidence and provenance.

    Re-importing the same export is idempotent. A changed export never deletes an
    earlier batch. Native IDs/DOI or full bibliography can enrich an existing row;
    conflicting identifiers remain separate for the dedupe/review stage.
    """
    job_dir = Path(job_dir)
    paths = _common.job_paths(job_dir)
    source_items = [copy.deepcopy({**item, "source_key": source_key}) for item in items
                    if isinstance(item, dict) and _clean(item.get("title"))]
    if not source_items:
        raise ValueError("清单里没有可用的题录，不会覆盖候选池。")
    existing = _common.load_json(paths["candidates_json"], default=None) or {}
    records = [copy.deepcopy(r) for r in existing.get("records", existing.get("results", [])) if isinstance(r, dict)]
    query = query or existing.get("query") or ""
    metadata = copy.deepcopy(batch_metadata) if isinstance(batch_metadata, dict) else {}
    content_hash = _identity.digest(source_items)
    import_id = "import-" + _identity.digest([source_key, batch_id or "", query, metadata, content_hash])[:24]
    retrieved_at = datetime.now(timezone.utc).isoformat()
    import literature_search as _search
    key_index, raw_index = {}, {}
    def add_index(position):
        record = records[position]
        if record.get("source_key") != source_key:
            return
        for key in _identity.index_keys(_identity.identity(record)):
            key_index.setdefault(key, set()).add(position)
        for value in record.get("import_fingerprints") or []:
            raw_index[value] = position
    for position in range(len(records)):
        add_index(position)
    prefix = _search.candidate_prefix(source_key, IMPORT_BATCH_INDEX) + "-I"
    existing_ids = {str(r.get("candidate_id") or "") for r in records}
    counter = max([int(v[len(prefix):]) for v in existing_ids if v.startswith(prefix) and v[len(prefix):].isdigit()] or [0])
    added, enriched, batch_candidate_ids = 0, 0, []
    for raw in source_items:
        # Normalize each export record separately: title-only collapse in older
        # browser normalizers must not drop same-title reports with different IDs.
        normalized = _search.normalize_candidates([raw], query, retrieved_at,
            batch_index=IMPORT_BATCH_INDEX, source_key=source_key,
            source_label=_sources.label_of(source_key) or source_key)
        if not normalized:
            continue
        incoming = normalized[0]
        for key in ("title", "abstract", "snippet", "abstract_source", "author_keywords", "index_keywords",
                    "keywords", "source_identifiers", "ut", "eid", "accession_number", "document_type",
                    "language", "raw_import_fields", "authors", "venue", "doi", "year"):
            if key in raw:
                incoming[key] = copy.deepcopy(raw[key])
        incoming["source_identifiers"] = _identity.source_ids(incoming)
        if incoming.get("abstract"):
            incoming["evidence_level"] = "imported_abstract"
        fingerprint = _identity.digest(raw)
        identity = _identity.identity(incoming)
        possible = set()
        for key in _identity.index_keys(identity):
            possible.update(key_index.get(key, ()))
        matches = [p for p in sorted(possible) if _identity.exact_match(identity, _identity.identity(records[p]))]
        position = raw_index.get(fingerprint)
        if position is None and len(matches) == 1:
            position = matches[0]
        if position is None:
            counter += 1
            incoming.update(candidate_id=f"{prefix}{counter:03d}", screening_status="pending_review", imported=True)
            records.append(incoming)
            position = len(records) - 1
            added += 1
        else:
            saved = records[position]
            for key, value in incoming.items():
                if key in {"candidate_id", "screening_status", "screening_reason", "query", "retrieved_at", "batch_index"}:
                    continue
                if value and not saved.get(key):
                    saved[key] = copy.deepcopy(value)
                elif key in {"abstract", "snippet"} and len(str(value or "")) > len(str(saved.get(key) or "")):
                    saved[key] = value
                elif key in {"author_keywords", "index_keywords", "keywords"}:
                    saved[key] = list(dict.fromkeys(_keywords(saved.get(key)) + _keywords(value)))
                elif key == "source_identifiers":
                    saved[key] = {**saved.get(key, {}), **value}
            enriched += 1
        saved = records[position]
        saved["import_fingerprints"] = list(dict.fromkeys((saved.get("import_fingerprints") or []) + [fingerprint]))
        saved["import_batch_ids"] = list(dict.fromkeys((saved.get("import_batch_ids") or []) + [import_id]))
        hit = {"id": import_id, "query": query, "source_key": source_key, **metadata}
        hits = saved.setdefault("hit_batches", [])
        if not any(isinstance(h, dict) and h.get("id") == import_id for h in hits):
            hits.append(hit)
        saved["bibliographic_revision"] = _identity.digest({k: saved.get(k) for k in
            ("title", "abstract", "keywords", "doi", "source_identifiers", "year", "authors")})
        batch_candidate_ids.append(saved["candidate_id"])
        add_index(position)
    batch_candidate_ids = list(dict.fromkeys(batch_candidate_ids))
    batches = [copy.deepcopy(b) for b in existing.get("batches", []) if isinstance(b, dict)]
    if not any(b.get("import_batch_id") == import_id for b in batches):
        batches.append({"batch_index": IMPORT_BATCH_INDEX, "import_batch_id": import_id,
            "external_batch_id": batch_id or "", "content_sha256": content_hash,
            "query": query, "search_url": "", "retrieved_at": retrieved_at,
            "count": len(batch_candidate_ids), "candidate_ids": batch_candidate_ids,
            "applied_filters": ["imported-list"], "deferred_rules": ["inclusion", "exclusion"],
            "status": "complete", "source_key": source_key, "imported": True, "metadata": metadata})
    archive = Path("imports") / (import_id + ".json")
    if not (job_dir / archive).exists():
        _common.atomic_write_json(job_dir / archive, {"version": 1, "source_key": source_key,
            "import_batch_id": import_id, "content_sha256": content_hash, "retrieved_at": retrieved_at,
            "query": query, "metadata": metadata, "records": source_items})
    report = dict(existing)
    report.update(version=existing.get("version", 2), query=query, retrieved_at=retrieved_at,
                  count=len(records), batches=batches, records=records)
    report.setdefault("scope", "imported_candidates_pending_screening")
    _common.atomic_write_json(paths["candidates_json"], report)
    extra_fields = ("abstract", "author_keywords", "index_keywords", "keywords", "ut", "eid",
                    "accession_number", "source_identifiers", "document_type", "import_batch_ids")
    fields = list(dict.fromkeys(list(_search.CSV_FIELDS) + list(extra_fields)))
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    for record in records:
        cells = _search.csv_cells(record)
        for key in extra_fields:
            value = record.get(key, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            cells[key] = _common.safe_csv_cell(str(value or ""))
        writer.writerow(cells)
    _common.atomic_write_text(paths["candidates_csv"], buffer.getvalue(), encoding="utf-8-sig")
    return {"added": added, "matched_existing": enriched, "total": len(records), "import_batch_id": import_id,
            "files": ["candidates.json", "candidates.csv", archive.as_posix()]}


def main() -> int:
    parser = argparse.ArgumentParser(description="导入人工检索的文献清单（RIS/BibTeX/CSV）")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--file", type=Path, required=True, help="清单文件路径")
    parser.add_argument("--source", default="cnki", help="来源 key（cnki/wanfang/web-of-science/scopus）")
    parser.add_argument("--batch-id", default=None, help="可选的原库导出批次编号；内容变化另存版本")
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
    result = append_imported(args.output_dir, items, args.source, str(config.get("query") or ""), batch_id=args.batch_id)
    print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
