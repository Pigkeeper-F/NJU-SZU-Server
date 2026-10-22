#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""开放 API 检索的离线回归测试（不联网）。

覆盖：
  S1 来源注册表：新开放源 known/executable，人机验证类源进 manual 并带原因
  S2 请求构造：各源的 URL 与参数（含年份过滤、凭据注入）
  S3 响应解析：PubMed XML / OpenAlex JSON / Europe PMC JSON 的字段解析
  S4 候选 id 前缀与结构化字段优先（year/authors/venue 不靠 byline 猜）
  S5 接线分派：纯开放源走开放路径；Scholar 源不进开放路径

跑法：python tools/test_literature_search_open.py
"""
from __future__ import annotations

import importlib
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_sources = importlib.import_module("literature_sources")
_open = importlib.import_module("literature_search_open")
_search = importlib.import_module("literature_search")

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


# ---------------------------------------------------------------- S1 注册表
section("S1 来源注册表")
for key in ("google-scholar", "pubmed", "pmc", "openalex", "europe-pmc"):
    ok(_sources.is_known(key), "已登记：" + key)
    ok(_sources.is_executable(key), "可执行：" + key)
    ok(bool(_sources.label_of(key)), "有中文名：" + key)
    ok(bool(_sources.id_prefix_of(key)), "有 id 前缀：" + key)

for key in ("cnki", "wanfang", "web-of-science", "scopus"):
    ok(_sources.is_known(key), "已登记（浏览器来源）：" + key)
    ok(_sources.is_executable(key), "可进入执行链：" + key)
    ok(_sources.access_of(key) == "browser", "接入方式为浏览器：" + key)
    ok(bool(_sources.label_of(key)), "有显示名：" + key)

ok(set(_sources.executable_keys()) == set(_sources.all_keys()), "全部登记来源均可执行")


# ---------------------------------------------------------------- S2 请求构造
section("S2 请求构造（不发出网络请求）")
req = _open.search_request("pubmed", "soil carbon", 5, 2015, 2024)
ok(req["url"].endswith("esearch.fcgi"), "PubMed 用 esearch")
params = req["params"]
ok(params["db"] == "pubmed", "PubMed db=pubmed")
ok("2015[PDAT]" in params["term"] and "2024[PDAT]" in params["term"],
   "PubMed 年份过滤用 [PDAT] 字段限定：" + params["term"][:52])
ok(params["retmax"] == "5", "PubMed retmax")

req = _open.search_request("pmc", "soil carbon", 3)
ok(req["params"]["db"] == "pmc", "PMC db=pmc")

req = _open.search_request("openalex", "soil carbon", 7, 2020, None)
ok("api.openalex.org/works" in req["url"], "OpenAlex 端点正确")
ok("from_publication_date" in (req["params"].get("filter") or ""), "OpenAlex 年份过滤：" + req["params"].get("filter"))
ok(req["params"]["per_page"] == "7", "OpenAlex per_page")

req = _open.search_request("europe-pmc", "soil carbon", 4)
ok("europepmc" in req["url"], "Europe PMC 端点正确")
ok(req["params"]["resultType"] == "core", "Europe PMC 取 core（带摘要）")

try:
    _open.search_request("cnki", "x", 1)
    ok(False, "未支持来源应抛错")
except ValueError:
    ok(True, "未支持来源抛 ValueError")


# ---------------------------------------------------------------- S3 解析
section("S3 响应解析（样例响应）")
PUBMED_XML = """<?xml version="1.0"?>
<PubmedArticleSet>
 <PubmedArticle>
  <MedlineCitation>
   <PMID>12345678</PMID>
   <Article>
    <ArticleTitle>Long-term fertilization and soil carbon</ArticleTitle>
    <Abstract><AbstractText Label="BACKGROUND">SOC declines.</AbstractText>
    <AbstractText Label="RESULTS">Manure raised SOC.</AbstractText></Abstract>
    <Journal><Title>Soil Biology and Biochemistry</Title>
     <JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue></Journal>
    <AuthorList><Author><LastName>Zhang</LastName><ForeName>Wei</ForeName></Author>
     <Author><LastName>Li</LastName><ForeName>Ming</ForeName></Author></AuthorList>
    <ELocationID EIdType="doi" ValidYN="Y">10.1016/j.soilbio.2021.107777</ELocationID>
   </Article>
  </MedlineCitation>
 </PubmedArticle>
