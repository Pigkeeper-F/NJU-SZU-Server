from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literature_search import (  # noqa: E402
    main, normalize_candidates, normalize_doi, parse_byline, resolve_batch_index,
    run, safe_csv_cell, validate_config, write_results,
)

CONFIG = {"topic": "中国水产养殖", "query": "China aquaculture climate change", "sources": ["google-scholar"],
          "publicationYearFrom": 2015, "publicationYearTo": 2023, "limit": 10}


def read_report(output: Path) -> dict:
    return json.loads((output / "candidates.json").read_text(encoding="utf-8"))


def read_csv_rows(output: Path) -> list[dict]:
    with (output / "candidates.csv").open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


class LiteratureSearchTest(unittest.TestCase):
    def test_csv_formula_is_not_executable(self) -> None:
        self.assertEqual(safe_csv_cell('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")")
        self.assertEqual(safe_csv_cell('ordinary title'), 'ordinary title')

    def test_normalize_keeps_candidates_unreviewed_and_deduplicates_title(self) -> None:
        records = normalize_candidates([
            {"title": " Climate effects on aquaculture ", "snippet": "a result snippet", "result_url": "https://example.org/a",
             "fulltext_links": [{"label": "PDF", "url": "https://example.org/a.pdf"}]},
            {"title": "Climate effects on aquaculture", "result_url": "https://example.org/duplicate"},
            {"title": "Other paper", "result_url": "javascript:alert(1)"},
        ], "climate aquaculture", "2026-10-15T00:00:00+00:00")
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["screening_status"], "pending_review")
        self.assertEqual(records[0]["evidence_level"], "search_result_snippet")
        self.assertEqual(records[0]["fulltext_links"][0]["url"], "https://example.org/a.pdf")
        self.assertEqual(records[1]["result_url"], "")

    def test_writes_json_and_excel_friendly_csv_without_fulltext_claim(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            result = write_results(output, "中国 畜禽 气候变化", {
                "url": "https://scholar.google.com/scholar?q=test",
                "results": [{"title": "示例论文", "byline": "作者", "snippet": "检索片段"}],
            })
            self.assertEqual(result["count"], 1)
            report = read_report(output)
            self.assertEqual(report["scope"], "first_page_candidates_only")
            self.assertEqual(report["records"][0]["screening_status"], "pending_review")
            with (output / "candidates.csv").open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(rows[0]["title"], "示例论文")
            self.assertEqual(rows[0]["evidence_level"], "search_result_snippet")

    def test_run_forwards_confirmed_publication_years_to_scholar(self) -> None:
        received = []
        scholar = types.SimpleNamespace(run=lambda *args: (received.append(args) or {"status": "no_results", "url": "https://scholar.google.com/scholar", "results": []}))
        browser = types.SimpleNamespace(launch=lambda: {"status": "already_running"})
        config = {"topic": "中国水产养殖", "query": "China aquaculture climate change", "sources": ["google-scholar"],
                  "publicationYearFrom": 2015, "publicationYearTo": 2023, "limit": 10}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"browser": browser, "google_scholar_search": scholar}):
            self.assertEqual(run(config, Path(temp)), 0)
            self.assertEqual(received, [(config["query"], False, 10, 2015, 2023)])
            report = read_report(Path(temp))
            self.assertEqual(report["run_config"]["publicationYearFrom"], 2015)

    def test_byline_parsing_is_conservative(self) -> None:
        self.assertEqual(parse_byline("J Smith, A Lee - Nature, 2019 - nature.com"),
                         {"authors": "J Smith, A Lee", "venue": "Nature", "year": 2019})
        self.assertEqual(parse_byline("张三, 李四 - 生态学报, 2020 - cnki"),
                         {"authors": "张三, 李四", "venue": "生态学报", "year": 2020})
        self.assertEqual(parse_byline("J Smith"), {"authors": "J Smith", "venue": "", "year": None})
        self.assertEqual(parse_byline(""), {"authors": "", "venue": "", "year": None})
        self.assertEqual(parse_byline("J Smith - 2019"), {"authors": "J Smith", "venue": "", "year": 2019})
        self.assertIsNone(parse_byline("J Smith - Nature - nature.com")["year"])

    def test_doi_normalization(self) -> None:
        self.assertEqual(normalize_doi("  10.1016/J.Geoderma.2019.01 "), "10.1016/j.geoderma.2019.01")
        self.assertEqual(normalize_doi("https://doi.org/10.1000/XYZ"), "10.1000/xyz")
        self.assertEqual(normalize_doi(None), "")
        self.assertEqual(normalize_doi(""), "")

    def test_first_batch_keeps_gsc_ids_and_new_fields_are_nullable(self) -> None:
        records = normalize_candidates([{"title": "One paper"}], "q", "2026-10-15T00:00:00+00:00")
        record = records[0]
        self.assertEqual(record["candidate_id"], "GSC-001")
        self.assertEqual(record["doi"], "")
        self.assertIsNone(record["year"])
        self.assertEqual(record["source_key"], "google-scholar")
        self.assertEqual(record["batch_index"], 1)

    def test_second_batch_uses_prefixed_ids_and_merges_cumulative_view(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            write_results(output, "q1", {"url": "https://scholar.google.com/1", "results": [{"title": "Alpha"}]}, CONFIG, batch_index=1)
            write_results(output, "q2", {"url": "https://scholar.google.com/2", "results": [{"title": "Beta"}, {"title": "Gamma"}]}, CONFIG, batch_index=2)
            report = read_report(output)
            self.assertEqual(report["version"], 2)
            self.assertEqual(report["count"], 3)
            self.assertEqual([batch["batch_index"] for batch in report["batches"]], [1, 2])
            self.assertEqual(report["search_url"], "https://scholar.google.com/2", "头部键取最新批次")
            identifiers = [record["candidate_id"] for record in report["records"]]
            self.assertEqual(identifiers, ["GSC-001", "GSC-B2-001", "GSC-B2-002"])
            rows = read_csv_rows(output)
            self.assertEqual(len(rows), 3)
            self.assertEqual(rows[1]["candidate_id"], "GSC-B2-001")
            self.assertEqual(rows[1]["batch_index"], "2")
            self.assertEqual(list(rows[0].keys()), [
                "candidate_id", "source", "query", "retrieved_at", "title", "byline", "snippet",
                "result_url", "fulltext_links", "screening_status", "evidence_level",
                "doi", "year", "authors", "venue", "source_key", "batch_index",
            ])

    def test_same_batch_rerun_replaces_that_batch_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            write_results(output, "q1", {"results": [{"title": "Alpha"}, {"title": "Beta"}]}, CONFIG, batch_index=1)
            write_results(output, "q2", {"results": [{"title": "Gamma"}]}, CONFIG, batch_index=2)
            write_results(output, "q1-retry", {"results": [{"title": "Alpha v2"}]}, CONFIG, batch_index=1)
            report = read_report(output)
            titles = [record["title"] for record in report["records"]]
            self.assertEqual(titles, ["Alpha v2", "Gamma"])
            self.assertEqual(len(report["batches"]), 2)

    def test_v1_report_is_migrated_when_merged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            legacy = {"source": "Google Scholar", "query": "old", "count": 1,
                      "records": [{"candidate_id": "GSC-001", "title": "Legacy", "screening_status": "pending_review"}]}
            (output / "candidates.json").write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(resolve_batch_index(output, CONFIG), 2, "v1 单批旧文件视为已有第 1 批")
            write_results(output, "new", {"results": [{"title": "Fresh"}]}, CONFIG, batch_index=2)
            report = read_report(output)
            self.assertEqual(report["version"], 2)
            legacy_record = next(record for record in report["records"] if record["title"] == "Legacy")
            self.assertEqual(legacy_record["source_key"], "google-scholar")
            self.assertEqual(legacy_record["batch_index"], 1)
            self.assertEqual([record["title"] for record in report["records"]], ["Legacy", "Fresh"])
            self.assertEqual(report["records"][1]["candidate_id"], "GSC-B2-001")

    def test_resolve_batch_index_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            self.assertEqual(resolve_batch_index(output, CONFIG), 1)
            write_results(output, "q1", {"results": [{"title": "Alpha"}]}, CONFIG, batch_index=1)
            self.assertEqual(resolve_batch_index(output, CONFIG), 2)
            self.assertEqual(resolve_batch_index(output, CONFIG, resume=True), 1)
            self.assertEqual(resolve_batch_index(output, CONFIG, requested=7), 7)

    def test_batch_limit_is_enforced_before_browser_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            write_results(output, "q1", {"results": [{"title": "Alpha"}]}, CONFIG, batch_index=1)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run(CONFIG, output)  # 缺省 = 新批次 2 > maxBatches=1
            self.assertEqual(code, 1)
            events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertIn("批数上限", events[-1]["message"])
            with redirect_stdout(io.StringIO()):
                code = run(CONFIG, output, batch_index=0)
            self.assertEqual(code, 1)

    def test_normalize_deduplicates_across_sources_by_doi(self) -> None:
        records = normalize_candidates([
            {"title": "Soil carbon under fertilization", "doi": "10.1016/J.GEODERMA.2019.01",
             "source_key": "pubmed", "authors": "Li et al.", "year": 2019, "snippet": "structured abstract"},
            {"title": "A differently punctuated title", "doi": "https://doi.org/10.1016/j.geoderma.2019.01",
             "source_key": "google-scholar", "snippet": "scholar snippet"},
        ], "q", "2026-10-22T00:00:00+00:00")
        self.assertEqual(len(records), 1, "同一 DOI 的不同来源必须合并")
        self.assertEqual(records[0]["source_key"], "pubmed", "保留先到的结构化来源")
        self.assertEqual(records[0]["snippet"], "structured abstract")

    def test_mixed_sources_use_per_source_queries_and_merge(self) -> None:
        calls = []
        class FakeOpen:
            @staticmethod
            def supports(key):
                return key in {"pubmed", "openalex"}
            @staticmethod
            def run(key, query, limit, year_from, year_to):
                calls.append(("open", key, query))
                return {
                    "status": "ok", "url": f"https://api.example/{key}", "count": 1,
                    "results": [{"title": "Shared paper", "doi": "10.1/shared", "authors": "A", "year": 2020,
                                 "venue": "J", "abstract": "open abstract", "result_url": f"https://api.example/{key}/1"}],
                }
        scholar = types.SimpleNamespace(run=lambda *args: (
            calls.append(("scholar", args[0])) or {
                "status": "ok", "url": "https://scholar.google.com/scholar?q=x",
                "results": [{"title": "Shared paper", "snippet": "scholar snippet"},
                            {"title": "Scholar only", "snippet": "s2"}],
            }))
        browser = types.SimpleNamespace(launch=lambda: {"status": "already_running"})
        config = {"topic": "土壤碳", "query": "soil carbon fertilization",
                  "sources": ["google-scholar", "pubmed"],
                  "sourceQueries": {"pubmed": '"soil organic carbon"[Title/Abstract]'},
                  "publicationYearFrom": 2015, "publicationYearTo": 2024, "limit": 5}
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                sys.modules, {"literature_search_open": FakeOpen, "browser": browser, "google_scholar_search": scholar}):
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run(config, Path(temp))
            self.assertEqual(code, 0)
            self.assertIn(("open", "pubmed", '"soil organic carbon"[Title/Abstract]'), calls)
            self.assertIn(("scholar", "soil carbon fertilization"), calls)
            report = read_report(Path(temp))
            self.assertEqual(report["scope"], "mixed_candidates")
            self.assertEqual(report["count"], 2, "跨源同 DOI 只留一条，Scholar 独有条目保留")
            self.assertEqual([record["title"] for record in report["records"]], ["Shared paper", "Scholar only"])
            self.assertEqual(report["source_counts"]["pubmed"], 1)
            self.assertEqual(report["source_counts"]["google-scholar"], 2)
            self.assertEqual(report["batches"][0]["status"], "complete")

    def test_mixed_sources_keep_open_results_when_scholar_hits_captcha(self) -> None:
        class FakeOpen:
            @staticmethod
            def supports(key):
                return key == "pubmed"
            @staticmethod
            def run(key, query, limit, year_from, year_to):
                return {"status": "ok", "url": "https://api.example/pubmed", "count": 1,
                        "results": [{"title": "Open only", "doi": "10.1/open", "abstract": "a"}]}
        scholar = types.SimpleNamespace(run=lambda *args: {"status": "captcha", "url": "https://scholar.google.com/scholar"})
        browser = types.SimpleNamespace(launch=lambda: {"status": "already_running"})
        config = {"topic": "土壤碳", "query": "soil carbon", "sources": ["google-scholar", "pubmed"],
                  "publicationYearFrom": None, "publicationYearTo": None, "limit": 5}
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                sys.modules, {"literature_search_open": FakeOpen, "browser": browser, "google_scholar_search": scholar}):
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run(config, Path(temp))
            self.assertEqual(code, 0)
            events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertEqual([event["type"] for event in events if event.get("type") in {"result", "attention"}],
                             ["result", "attention"])
            report = read_report(Path(temp))
            self.assertEqual(report["count"], 1)
            self.assertEqual(report["batches"][0]["status"], "partial")
            self.assertEqual(report["sources"][0]["status"], "ok")
            self.assertEqual(report["sources"][1]["status"], "captcha")

    def test_open_only_run_emits_result_event(self) -> None:
        class FakeOpen:
            @staticmethod
            def supports(key):
                return key == "pubmed"
            @staticmethod
            def run(key, query, limit, year_from, year_to):
                return {"status": "ok", "url": "https://api.example/pubmed", "count": 1,
                        "results": [{"title": "Open only", "abstract": "a"}]}
        config = {"topic": "土壤碳", "query": "soil carbon", "sources": ["pubmed"],
                  "publicationYearFrom": None, "publicationYearTo": None, "limit": 5}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_search_open": FakeOpen}):
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run(config, Path(temp))
            self.assertEqual(code, 0)
            events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertEqual(events[-1]["type"], "result", "纯开放源也必须发 result 收尾事件")
            self.assertEqual(events[-1]["count"], 1)
            report = read_report(Path(temp))
            self.assertEqual(report["batches"][0]["status"], "complete")

    def test_validate_config_accepts_per_source_queries(self) -> None:
        validate_config({**CONFIG, "sources": ["google-scholar", "pubmed"],
                         "sourceQueries": {"pubmed": '"soil organic carbon"[Title/Abstract]'}})
        with self.assertRaisesRegex(ValueError, "未在 sources 中启用"):
            validate_config({**CONFIG, "sourceQueries": {"pubmed": "x"}})
        with self.assertRaisesRegex(ValueError, "检索式为空"):
            validate_config({**CONFIG, "sources": ["pubmed"], "sourceQueries": {"pubmed": "  "}})

    def test_validate_config_rejects_unconnected_sources_with_frozen_message(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("sys.argv", ["literature_search.py", "--config", str(Path(temp) / "c.json"), "--output-dir", str(Path(temp) / "out")]):
            config_path = Path(temp) / "c.json"
            config_path.write_text(json.dumps({**CONFIG, "sources": ["google-scholar", "cnki"]}), encoding="utf-8")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = main()
            self.assertEqual(code, 1)
            events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertIn("尚未接通以下检索来源：cnki；请明确改为仅检索 Google Scholar，或等待相应连接器。", events[-1]["message"])

    def test_validate_config_keeps_stage1_generic_message(self) -> None:
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            validate_config({**CONFIG, "sources": ["arxiv"]})


if __name__ == "__main__":
    unittest.main()
