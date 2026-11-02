#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""以文献找文献（种子扩展）的离线回归测试（不联网）。

覆盖：
  S1 标识分类：DOI / PMID / PMCID / OpenAlex / S2 / 自由文本
  S2 种子定位：DOI → OpenAlex Work，保留 referenced_works / related_works
  S3 关系抓取：参考文献、被引、相似；跨关系按 DOI/标题去重
  S4 并入候选池：独立前缀、seed_relation 字段、同种子重跑整批替换
  S5 兜底：OpenAlex 429 时走 Semantic Scholar，不中断
  S6 自由文本：标题不唯一时返回 needs_selection，不替人猜
  S7 无法定位：返回可读错误，不产出空壳

跑法：python tools/test_literature_expand.py
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_expand = importlib.import_module("literature_expand")
_open = importlib.import_module("literature_search_open")

PASS = 0
FAIL = 0


def ok(condition: object, label: str) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  OK   " + label)
    else:
        FAIL += 1
        print("  FAIL " + label)


def section(title: str) -> None:
    print("\n" + title)


WORK = {
    "id": "https://openalex.org/W100",
    "doi": "https://doi.org/10.1000/seed",
    "title": "A seed paper",
    "publication_year": 2020,
    "cited_by_count": 12,
    "primary_location": {"source": {"display_name": "Seed Journal"}},
    "authorships": [{"author": {"display_name": "Seed Author"}}],
    "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/12345678", "pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567"},
    "referenced_works": ["https://openalex.org/W111", "https://openalex.org/W222"],
    "related_works": ["https://openalex.org/W222", "https://openalex.org/W333"],
}


def work(work_id: str, title: str, doi: str, year: int) -> dict:
    return {
        "id": "https://openalex.org/" + work_id,
        "doi": "https://doi.org/" + doi,
        "title": title,
        "publication_year": year,
        "primary_location": {"source": {"display_name": "Journal"}},
        "authorships": [{"author": {"display_name": "Author " + work_id}}],
        "ids": {},
        "referenced_works": [],
        "related_works": [],
    }


REFS = [
    work("W111", "Reference one", "10.1000/ref1", 2010),
    work("W222", "Shared paper", "10.1000/shared", 2012),
]
CITING = [work("W444", "Citing paper", "10.1000/cite", 2023)]
SIMILAR = [
    work("W222", "Shared paper", "10.1000/shared", 2012),
    work("W333", "Similar paper", "10.1000/sim", 2015),
]


def install_fake(*, openalex_relations_429: bool = False, search_results: list[dict] | None = None) -> None:
    def fake_http(url: str, params: dict | None = None, **kwargs):
        p = params or {}
        if "/works/https://doi.org/" in url or url.endswith("/W100"):
            return 200, json.dumps(WORK)
        if "/works/W" in url:
            if openalex_relations_429:
                raise _open.SourceError("HTTP 429：rate limited", status=429, kind="rate_limited")
            work_id = url.rsplit("/", 1)[-1]
            pool = REFS + SIMILAR
            hit = next((item for item in pool if item["id"].rsplit("/", 1)[-1] == work_id), None)
            return 200, json.dumps(hit) if hit else (404, "{}")
        if url.endswith("/works"):
            if p.get("search"):
                return 200, json.dumps({"results": search_results or []})
            filt = str(p.get("filter") or "")
            if openalex_relations_429:
                raise _open.SourceError("HTTP 429：rate limited", status=429, kind="rate_limited")
            if filt.startswith("cites:"):
                return 200, json.dumps({"results": CITING})
        if "graph/v1/paper/DOI:" in url:
            return 200, json.dumps({"paperId": "s2paper"})
        if "/references" in url:
            return 200, json.dumps({"data": [{"citedPaper": s2_paper("S2 Ref", "10.1000/s2ref", 2011)}]})
        if "/citations" in url:
            return 200, json.dumps({"data": [{"citingPaper": s2_paper("S2 Cite", "10.1000/s2cite", 2024)}]})
        if "/recommendations" in url:
            return 200, json.dumps({"recommendedPapers": [s2_paper("S2 Similar", "10.1000/s2sim", 2016)]})
        raise AssertionError("unexpected URL: " + url + " " + json.dumps(p))

    def s2_paper(title: str, doi: str, year: int) -> dict:
        return {
            "paperId": "p-" + doi,
            "title": title,
            "abstract": "abstract",
            "authors": [{"name": "S2 Author"}],
            "year": year,
            "venue": "S2 Journal",
            "externalIds": {"DOI": doi},
            "openAccessPdf": {"url": "https://example.test/paper.pdf"},
            "url": "https://semanticscholar.org/paper/" + doi,
        }

    _open.http_get = fake_http
    _expand.time.sleep = lambda seconds: None


