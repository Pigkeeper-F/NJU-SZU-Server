#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""以文献找文献：从一篇种子文献向外扩（参考文献 / 被引 / 相似）。

为什么需要它
------------
关键词检索擅长「按主题捞」，但不擅长「从一个已知关键点把整个小领域捞全」。
综述、方法学奠基作、或导师指定的那篇论文，往往是最好的检索起点：
它的参考文献是上游脉络，被引文献是后续发展，相似文献是同一问题的其它做法。

本模块只做**候选发现**：返回的仍是题录，不判定相关性、不下载全文，
条目并入 candidates.json 后与检索来的条目完全同构，交给人工初筛与后续阶段。

来源与口径
----------
* OpenAlex：``referenced_works``（参考文献）、``cites:W...``（被引）、
  ``related_works``（相似）。只取官方 API 明示的关系，不猜测。
* Semantic Scholar：``/references``、``/citations``、``/recommendations``。
  OpenAlex 失败或该关系为空时作为兜底；相似文献会补充 S2 推荐，按 DOI/标题去重。
* 种子标识支持 DOI、PMID、PMCID、OpenAlex Work ID、Semantic Scholar paperId、
  以及包含这些标识的论文 URL。纯标题/作者文本会先在 OpenAlex 做一次检索：
  只有标题高度吻合才自动定位，否则返回候选项让人确认——不替人猜。

诚实性
------
* 扩展结果带 ``seed_relation`` / ``seed_relations`` / ``seed_key`` 字段，
  可回溯「这条是从哪篇、通过哪种关系找到的」。
* 不把「扩展不到」说成「没有」：某个关系取不到时，结果里如实记录 warning。
* 不绕过订阅：只有来源给出的开放获取链接才写进 ``fulltext_links``。

用法
----
    python tools/literature_expand.py --output-dir <作业目录> \\
        --seed 10.1016/j.cej.2025.164701 \\
        --relations reference,citing,similar --limit 50 --append
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_common = importlib.import_module("literature-common")
_open = importlib.import_module("literature_search_open")
_search = importlib.import_module("literature_search")
_sources = importlib.import_module("literature_sources")

OPENALEX_WORK = "https://api.openalex.org/works"
SEMANTIC_SCHOLAR_PAPER = "https://api.semanticscholar.org/graph/v1/paper"

#: 扩展批次用 -1：与检索批次 1/2/…、导入批次 0 都分开，且不会被重跑检索/导入误删。
EXPANSION_BATCH_INDEX = -1

RELATION_ORDER = ("reference", "citing", "similar")
RELATION_PREFIX = {"reference": "REF", "citing": "CIT", "similar": "SIM"}

S2_FIELDS = "title,abstract,authors,year,venue,externalIds,openAccessPdf,url,publicationDate"

_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.I)
_PMCID_RE = re.compile(r"PMC[1-9]\d*", re.I)
_OPENALEX_RE = re.compile(r"W[1-9]\d*", re.I)
_S2_RE = re.compile(r"[0-9a-f]{40}", re.I)


class ExpandError(RuntimeError):
    """种子定位或关系抓取失败；``kind`` 供调用方区分类别。"""

    def __init__(self, message: str, *, kind: str = "error") -> None:
        super().__init__(message)
        self.kind = kind


def _short(value: object, limit: int = 240) -> str:
    return " ".join(str(value or "").split())[:limit]


def _error_text(error: object) -> str:
    """把上游错误压成一句人话；429 不把整段 JSON 灌进界面。"""
    text = str(error or "")
    lowered = text.lower()
    if "429" in text or "rate limit" in lowered or "insufficient budget" in lowered:
        return "来源限流（HTTP 429，免费池预算不足或请求过密）"
    if "404" in text:
        return "来源未收录该关系（HTTP 404）"
    return _short(text, 160)


def _norm_doi(value: object) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text, flags=re.I)
    text = re.sub(r"^doi:\s*", "", text, flags=re.I)
    return text.strip().lower()


def _title_key(value: object) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", str(value or "").lower())


