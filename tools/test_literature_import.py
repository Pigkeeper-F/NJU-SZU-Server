#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""文献清单导入的离线回归测试（不联网）。

覆盖：
  S1 RIS 解析（知网/万方/WoS/Scopus 通用导出格式）
  S2 BibTeX 解析
  S3 CSV 解析（中英文表头）
  S4 格式自动识别
  S5 并入候选池：batch_index=0、前缀、整批替换（重复导入不翻倍）、与检索记录共存
  S6 坏输入：空清单 / 无题录 → 明确报错而不是写空

跑法：python tools/test_literature_import.py
"""
from __future__ import annotations

import importlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_import = importlib.import_module("literature_import")

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


RIS = """TY  - JOUR
TI  - 长期施肥对土壤有机碳的影响研究
AU  - 张三
AU  - 李四
JO  - 农业环境学报
PY  - 2023
DO  - https://doi.org/10.1234/ABC.001
AB  - 通过长期定位试验研究施肥对 SOC 的影响。
UR  - https://kns.cnki.net/kcms/detail/1
ER  -

TY  - JOUR
TI  - 土壤碳库变化综述
AU  - 王五
JO  - 土壤通报
PY  - 2021
ER  -
"""

BIB = """@article{zhang2023,
  title = {Long-term fertilization and soil carbon},
  author = {Zhang, Wei and Li, Ming},
  journal = {Soil Biology},
  year = {2023},
  doi = {10.1016/j.soilbio.2023.001},
  abstract = {We studied SOC dynamics.},
  url = {https://example.org/a}
}
"""

CSV = "标题,作者,期刊,年份,DOI,摘要\n中文论文标题,赵六,中国农业科学,2022,10.1234/cn.2022,\nSecond paper,Ann Lee,Nature,2020,,An abstract\n"

section("S1 RIS 解析")
items = _import.parse_ris(RIS, "cnki")
ok(len(items) == 2, "解析出 2 条")
if items:
    first = items[0]
    ok("长期施肥" in first["title"], "标题")
    ok(first["authors"] == "张三, 李四", "作者：" + first["authors"])
    ok(first["venue"] == "农业环境学报", "期刊")
    ok(first["year"] == 2023, "年份：" + str(first["year"]))
    ok(first["doi"] == "10.1234/abc.001", "DOI 归一化（去 doi.org 前缀 + 小写）：" + first["doi"])
    ok("长期定位试验" in first["snippet"], "摘要")
    ok(first["source_key"] == "cnki", "来源 key")

section("S2 BibTeX 解析")
items = _import.parse_bibtex(BIB, "web-of-science")
ok(len(items) == 1, "解析出 1 条")
if items:
    row = items[0]
    ok("Long-term fertilization" in row["title"], "标题")
    ok("Zhang" in row["authors"] and "Li" in row["authors"], "作者（and → 逗号）：" + row["authors"])
    ok(row["year"] == 2023, "年份")
    ok(row["venue"] == "Soil Biology", "期刊")
    ok("10.1016" in row["doi"], "DOI")

section("S3 CSV 解析（中英文表头）")
items = _import.parse_csv(CSV, "wanfang")
ok(len(items) == 2, "解析出 2 条")
if len(items) == 2:
    ok(items[0]["title"] == "中文论文标题", "中文表头「标题」")
    ok(items[0]["authors"] == "赵六", "中文表头「作者」")
    ok(items[0]["venue"] == "中国农业科学", "中文表头「期刊」")
    ok(items[0]["year"] == 2022, "中文表头「年份」")
    ok(items[1]["title"] == "Second paper", "英文表头 title")
    ok(items[1]["year"] == 2020, "英文表头 year")

section("S4 格式自动识别")
tmp = Path(tempfile.mkdtemp(prefix="lit-import-test-"))
try:
    ris_path = tmp / "a.txt"
    ris_path.write_text(RIS, encoding="utf-8")
    ok(_import.detect_format(ris_path, RIS) == "ris", "按内容识别 RIS")

    bib_path = tmp / "b.txt"
    bib_path.write_text(BIB, encoding="utf-8")
    ok(_import.detect_format(bib_path, BIB) == "bibtex", "按内容识别 BibTeX")

    csv_path = tmp / "c.csv"
    csv_path.write_text(CSV, encoding="utf-8")
    ok(_import.detect_format(csv_path, CSV) == "csv", "按扩展名识别 CSV")

    ok(len(_import.parse_list(ris_path, None, "cnki")) == 2, "parse_list 自动识别并解析")

    section("S5 并入候选池")
    job = tmp / "job"
    job.mkdir()
    # 先放一条"检索来的"记录，验证共存
    (job / "candidates.json").write_text(json.dumps({
        "version": 2, "source": "Google Scholar", "query": "q",
        "batches": [{"batch_index": 1, "query": "q", "search_url": "", "retrieved_at": "2026-01-01",
                     "count": 1, "applied_filters": ["query"], "deferred_rules": [], "status": "complete"}],
        "records": [{
            "candidate_id": "GSC-001", "source": "Google Scholar", "query": "q", "retrieved_at": "2026-01-01",
            "title": "Scholar paper", "byline": "", "snippet": "", "result_url": "", "fulltext_links": [],
            "screening_status": "pending_review", "evidence_level": "search_result_snippet",
            "doi": "", "year": 2020, "authors": "", "venue": "", "source_key": "google-scholar",
            "batch_index": 1
        }],
        "count": 1
    }, ensure_ascii=False), encoding="utf-8")

    result = _import.append_imported(job, items, "cnki", "q")
    ok(result["added"] == 2, "导入 2 条")
    ok(result["total"] == 3, "候选池 1（检索）+ 2（导入）= 3")
    data = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
    imported = [r for r in data["records"] if r.get("imported")]
    ok(len(imported) == 2, "记录数正确")
    ok(all(r["candidate_id"].startswith("CNK-I") for r in imported),
       "导入前缀 CNK-I：" + ", ".join(r["candidate_id"] for r in imported))
    ok(all(r["batch_index"] == 0 for r in imported), "导入批次 batch_index=0")
    ok(all(r["screening_status"] == "pending_review" for r in imported), "导入条目默认待复核")
    ok(any(b.get("batch_index") == 0 and b.get("imported") for b in data["batches"]), "批次记录标了 imported")

    # 重复导入同一份 → 整批替换，不翻倍
    again = _import.append_imported(job, items, "cnki", "q")
    ok(again["total"] == 3, "重复导入后总数不变（整批替换）：" + str(again["total"]))
    data2 = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
    ok(len([r for r in data2["records"] if r.get("imported")]) == 2, "导入条目没有翻倍")
    ok(len([b for b in data2["batches"] if b.get("batch_index") == 0]) == 1, "导入批次只有一条")

    section("S6 坏输入")
    ok(_import.parse_ris("这不是 RIS", "cnki") == [], "非 RIS 内容 → 空列表")
    ok(_import.parse_bibtex("随便写点", "cnki") == [], "非 BibTeX → 空列表")
    ok(_import.parse_csv("a,b\n1,2\n", "cnki") == [], "无题名列的 CSV → 空列表")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n结果：%d 通过 / %d 失败" % (PASS, FAIL))
if FAIL:
    print("LITERATURE_IMPORT_TESTS_FAIL")
    raise SystemExit(1)
print("LITERATURE_IMPORT_TESTS_PASS")