</PubmedArticleSet>"""
parsed = _open._parse_pubmed_xml(PUBMED_XML)
item = parsed.get("12345678")
ok(item is not None, "PubMed 解析出条目")
if item:
    ok("Long-term fertilization" in item["title"], "PubMed 标题")
    ok("Manure raised SOC" in item["abstract"], "PubMed 摘要")
    ok("2021" in str(item["year"]), "PubMed 年份：" + str(item["year"]))
    ok("Zhang" in item["authors"], "PubMed 作者")
    ok("10.1016/" in item["doi"], "PubMed DOI")

OPENALEX_JSON = json.dumps({
    "results": [{
        "id": "https://openalex.org/W1", "doi": "https://doi.org/10.1000/xyz",
        "title": "OpenAlex title", "publication_year": 2020,
        "authorships": [{"author": {"display_name": "Ann Lee"}}],
        "primary_location": {"source": {"display_name": "Nature Climate Change"}},
        "abstract_inverted_index": {"Soil": [0], "carbon": [1]},
        "open_access": {"is_oa": True},
        "best_oa_location": {"pdf_url": "https://example.org/a.pdf"},
    }]
})
rows = _open._parse_openalex(OPENALEX_JSON)
ok(len(rows) == 1, "OpenAlex 解析出一条")
if rows:
    ok(rows[0]["title"] == "OpenAlex title", "OpenAlex 标题")
    ok(str(rows[0]["year"]) == "2020", "OpenAlex 年份")
    ok("Ann Lee" in rows[0]["authors"], "OpenAlex 作者")
    ok("10.1000/xyz" in rows[0]["doi"], "OpenAlex DOI")

EPMC_JSON = json.dumps({
    "hitCount": 1,
    "resultList": {"result": [{
        "id": "MED/9988", "pmid": "9988", "title": "Europe PMC title",
        "authorString": "Bo Wang", "journalTitle": "PLoS One", "pubYear": "2019",
        "doi": "10.1371/journal.pone.001", "abstractText": "An abstract."
    }]}
})
rows = _open._parse_europe_pmc(EPMC_JSON)
ok(len(rows) == 1, "Europe PMC 解析出一条")
if rows:
    ok(rows[0]["title"] == "Europe PMC title", "Europe PMC 标题")
    ok(str(rows[0]["year"]) == "2019", "Europe PMC 年份：" + str(rows[0]["year"]))


# ---------------------------------------------------------------- S4 前缀与结构化优先
section("S4 候选 id 前缀与结构化字段优先")
ok(_search.candidate_prefix("google-scholar", 1) == "GSC", "Scholar 第 1 批前缀 GSC")
ok(_search.candidate_prefix("google-scholar", 2) == "GSC-B2", "Scholar 第 2 批前缀 GSC-B2")
ok(_search.candidate_prefix("pubmed", 1) == "PMID", "PubMed 前缀")
ok(_search.candidate_prefix("openalex", 1) == "OAX", "OpenAlex 前缀")

records = _search.normalize_candidates(
    [{
        "title": "Structured metadata paper",
        "byline": "Some Author. Some Venue. 1999",
        "snippet": "abstract text",
        "doi": "10.1/abc",
        "year": 2022,
        "authors": "Real Author",
        "venue": "Real Venue",
        "source_key": "pubmed",
    }],
    "q", "2026-01-01T00:00:00Z", batch_index=1, source_key="pubmed",
)
ok(len(records) == 1, "生成一条候选")
if records:
    rec = records[0]
    ok(rec["candidate_id"] == "PMID-001", "候选 id 带来源前缀：" + rec["candidate_id"])
    ok(rec["year"] == 2022, "年份取结构化字段：" + str(rec["year"]))
    ok(rec["authors"] == "Real Author", "作者取结构化字段")
    ok(rec["venue"] == "Real Venue", "期刊取结构化字段")
    ok(rec["source_key"] == "pubmed", "记录来源 key")
    ok(rec["screening_status"] == "pending_review", "默认待复核")


# ---------------------------------------------------------------- S5 分派
section("S5 接线分派")
ok(_search.open_source_keys(["google-scholar"]) == [], "Scholar 不算开放源")
ok(_search.open_source_keys(["pubmed", "google-scholar", "openalex"]) == ["pubmed", "openalex"], "开放源识别正确")

# 打桩：不发网络请求，验证 collect_open_results 的分派与容错
original_run = _open.run
calls: list = []


def fake_run(source_key, query, limit, year_from=None, year_to=None):
    calls.append((source_key, query, limit))
    if source_key == "pubmed":
        return {
            "status": "ok", "url": "https://eutils.ncbi.nlm.nih.gov/x", "count": 1,
            "results": [{"title": "T", "abstract": "A", "authors": "A B", "venue": "V",
                         "year": 2020, "doi": "10.1/x", "result_url": "https://p/1",
                         "fulltext_links": []}],
        }
    raise RuntimeError("模拟该源不可用")


_open.run = fake_run
try:
    items, metas = _search.collect_open_results(
        {"sources": ["pubmed", "openalex"], "query": "q", "limit": 3}, "q")
    ok(len(calls) == 2, "两个开放源都被调用")
    ok(len(items) == 1, "只收到成功源的条目")
    ok(len(metas) == 2, "两个源都有元信息")
    ok(any(m.get("status") == "error" for m in metas), "失败源被标 error")
    ok(any(m.get("error") for m in metas), "失败源带错误说明")
finally:
    _open.run = original_run

print("\nS6 调度器接入开放 API")
def fake_open_run(source_key, query, limit, year_from=None, year_to=None):
    return {
        "status": "ok", "url": "https://api.example/" + source_key, "count": 1,
        "results": [{"title": "Open paper", "abstract": "A", "authors": "X", "year": 2021,
                     "venue": "J", "doi": "10.1/o", "result_url": "https://x"}],
    }


original = _open.run
_open.run = fake_open_run
try:
    page = _search._run_source("openalex", "q", False, 10, 2020, 2024,
                               job_dir=Path("."), page_index=0, full_page=True)
    ok(page["status"] == "ok" and len(page["results"]) == 1, "调度器直接调用开放 API")
    ok(page["results"][0]["snippet"] == "A", "摘要映射到 snippet")
    ok(page["has_next"] is False and page["transport"] == "api", "单页来源如实标记")
finally:
    _open.run = original

with tempfile.TemporaryDirectory() as temp:
    out = io.StringIO()
    cfg = {"topic": "t", "query": "q", "sources": ["openalex"], "limit": 10,
           "searchMode": "formal", "stopMode": "end", "perSourceLimit": None}
    with redirect_stdout(out):
        code = _search.run(cfg, Path(temp))
    events = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    ok(code == 1 and events and events[-1]["type"] == "error", "正式检索到末页时开放 API 源明确报错")
    ok("暂不支持" in events[-1]["message"], "报错说明原因")

print("\n结果：%d 通过 / %d 失败" % (PASS, FAIL))
if FAIL:
    print("LITERATURE_OPEN_SEARCH_TESTS_FAIL")
    raise SystemExit(1)
print("LITERATURE_OPEN_SEARCH_TESTS_PASS")