def _record_key(record: dict) -> str:
    doi = _norm_doi(record.get("doi"))
    if doi:
        return "doi:" + doi
    key = _title_key(record.get("title"))
    return "title:" + key if key else ""


def _strip_openalex_id(value: object) -> str:
    text = str(value or "").strip()
    match = _OPENALEX_RE.search(text)
    return "W" + match.group(0)[1:] if match else ""


def _request_json(url: str, params: dict | None = None, *, headers: dict | None = None,
                  attempts: int = 3) -> dict:
    """GET → JSON，429/5xx 退避重试；其它错误直接抛出可读原因。"""
    last_error: Exception | None = None
    for attempt in range(max(1, attempts)):
        try:
            status, body = _open.http_get(url, params or {}, headers=headers)
            if status >= 400:
                raise ExpandError(f"HTTP {status}：{_short(body)}", kind="http")
            try:
                payload = json.loads(body)
            except ValueError as error:
                raise ExpandError(f"响应不是合法 JSON：{_short(body)}", kind="parse") from error
            if isinstance(payload, dict) and payload.get("error"):
                raise ExpandError(_short(payload.get("message") or payload.get("error")), kind="api")
            return payload
        except Exception as error:  # noqa: BLE001 - 统一转成可读错误
            last_error = error
            kind = getattr(error, "kind", "")
            retryable = kind in {"rate_limited", "network"} or "HTTP 5" in str(error)
            if attempt >= attempts - 1 or not retryable:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise last_error or ExpandError("请求失败")


def _openalex_params(extra: dict | None = None) -> dict:
    params = dict(extra or {})
    api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if api_key:
        params["api_key"] = api_key
    return params


def _s2_headers() -> dict | None:
    api_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
    return {"x-api-key": api_key} if api_key else None


# ---------------------------------------------------------------------------
# 种子定位
# ---------------------------------------------------------------------------

def classify_seed(text: str) -> str:
    """判断输入是 DOI / PMID / PMCID / OpenAlex ID / S2 paperId / 自由文本。"""
    value = str(text or "").strip()
    if not value:
        return "empty"
    lowered = value.lower()
    if _DOI_RE.search(value) or "doi.org/" in lowered:
        return "doi"
    if _PMCID_RE.fullmatch(value) or re.search(r"pmc\.ncbi\.nlm\.nih\.gov/articles/(PMC\d+)", value, re.I):
        return "pmcid"
    if re.match(r"^(?:pmid[:\s]*)?[1-9]\d{0,8}$", value, re.I) or "pubmed.ncbi.nlm.nih.gov/" in lowered:
        return "pmid"
    if _OPENALEX_RE.fullmatch(value) or "openalex.org/" in lowered:
        return "openalex"
    if _S2_RE.fullmatch(value) or lowered.startswith("s2:"):
        return "s2"
    return "text"


def _identifier_value(text: str, kind: str) -> str:
    value = str(text or "").strip()
    if kind == "doi":
        match = _DOI_RE.search(value)
        return _norm_doi(match.group(0)) if match else ""
    if kind == "pmid":
        match = re.search(r"(?:pmid[:\s]*)?([1-9]\d{0,8})", value, re.I)
        return match.group(1) if match else ""
    if kind == "pmcid":
        match = _PMCID_RE.search(value)
        return match.group(0).upper() if match else ""
    if kind == "openalex":
        return _strip_openalex_id(value)
    if kind == "s2":
        match = _S2_RE.search(value)
        return match.group(0) if match else ""
    return ""


def _openalex_seed_path(kind: str, value: str) -> str:
    if kind == "doi":
        return f"{OPENALEX_WORK}/https://doi.org/{urllib.parse.quote(value, safe='/:')}"
    if kind == "pmid":
        return f"{OPENALEX_WORK}/pmid:{value}"
    if kind == "pmcid":
        return f"{OPENALEX_WORK}/pmcid:{value}"
    if kind == "openalex":
        return f"{OPENALEX_WORK}/{value}"
    raise ExpandError("该标识不能直接用于 OpenAlex 定位", kind="identifier")