section("S1 标识分类")
ok(_expand.classify_seed("10.1016/j.cej.2025.164701") == "doi", "DOI")
ok(_expand.classify_seed("PMID: 32793646") == "pmid", "PMID")
ok(_expand.classify_seed("PMC7456150") == "pmcid", "PMCID")
ok(_expand.classify_seed("W2741809807") == "openalex", "OpenAlex Work ID")
ok(_expand.classify_seed("a" * 40) == "s2", "Semantic Scholar paperId")
ok(_expand.classify_seed("气候变化对动物生产的影响") == "text", "自由文本")

section("S2 种子定位（DOI → OpenAlex）")
install_fake()
seed = _expand.resolve_seed("10.1000/seed")
ok(seed["openalex_id"] == "W100" and seed["doi"] == "10.1000/seed", "定位到 OpenAlex Work 与 DOI")
ok(len(seed["referenced_works"]) == 2 and len(seed["related_works"]) == 2, "保留参考文献/相似关系")
ok(seed["pmid"] == "12345678" and seed["pmcid"] == "PMC1234567", "保留 PMID/PMCID")

section("S3 关系抓取与跨关系去重")
records, counts, warnings = _expand.collect_relations(seed, ["reference", "citing", "similar"], 10)
by_title = {item["title"]: item for item in records}
ok(len(records) == 4, "四种不同文献（重复的 Shared paper 只保留一条）")
ok(by_title["Shared paper"]["seed_relations"] == ["reference", "similar"], "重复条目合并关系")
ok(by_title["Reference one"]["seed_relation"] == "reference", "参考文献标记正确")
ok(by_title["Citing paper"]["seed_relation"] == "citing", "被引标记正确")
ok(by_title["Similar paper"]["seed_relation"] == "similar", "相似标记正确")
ok(not warnings, "正常路径无警告")

section("S4 并入候选池：独立前缀 + 同种子替换")
job_dir = Path(tempfile.mkdtemp(prefix="lit-expand-test-"))
(job_dir / "candidates.json").write_text(json.dumps({
    "version": 2, "query": "seed topic", "records": [
        {"candidate_id": "GSC-001", "title": "Existing", "batch_index": 1, "source_key": "google-scholar"}
    ]
}, ensure_ascii=False), encoding="utf-8")
first = _expand.append_expansion(job_dir, seed, records, ["reference", "citing", "similar"], counts, warnings)
ok(first["added"] == 4 and first["total"] == 5, "扩展 4 条并入候选池")
ok(first["relation_counts"] == {"reference": 2, "citing": 1, "similar": 1}, "按关系给出准确计数")
saved = json.loads((job_dir / "candidates.json").read_text(encoding="utf-8"))
expanded = [item for item in saved["records"] if item.get("expanded")]
ok(len(expanded) == 4 and all(item["candidate_id"].startswith("SEED-") for item in expanded), "扩展条目使用独立 id 前缀")
ok(all(item["seed_key"] == "10.1000/seed" for item in expanded), "每条都记了种子来源")
ok(any(item["candidate_id"] == "GSC-001" for item in saved["records"]), "原有检索条目保留")
ok((job_dir / "research" / "seed_expansion.json").is_file(), "扩展结果落盘 research/seed_expansion.json")

second = _expand.append_expansion(job_dir, seed, records, ["reference", "citing", "similar"], counts, warnings)
saved2 = json.loads((job_dir / "candidates.json").read_text(encoding="utf-8"))
ok(second["replaced"] == 4 and saved2["count"] == 5, "同种子重跑整批替换，不翻倍")
ok(len(saved2["expansions"]) == 1, "expansions 描述也只保留一份")

section("S5 OpenAlex 限流 → Semantic Scholar 兜底")
install_fake(openalex_relations_429=True)
records2, counts2, warnings2 = _expand.collect_relations(seed, ["reference", "citing"], 10)
ok(len(records2) >= 2, "OpenAlex 429 时仍拿到 S2 结果")
ok(any(item["source_key"] == "semantic-scholar" for item in records2), "兜底条目标记 semantic-scholar")
ok(all("OpenAlex" in text for text in warnings2 if "失败" in text), "警告如实说明 OpenAlex 失败")

section("S6 自由文本：标题不唯一 → needs_selection")
install_fake(search_results=[
    work("W501", "Climate change and animal production: a meta-analysis", "10.1000/a", 2021),
    work("W502", "Climate change and animal production: a review", "10.1000/b", 2022),
])
picked = _expand.resolve_or_suggest("climate change and animal production")
ok(picked["status"] == "needs_selection" and len(picked["candidates"]) == 2, "返回候选项而不自动认定")

section("S7 无法定位：可读错误")
install_fake(search_results=[])
try:
    _expand.resolve_or_suggest("no such paper title")
    ok(False, "应当抛错")
except _expand.ExpandError as error:
    ok("没有检索到匹配的种子文献" in str(error), "错误说明可读")

print("\n结果：" + str(PASS) + " 通过 / " + str(FAIL) + " 失败")
if FAIL:
    print("LITERATURE_EXPAND_TESTS_FAIL")
    raise SystemExit(1)
print("LITERATURE_EXPAND_TESTS_PASS")
