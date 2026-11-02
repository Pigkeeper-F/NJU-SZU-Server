"""Bibliographic identity helpers. Similar titles alone never prove one report."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from urllib.parse import parse_qs, urlsplit


def text(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def title_key(value):
    return "".join(c for c in text(value) if c.isalnum())


def doi_key(value):
    return re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)", "", text(value))


def source_ids(record):
    result = {str(k): text(v) for k, v in (record.get("source_identifiers") or {}).items()
              if v} if isinstance(record.get("source_identifiers"), dict) else {}
    for key, namespace in (("ut", "web-of-science"), ("eid", "scopus"),
                           ("pmid", "pubmed"), ("cnki_id", "cnki")):
        if record.get(key):
            result[namespace] = text(record[key])
    source = str(record.get("source_key") or "")
    if record.get("accession_number") and source and source not in result:
        result[source] = text(record["accession_number"])
    try:
        url = urlsplit(str(record.get("source_url") or record.get("result_url") or ""))
        query = {k.casefold(): v for k, v in parse_qs(url.query).items()}
        if source == "scopus" and query.get("eid") and "scopus" not in result:
            result["scopus"] = text(query["eid"][0])
        if source == "cnki" and url.hostname == "kns.cnki.net" and "cnki" not in result:
            parts = [query.get(k, []) for k in ("dbcode", "dbname", "filename")]
            if all(len(v) == 1 and re.fullmatch(r"[\w.-]{1,100}", v[0]) for v in parts):
                result["cnki"] = ":".join(text(v[0]) for v in parts)
    except (ValueError, TypeError):
        pass
    return result


def identity(record):
    authors = record.get("authors") or ""
    if isinstance(authors, list):
        authors = ";".join(str(a.get("name") or "") if isinstance(a, dict) else str(a) for a in authors)
    year = str(record.get("year") or "")
    return {"doi": doi_key(record.get("doi")), "source_ids": source_ids(record),
            "title": title_key(record.get("title")),
            "year": year if re.fullmatch(r"\d{4}", year) else "",
            "authors": title_key(authors), "document_type": text(record.get("document_type"))}


def conflicts(left, right):
    if left.get("doi") and right.get("doi") and left["doi"] != right["doi"]:
        return True
    a, b = left.get("source_ids", {}), right.get("source_ids", {})
    return any(a[k] != b[k] for k in a.keys() & b.keys())


def exact_match(left, right):
    if conflicts(left, right):
        return ""
    if left.get("doi") and left["doi"] == right.get("doi"):
        return "doi_exact"
    a, b = left.get("source_ids", {}), right.get("source_ids", {})
    if any(a[k] == b[k] for k in a.keys() & b.keys()):
        return "source_id_exact"
    # Identical topic titles may describe a thesis, conference paper and article.
    if left.get("document_type") and right.get("document_type") and left["document_type"] != right["document_type"]:
        return ""
    if (len(left.get("title", "")) >= 8 and left["title"] == right.get("title")
        and left.get("year") and left["year"] == right.get("year")
        and len(left.get("authors", "")) >= 2 and left["authors"] == right.get("authors")):
        return "title_year_authors_exact"
    return ""


def index_keys(value):
    result = []
    if value.get("doi"):
        result.append("doi:" + value["doi"])
    result.extend("id:" + k + ":" + v for k, v in sorted(value.get("source_ids", {}).items()))
    if len(value.get("title", "")) >= 8 and value.get("year") and value.get("authors"):
        result.append("bibliography:" + digest([value["title"], value["year"], value["authors"]]))
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