def _seed_from_openalex_work(work: dict, *, input_text: str) -> dict:
    if not isinstance(work, dict) or not work.get("id"):
        raise ExpandError("OpenAlex 没有返回可用的种子记录", kind="not_found")
    location = work.get("primary_location") if isinstance(work.get("primary_location"), dict) else {}
    source = location.get("source") if isinstance(location.get("source"), dict) else {}
    authors = []
    for authorship in work.get("authorships") or []:
        if not isinstance(authorship, dict):
            continue
        name = str(authorship.get("raw_author_name") or "").strip()
        if not name:
            author = authorship.get("author") if isinstance(authorship.get("author"), dict) else {}
            name = str(author.get("display_name") or "").strip()
        if name:
            authors.append(name)
    identifiers = work.get("ids") if isinstance(work.get("ids"), dict) else {}
    return {
        "input": input_text,
        "source": "openalex",
        "seed_id": _strip_openalex_id(work.get("id")),
        "openalex_id": _strip_openalex_id(work.get("id")),
        "paper_id": "",
        "doi": _norm_doi(work.get("doi")),
        "pmid": str(identifiers.get("pmid") or "").rstrip("/").rsplit("/", 1)[-1],
        "pmcid": str(identifiers.get("pmcid") or "").rstrip("/").rsplit("/", 1)[-1],
        "title": str(work.get("title") or work.get("display_name") or "").strip(),
        "year": work.get("publication_year") if isinstance(work.get("publication_year"), int) else None,
        "venue": str(source.get("display_name") or "").strip(),
        "authors": ", ".join(authors),
        "url": str(work.get("doi") or work.get("id") or ""),
        "cited_by_count": work.get("cited_by_count") if isinstance(work.get("cited_by_count"), int) else None,
        "referenced_works": [item for item in work.get("referenced_works") or [] if isinstance(item, str)],
        "related_works": [item for item in work.get("related_works") or [] if isinstance(item, str)],
    }


def _seed_from_s2_paper(paper: dict, *, input_text: str) -> dict:
    if not isinstance(paper, dict) or not (paper.get("paperId") or paper.get("title")):
        raise ExpandError("Semantic Scholar 没有返回可用的种子记录", kind="not_found")
    external = paper.get("externalIds") if isinstance(paper.get("externalIds"), dict) else {}
    authors = ", ".join(str((item or {}).get("name") or "") for item in (paper.get("authors") or []))
    return {
        "input": input_text,
        "source": "semantic-scholar",
        "seed_id": str(paper.get("paperId") or ""),
        "openalex_id": "",
        "paper_id": str(paper.get("paperId") or ""),
        "doi": _norm_doi(external.get("DOI")),
        "pmid": str(external.get("PubMed") or ""),
        "pmcid": str(external.get("PubMedCentral") or ""),
        "title": str(paper.get("title") or "").strip(),
        "year": paper.get("year") if isinstance(paper.get("year"), int) else None,
        "venue": str(paper.get("venue") or "").strip(),
        "authors": authors,
        "url": str(paper.get("url") or ""),
        "cited_by_count": paper.get("citationCount") if isinstance(paper.get("citationCount"), int) else None,
        "referenced_works": [],
        "related_works": [],
    }


def resolve_seed(text: str) -> dict:
    """把标识解析成种子文献；OpenAlex 优先，S2 兜底。"""
    value = str(text or "").strip()
    kind = classify_seed(value)
    if kind == "empty":
        raise ExpandError("请先填写种子文献（DOI / PMID / 论文链接）", kind="identifier")
    errors: list[str] = []
    if kind in {"doi", "pmid", "pmcid", "openalex"}:
        identifier = _identifier_value(value, kind)
        try:
            payload = _request_json(_openalex_seed_path(kind, identifier), _openalex_params())
            return _seed_from_openalex_work(payload, input_text=value)
        except Exception as error:  # OpenAlex 失败再试 S2
            errors.append(f"OpenAlex：{_error_text(error)}")
    s2_id = {
        "doi": f"DOI:{_identifier_value(value, 'doi')}",
        "pmid": f"PMID:{_identifier_value(value, 'pmid')}",
        "pmcid": f"PMCID:{_identifier_value(value, 'pmcid')}",
        "s2": f"paper:{_identifier_value(value, 's2')}",
    }.get(kind)
    if s2_id:
        try:
            payload = _request_json(
                f"{SEMANTIC_SCHOLAR_PAPER}/{urllib.parse.quote(s2_id, safe=':')}",
                {"fields": f"{S2_FIELDS},referenceCount,citationCount"},
                headers=_s2_headers(),
            )
            seed = _seed_from_s2_paper(payload, input_text=value)
            # S2 给了 DOI 就再补一次 OpenAlex 的关系字段（参考文献/相似）。
            if seed.get("doi") and not seed.get("openalex_id"):
                try:
                    work = _request_json(
                        f"{OPENALEX_WORK}/https://doi.org/{urllib.parse.quote(seed['doi'], safe='/:')}",
                        _openalex_params(),
                    )
                    richer = _seed_from_openalex_work(work, input_text=value)
                    for key in ("openalex_id", "referenced_works", "related_works", "pmcid"):
                        if richer.get(key):
                            seed[key] = richer[key]
                    seed["seed_id"] = seed.get("seed_id") or richer.get("seed_id")
                except Exception as error:  # 补不到不影响 S2 种子本身
                    errors.append(f"OpenAlex 关系补充：{_error_text(error)}")
            return seed
        except Exception as error:
            errors.append(f"Semantic Scholar：{_error_text(error)}")
    raise ExpandError("无法定位种子文献；" + "；".join(errors), kind="not_found")


def search_seed_candidates(text: str, limit: int = 5) -> list[dict]:
    """自由文本 → OpenAlex 候选（供人确认，不自动认定）。"""
    payload = _request_json(OPENALEX_WORK, _openalex_params({
        "search": str(text or "").strip(),
        "per-page": max(1, min(int(limit or 5), 25)),
    }))
    raw = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        return []
    records = _open._parse_openalex(json.dumps({"results": raw}, ensure_ascii=False))
    candidates = []
    for item in records:
        candidates.append({
            "title": item.get("title") or "",
            "authors": item.get("authors") or "",
            "year": item.get("year"),
            "venue": item.get("venue") or "",
            "doi": _norm_doi(item.get("doi")),
            "openalex_id": _strip_openalex_id(item.get("openalex_id")),
            "url": item.get("result_url") or "",
        })
    return candidates


def resolve_or_suggest(text: str, *, limit: int = 5) -> dict:
    """解析种子；自由文本无法唯一命中时返回 ``needs_selection``。"""
    kind = classify_seed(text)
    if kind != "text":
        return {"status": "resolved", "seed": resolve_seed(text)}
    candidates = search_seed_candidates(text, limit=limit)
    if not candidates:
        raise ExpandError("没有检索到匹配的种子文献；请改用 DOI 或 PMID", kind="not_found")
    wanted = _title_key(text)
    exact = [item for item in candidates if _title_key(item.get("title")) == wanted]
    if len(exact) == 1:
        return {"status": "resolved", "seed": resolve_seed(exact[0]["openalex_id"] or exact[0]["doi"])}
    return {"status": "needs_selection", "candidates": candidates}


# ---------------------------------------------------------------------------
# 关系抓取
# ---------------------------------------------------------------------------

def _openalex_record(item: dict, relation: str) -> dict:
    return {
        "title": item.get("title") or "",
        "snippet": item.get("abstract") or "",
        "authors": item.get("authors") or "",
        "venue": item.get("venue") or "",
        "year": item.get("year"),
        "doi": _norm_doi(item.get("doi")),
        "result_url": item.get("result_url") or "",
        "fulltext_links": item.get("fulltext_links") or [],
        "pmid": str(item.get("pmid") or ""),
        "pmcid": str(item.get("pmcid") or ""),
        "source_key": "openalex",
        "seed_relation": relation,
        "seed_relations": [relation],
    }


def _openalex_works_by_ids(ids: list[str], limit: int) -> list[dict]:
    """按 OpenAlex Work ID 逐条取单记录。

    单记录按 ID 查询不消耗批量检索预算（OpenAlex 2026 定价口径），也避免
    ``filter=openalex_id`` / ``ids.openalex`` 这类字段名在不同 API 版本间的歧义。
    单条失败（记录被合并/删除）跳过，不拖垮整批；全失败时由调用方走 S2 兜底。
    """
    wanted = []
    for item in ids:
        value = _strip_openalex_id(item)
        if value and value not in wanted:
            wanted.append(value)
        if len(wanted) >= limit:
            break
    records: list[dict] = []
    for work_id in wanted:
        try:
            payload = _request_json(f"{OPENALEX_WORK}/{work_id}", _openalex_params())
        except Exception:  # 单条取不到不影响其余参考文献
            continue
        parsed = _open._parse_openalex(json.dumps({"results": [payload]}, ensure_ascii=False))
        records.extend(parsed)
    return records[:limit]


def _openalex_citing(seed: dict, limit: int) -> list[dict]:
    work_id = _strip_openalex_id(seed.get("openalex_id"))
    if not work_id:
        return []
    records: list[dict] = []
    page = 1
    while len(records) < limit:
        size = min(50, limit - len(records))
        payload = _request_json(OPENALEX_WORK, _openalex_params({
            "filter": f"cites:{work_id}",
            "sort": "publication_date:desc",
            "per-page": str(size),
            "page": str(page),
        }))
        raw = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(raw, list) or not raw:
            break
        records.extend(_open._parse_openalex(json.dumps({"results": raw}, ensure_ascii=False)))
        if len(raw) < size:
            break
        page += 1
        if page > 20:
            break
    return records[:limit]


def _s2_record(paper: dict, relation: str) -> dict:
    external = paper.get("externalIds") if isinstance(paper.get("externalIds"), dict) else {}
    links = []
    oa = paper.get("openAccessPdf") if isinstance(paper.get("openAccessPdf"), dict) else {}
    url = str(oa.get("url") or "").strip()
    if url.startswith("http"):
        links.append({"label": "开放获取 PDF", "url": url})
    return {
        "title": str(paper.get("title") or "").strip(),
        "snippet": str(paper.get("abstract") or ""),
        "authors": ", ".join(str((item or {}).get("name") or "") for item in (paper.get("authors") or []) if (item or {}).get("name")),
        "venue": str(paper.get("venue") or ""),
        "year": paper.get("year") if isinstance(paper.get("year"), int) else None,
        "doi": _norm_doi(external.get("DOI")),
        "result_url": str(paper.get("url") or ""),
        "fulltext_links": links,
        "pmid": str(external.get("PubMed") or ""),
        "pmcid": str(external.get("PubMedCentral") or ""),
        "source_key": "semantic-scholar",
        "seed_relation": relation,
        "seed_relations": [relation],
    }


def _s2_relation(seed: dict, relation: str, limit: int) -> list[dict]:
    paper_id = str(seed.get("paper_id") or "")
    if not paper_id:
        return []
    endpoint = {"reference": "references", "citing": "citations", "similar": "recommendations"}[relation]
    records: list[dict] = []
    offset = 0
    while len(records) < limit:
        size = min(100, limit - len(records))
        payload = _request_json(
            f"{SEMANTIC_SCHOLAR_PAPER}/{urllib.parse.quote(paper_id, safe=':')}/{endpoint}",
            {"fields": S2_FIELDS, "limit": str(size), "offset": str(offset)},
            headers=_s2_headers(),
        )
        if relation == "reference":
            raw = [item.get("citedPaper") for item in payload.get("data") or [] if isinstance(item, dict)]
        elif relation == "citing":
            raw = [item.get("citingPaper") for item in payload.get("data") or [] if isinstance(item, dict)]
        else:
            raw = payload.get("recommendedPapers") or payload.get("data") or []
        raw = [item for item in raw if isinstance(item, dict)]
        if not raw:
            break
        records.extend(_s2_record(item, relation) for item in raw)
        if len(raw) < size:
            break
        offset += len(raw)
        if offset >= 1000:
            break
    return records[:limit]


def _s2_relation_from_doi(seed: dict, relation: str, limit: int) -> list[dict]:
    """只有 DOI、没有 S2 paperId 时，先用 DOI 换 paperId。"""
    if seed.get("paper_id") or not seed.get("doi"):
        return _s2_relation(seed, relation, limit)
    payload = _request_json(
        f"{SEMANTIC_SCHOLAR_PAPER}/DOI:{urllib.parse.quote(seed['doi'], safe='/:')}",
        {"fields": "paperId,title"},
        headers=_s2_headers(),
    )
    paper_id = str(payload.get("paperId") or "")
    if not paper_id:
        return []
    return _s2_relation({**seed, "paper_id": paper_id}, relation, limit)


def collect_relations(seed: dict, relations: list[str], limit: int) -> tuple[list[dict], list[dict], list[str]]:
    """按关系收集并跨来源去重；返回 ``(records, provider_counts, warnings)``。"""
    selected = [name for name in RELATION_ORDER if name in set(relations or RELATION_ORDER)]
    if not selected:
        raise ExpandError("至少选择一种扩展关系", kind="identifier")
    merged: list[dict] = []
    seen: dict[str, dict] = {}
    provider_counts: list[dict] = []
    warnings: list[str] = []

    def add(records: list[dict], relation: str, provider: str) -> int:
        added = 0
        for item in records:
            if not item.get("title"):
                continue
            key = _record_key(item)
            if not key:
                continue
            hit = seen.get(key)
            if hit is not None:
                if relation not in hit["seed_relations"]:
                    hit["seed_relations"].append(relation)
                continue
            item["seed_relations"] = list(dict.fromkeys(item.get("seed_relations") or [relation]))
            item["seed_relation"] = item["seed_relations"][0]
            seen[key] = item
            merged.append(item)
            added += 1
        provider_counts.append({"relation": relation, "provider": provider, "count": len(records), "added": added})
        return added

    for relation in selected:
        if relation == "reference":
            records: list[dict] = []
            try:
                records = [_openalex_record(item, relation) for item in _openalex_works_by_ids(seed.get("referenced_works") or [], limit)]
            except Exception as error:
                warnings.append(f"OpenAlex 参考文献获取失败：{_error_text(error)}")
            add(records, relation, "openalex")
            # 只在 OpenAlex 完全拿不到时兜底：它返回了部分结果就如实使用，
            # 不再用 S2 硬凑数量（否则同一关系会被两个来源重复填充）。
            if not records:
                try:
                    add(_s2_relation_from_doi(seed, relation, limit), relation, "semantic-scholar")
                except Exception as error:
                    warnings.append(f"Semantic Scholar 参考文献获取失败：{_error_text(error)}")
        elif relation == "citing":
            records = []
            try:
                records = [_openalex_record(item, relation) for item in _openalex_citing(seed, limit)]
            except Exception as error:
                warnings.append(f"OpenAlex 被引文献获取失败：{_error_text(error)}")
            add(records, relation, "openalex")
            if not records:
                try:
                    add(_s2_relation_from_doi(seed, relation, limit), relation, "semantic-scholar")
                except Exception as error:
                    warnings.append(f"Semantic Scholar 被引文献获取失败：{_error_text(error)}")
        else:
            records = []
            try:
                records = [_openalex_record(item, relation) for item in _openalex_works_by_ids(seed.get("related_works") or [], limit)]
            except Exception as error:
                warnings.append(f"OpenAlex 相似文献获取失败：{_error_text(error)}")
            add(records, relation, "openalex")
            if not records:
                try:
                    add(_s2_relation_from_doi(seed, relation, limit), relation, "semantic-scholar")
                except Exception as error:
                    warnings.append(f"Semantic Scholar 相似文献获取失败：{_error_text(error)}")
    return merged[: max(limit * len(selected), limit)], provider_counts, warnings


# ---------------------------------------------------------------------------
# 并入候选池
# ---------------------------------------------------------------------------

def _seed_key(seed: dict) -> str:
    return str(seed.get("doi") or seed.get("openalex_id") or seed.get("paper_id") or seed.get("seed_id") or seed.get("input") or "")


def append_expansion(job_dir: Path, seed: dict, records: list[dict], relations: list[str],
                     provider_counts: list[dict] | None = None, warnings: list[str] | None = None) -> dict:
    """把扩展结果并入 candidates.json（同一 seed 的旧扩展整批替换）。

    扩展记录用 ``batch_index = -1``；不写进 ``batches``（那是检索批次的账），
    只写顶层 ``expansions`` 描述，重跑同一篇种子不会越扩越多。
    """
    job_dir = Path(job_dir)
    paths = _common.job_paths(job_dir)
    existing = _common.load_json(paths["candidates_json"], default=None) or {}
    all_old = [record for record in (existing.get("records") or []) if isinstance(record, dict)]
    seed_key = _seed_key(seed)
    kept = [record for record in all_old
            if not (record.get("expanded") and str(record.get("seed_key") or "") == seed_key)]

    retrieved_at = datetime.now(timezone.utc).isoformat()
    items = []
    for item in records:
        items.append({**item, "source_key": item.get("source_key") or "openalex"})
    new_records = _search.normalize_candidates(
        items, str(existing.get("query") or ""), retrieved_at,
        batch_index=EXPANSION_BATCH_INDEX,
        source_key="openalex",
        source_label=_sources.label_of("openalex") or "OpenAlex",
    )
    # normalize_candidates 会按来源重排 id；扩展记录改用独立前缀，避免与检索批次撞号。
    by_key: dict[str, dict] = {}
    for item in items:
        by_key.setdefault(_record_key(item), item)
    seed_hash = hashlib.sha1(seed_key.encode("utf-8")).hexdigest()[:8]
    counters: dict[str, int] = {}
    for record in new_records:
        source = by_key.get(_record_key(record)) or {}
        relation = str(source.get("seed_relation") or "similar")
        relations_list = list(source.get("seed_relations") or [relation])
        counters[relation] = counters.get(relation, 0) + 1
        record["candidate_id"] = "SEED-%s-%s%03d" % (seed_hash, RELATION_PREFIX.get(relation, "REL"), counters[relation])
        record["expanded"] = True
        record["seed_key"] = seed_key
        record["seed_id"] = str(seed.get("seed_id") or seed_key)
        record["seed_title"] = str(seed.get("title") or "")
        record["seed_relation"] = relation
        record["seed_relations"] = relations_list
        record["screening_status"] = "pending_review"

    all_records = kept + new_records
    expansions = [item for item in (existing.get("expansions") or [])
                  if isinstance(item, dict) and str(item.get("seed_key") or "") != seed_key]
    expansions.append({
        "seed_key": seed_key,
        "seed": seed,
        "relations": [name for name in RELATION_ORDER if name in set(relations or RELATION_ORDER)],
        "retrieved_at": retrieved_at,
        "count": len(new_records),
        "provider_counts": provider_counts or [],
        "warnings": warnings or [],
    })
    report = dict(existing)
    report.update({
        "version": existing.get("version", 2),
        "retrieved_at": retrieved_at,
        "count": len(all_records),
        "records": all_records,
        "expansions": expansions,
    })
    report.setdefault("scope", "first_page_candidates_only")
    _common.atomic_write_json(paths["candidates_json"], report)

    import csv
    import io
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=_search.CSV_FIELDS)
    writer.writeheader()
    for record in all_records:
        writer.writerow(_search.csv_cells(record))
    _common.atomic_write_text(paths["candidates_csv"], buffer.getvalue(), encoding="utf-8-sig")

    out_dir = job_dir / "research"
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "generated_at": retrieved_at,
        "seed": seed,
        "relations": [name for name in RELATION_ORDER if name in set(relations or RELATION_ORDER)],
        "provider_counts": provider_counts or [],
        "warnings": warnings or [],
        "count": len(new_records),
        "records": new_records,
    }
    artifact = out_dir / "seed_expansion.json"
    _common.atomic_write_json(artifact, payload)
    relation_counts: dict[str, int] = {}
    for record in new_records:
        relation = str(record.get("seed_relation") or "")
        if relation:
            relation_counts[relation] = relation_counts.get(relation, 0) + 1
    return {
        "added": len(new_records),
        "total": len(all_records),
        "replaced": len(all_old) - len(kept),
        "relation_counts": relation_counts,
        "seed": seed,
        "relations": payload["relations"],
        "provider_counts": provider_counts or [],
        "warnings": warnings or [],
        "records": new_records,
        "files": ["candidates.json", "candidates.csv", "research/seed_expansion.json"],
    }


def expand_and_append(job_dir: Path, seed_text: str, relations: list[str] | None = None,
                      limit: int = 50, *, append: bool = True) -> dict:
    resolved = resolve_or_suggest(seed_text)
    if resolved.get("status") == "needs_selection":
        return {"status": "needs_selection", **resolved}
    seed = resolved["seed"]
    records, counts, warnings = collect_relations(seed, relations or list(RELATION_ORDER), max(1, min(int(limit or 50), 200)))
    if not records:
        return {
            "status": "no_results",
            "seed": seed,
            "provider_counts": counts,
            "warnings": warnings or ["来源没有返回任何可核对的关系文献（可能是开放元数据缺失，不代表该文献没有引用关系）"],
            "count": 0,
        }
    if not append:
        relation_counts: dict[str, int] = {}
        for record in records:
            relation = str(record.get("seed_relation") or "")
            if relation:
                relation_counts[relation] = relation_counts.get(relation, 0) + 1
        return {"status": "ok", "seed": seed, "provider_counts": counts, "warnings": warnings,
                "relation_counts": relation_counts, "count": len(records), "records": records, "appended": False}
    outcome = append_expansion(job_dir, seed, records, relations or list(RELATION_ORDER), counts, warnings)
    return {"status": "ok", **outcome, "appended": True}


def main() -> int:
    parser = argparse.ArgumentParser(description="以文献找文献：参考文献/被引/相似扩展")
    parser.add_argument("--output-dir", type=Path, required=True, help="检索作业目录")
    parser.add_argument("--seed", required=True, help="DOI / PMID / PMCID / OpenAlex ID / 论文链接 / 标题")
    parser.add_argument("--relations", default="reference,citing,similar",
                        help="逗号分隔：reference,citing,similar")
    parser.add_argument("--limit", type=int, default=50, help="每种关系最多取多少条（1–200）")
    parser.add_argument("--no-append", action="store_true", help="只预览，不并入候选池")
    parser.add_argument("--preview", type=int, default=30, help="stdout 预览条数")
    args = parser.parse_args()
    relations = [item.strip() for item in str(args.relations or "").split(",") if item.strip()]
    if not args.output_dir.is_dir():
        print(json.dumps({"status": "error", "message": "作业目录不存在：" + str(args.output_dir)}, ensure_ascii=False))
        return 1
    try:
        result = expand_and_append(args.output_dir, args.seed, relations, args.limit, append=not args.no_append)
    except ExpandError as error:
        print(json.dumps({"status": "error", "message": str(error), "kind": error.kind}, ensure_ascii=False))
        return 1
    except Exception as error:  # noqa: BLE001 - CLI 需要把真实错误带回前端
        print(json.dumps({"status": "error", "message": f"扩展失败：{error}"}, ensure_ascii=False))
        return 1
    payload = dict(result)
    records = payload.pop("records", []) or []
    fields = ("title", "authors", "year", "venue", "doi", "source_key", "seed_relation", "seed_relations", "result_url")
    payload["preview"] = [{key: item.get(key) for key in fields} for item in records[: max(1, int(args.preview or 30))]]
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
