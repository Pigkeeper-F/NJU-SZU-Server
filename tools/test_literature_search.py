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
    config_fingerprint, filtered_source_results, main, normalize_candidates, normalize_doi, parse_byline, resolve_batch_index,
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
        adapter = types.SimpleNamespace(run=lambda *args, **kwargs: (received.append((args, kwargs)) or {"status": "no_results", "url": "https://scholar.google.com/scholar", "results": []}))
        config = {"topic": "中国水产养殖", "query": "China aquaculture climate change", "sources": ["google-scholar"],
                  "publicationYearFrom": 2015, "publicationYearTo": 2023, "limit": 10}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": adapter}):
            self.assertEqual(run(config, Path(temp)), 0)
            self.assertEqual(received, [(("google-scholar", config["query"], False, 10, 2015, 2023), {"job_dir": Path(temp)})])
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
                "doi", "year", "authors", "venue", "source_key", "batch_index", "pmid", "transport",
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

    def test_validate_config_rejects_a_registered_but_disabled_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("literature_search._sources.is_executable", side_effect=lambda source: source != "scopus"), patch("sys.argv", ["literature_search.py", "--config", str(Path(temp) / "c.json"), "--output-dir", str(Path(temp) / "out")]):
            config_path = Path(temp) / "c.json"
            config_path.write_text(json.dumps({**CONFIG, "sources": ["google-scholar", "scopus"]}), encoding="utf-8")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = main()
            self.assertEqual(code, 1)
            events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertIn("尚未接通以下检索来源：scopus；请选择已接通来源，或等待相应连接器。", events[-1]["message"])

    def test_all_six_sources_are_executable(self) -> None:
        validate_config({**CONFIG, "sources": ["google-scholar", "cnki", "wanfang", "web-of-science", "scopus", "pubmed"]})

    def test_validate_config_keeps_stage1_generic_message(self) -> None:
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            validate_config({**CONFIG, "sources": ["arxiv"]})

    def test_source_queries_are_validated_and_optional_for_old_tasks(self) -> None:
        validate_config({**CONFIG, "sources": ["cnki", "web-of-science"], "sourceQueries": {"cnki": "肉鸡 高温"}})
        self.assertEqual(config_fingerprint(CONFIG), config_fingerprint({**CONFIG, "sourceQueries": {}}))
        self.assertNotEqual(config_fingerprint(CONFIG), config_fingerprint({**CONFIG, "sourceQueries": {"google-scholar": "new query"}}))
        for queries in ([], {"arxiv": "q"}, {"cnki": " "}, {"cnki": "a" * 2001}, {"cnki": 5}):
            with self.subTest(queries=queries), self.assertRaises(ValueError):
                validate_config({**CONFIG, "sourceQueries": queries})
        with self.assertRaisesRegex(ValueError, "不能晚于"):
            validate_config({**CONFIG, "publicationYearFrom": 2024})

    def test_normalization_keeps_cross_source_duplicates_and_actual_metadata(self) -> None:
        records = normalize_candidates([
            {"title": "Same paper", "source_key": "google-scholar", "byline": "Old - Journal, 2018"},
            {"title": "Same paper", "source_key": "cnki", "year": "2021-03-15", "authors": ["张三", "李四"], "venue": "真实期刊", "byline": "Old - Wrong, 2017"},
            {"title": "Same paper", "source_key": "web-of-science", "year": "JAN 2020"},
            {"title": "Same paper", "source_key": "cnki"},
        ], "q", "now", batch_index=2)
        self.assertEqual([item["candidate_id"] for item in records], ["GSC-B2-001", "CNKI-B2-001", "WOS-B2-001"])
        self.assertEqual(records[1]["year"], 2021)
        self.assertEqual(records[1]["authors"], "张三; 李四")
        self.assertEqual(records[1]["venue"], "真实期刊")
        self.assertEqual(records[2]["year"], 2020)
        self.assertIsNone(normalize_candidates([{"title": "Range", "year": "2019-2021"}], "q", "now")[0]["year"])

    def test_login_checkpoint_preserves_sources_and_resumes_only_pending_tab(self) -> None:
        config = {**CONFIG, "sources": ["google-scholar", "cnki", "web-of-science"],
                  "sourceQueries": {"cnki": "肉鸡 高温", "web-of-science": "broiler heat stress"}}
        calls = []
        paused = True

        def browser_run(source, query, scrape_current, limit, year_from, year_to, *, job_dir):
            nonlocal paused
            calls.append((source, query, scrape_current, limit, year_from, year_to))
            if source == "google-scholar":
                return {"status": "ok", "url": "https://scholar.google.com/scholar", "results": [{"title": "Same paper", "year": 2020}]}
            if source == "cnki" and paused:
                paused = False
                return {"status": "attention", "reason": "login", "message": "请登录知网"}
            if source == "cnki":
                return {"status": "ok", "results": [{"title": "Same paper", "year": 2020}, {"title": "Older paper", "year": 2014}, {"title": "Unknown year"}],
                        "applied_filters": ["query"], "deferred_rules": ["publicationYearFrom", "publicationYearTo"]}
            return {"status": "ok", "results": [{"title": "Same paper", "year": 2022}], "applied_filters": ["query"]}

        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}):
            output, stdout = Path(temp), io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(run(config, output), 0)
            report = read_report(output)
            self.assertFalse(report["discovery_complete"])
            self.assertEqual(report["batches"][0]["status"], "partial")
            self.assertEqual([item["candidate_id"] for item in report["records"]], ["GSC-001"])
            attention = [json.loads(line) for line in stdout.getvalue().splitlines()][-1]
            self.assertEqual((attention["type"], attention["source"], attention["reason"]), ("attention", "cnki", "login"))
            self.assertEqual(attention["files"], ["candidates.json", "candidates.csv"])
            state = json.loads((output / "discovery-state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["pending_source"], "cnki")
            self.assertEqual(state["sources"]["google-scholar"]["status"], "ok")
            # Resume reconstructs from disk rather than keeping Python object state.
            with redirect_stdout(io.StringIO()):
                self.assertEqual(run(config, output, resume=True), 0)
            self.assertEqual([call[0] for call in calls], ["google-scholar", "cnki", "cnki", "web-of-science"])
            self.assertEqual([call[2] for call in calls], [False, False, True, False])
            self.assertEqual(calls[2][1], "肉鸡 高温")
            self.assertEqual(calls[3][1], "broiler heat stress")
            report = read_report(output)
            self.assertTrue(report["discovery_complete"])
            self.assertEqual(report["batches"][0]["status"], "complete")
            self.assertEqual([item["candidate_id"] for item in report["records"]], ["GSC-001", "CNKI-001", "CNKI-002", "WOS-001"])
            self.assertEqual(len(read_csv_rows(output)), 4)
            status = report["source_status"]["cnki"]
            self.assertEqual(status["year_filtering"], {"mode": "post_filter_known_years", "excluded": 1, "unknown_year_retained": 1})
            self.assertNotIn("publicationYearFrom", status["applied_filters"])
            self.assertIn("unknown_publication_year_review", status["deferred_rules"])
            self.assertEqual(report["source_status"]["web-of-science"]["year_filtering"]["mode"], "post_filter_known_years")
            count = len(calls)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(run(config, output, resume=True), 0)
            self.assertEqual(len(calls), count, "已完成来源不会重复检索")

    def test_checkpoint_refuses_changed_queries_and_attention_is_not_zero_hits(self) -> None:
        adapter = types.SimpleNamespace(run=lambda *args, **kwargs: {"status": "attention", "reason": "results_unrecognized"})
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": adapter}):
            output = Path(temp)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(run({**CONFIG, "sources": ["web-of-science"]}, output), 0)
            report = read_report(output)
            self.assertFalse(report["discovery_complete"])
            self.assertEqual(report["source_status"]["web-of-science"]["status"], "attention")
            original = (output / "discovery-state.json").read_bytes()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(run({**CONFIG, "sources": ["web-of-science"], "sourceQueries": {"web-of-science": "changed"}}, output, resume=True), 1)
            self.assertIn("检索配置已更改", json.loads(stdout.getvalue())["message"])
            self.assertEqual((output / "discovery-state.json").read_bytes(), original)

    def test_sources_execute_in_user_order_and_per_source_limit(self) -> None:
        calls = []
        def browser_run(source, query, scrape_current, limit, year_from, year_to, **kwargs):
            calls.append(source)
            return {"status": "ok", "results": [{"title": f"{source} {index}", "year": 2020} for index in range(15)]}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}), redirect_stdout(io.StringIO()):
            self.assertEqual(run({**CONFIG, "sources": ["web-of-science", "cnki", "google-scholar"]}, Path(temp)), 0)
            report = read_report(Path(temp))
        self.assertEqual(calls, ["web-of-science", "cnki", "google-scholar"])
        self.assertEqual(report["count"], 30)
        self.assertEqual([record["candidate_id"] for record in report["records"]][::10], ["WOS-001", "CNKI-001", "GSC-001"])

    def test_technical_failure_keeps_previous_source_and_retries_normal_search(self) -> None:
        calls, failed = [], False
        def browser_run(source, query, scrape_current, limit, year_from, year_to, **kwargs):
            nonlocal failed
            calls.append((source, scrape_current))
            if source == "cnki" and not failed:
                failed = True
                return {"status": "error", "message": "浏览器连接暂时失败"}
            return {"status": "ok", "results": [{"title": source, "year": 2020}]}
        config = {**CONFIG, "sources": ["google-scholar", "cnki"]}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}), redirect_stdout(io.StringIO()):
            output = Path(temp)
            self.assertEqual(run(config, output), 1)
            report = read_report(output)
            self.assertFalse(report["discovery_complete"])
            self.assertEqual(report["count"], 1)
            self.assertEqual(report["source_status"]["cnki"]["status"], "error")
            self.assertEqual(run(config, output, resume=True), 0)
            self.assertEqual(read_report(output)["count"], 2)
        self.assertEqual(calls, [("google-scholar", False), ("cnki", False), ("cnki", False)])

    def test_six_source_wos_error_attention_resume_keeps_thirty_frozen_candidates(self) -> None:
        sources = ["pubmed", "scopus", "wanfang", "web-of-science", "cnki", "google-scholar"]
        queries = {source: source + " frozen broiler heat query" for source in sources}
        config = {**CONFIG, "query": 'broiler "heat stress"', "sources": sources, "sourceQueries": queries,
                  "searchMode": "test", "stopMode": "count", "perSourceLimit": 10,
                  "batch": {"size": 10, "maxBatches": 1}}
        frozen = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        fingerprint = config_fingerprint(config)
        calls, wos_attempts = [], 0

        def browser_run(source, query, scrape_current, limit, year_from, year_to, *, job_dir):
            nonlocal wos_attempts
            calls.append((source, query, scrape_current))
            self.assertEqual(job_dir, output)
            self.assertEqual(query, queries[source], "重试必须使用冻结的分来源检索式")
            self.assertEqual((limit, year_from, year_to), (10, 2015, 2023))
            if source == "web-of-science":
                wos_attempts += 1
                if wos_attempts == 1:
                    return {"status": "error", "message": "浏览器操作暂时失败"}
                if wos_attempts == 2:
                    return {"status": "attention", "reason": "login", "message": "请在本任务的WOS页面登录"}
            return {"status": "ok", "transport": "ncbi_eutilities" if source == "pubmed" else "browser",
                    "results": [{"title": f"{source} broiler heat study {index}", "year": 2020,
                                 "result_url": f"https://example.org/{source}/{index}"} for index in range(10)]}

        with tempfile.TemporaryDirectory(prefix="literature-six-source-retry-") as temp, patch.dict(
                sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}):
            output = Path(temp)
            config_path = output / "run_config.json"
            config_path.write_bytes(frozen)

            def attempt(**options):
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    code = run(config, output, **options)
                events = [json.loads(line) for line in stdout.getvalue().splitlines()]
                report = read_report(output)
                state = json.loads((output / "discovery-state.json").read_text(encoding="utf-8"))
                self.assertEqual(config_path.read_bytes(), frozen, "续跑不得改写原运行配置")
                self.assertEqual((json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), frozen)
                self.assertEqual(state["config_fingerprint"], fingerprint)
                self.assertEqual(state["batch_index"], 1)
                self.assertEqual([batch["batch_index"] for batch in report["batches"]], [1])
                self.assertEqual(report["run_config"], config)
                self.assertEqual(len(read_csv_rows(output)), report["count"])
                return code, events[-1], report, state

            code, event, first, state = attempt()
            self.assertEqual(code, 1)
            self.assertEqual((event["type"], event["source"], event["count"]), ("error", "web-of-science", 30))
            self.assertEqual((state["pending_source"], state["pending_reason"]), ("web-of-science", None))
            self.assertEqual(state["sources"]["web-of-science"]["status"], "error")
            self.assertFalse(first["discovery_complete"])
            self.assertEqual(first["count"], 30)
            first_thirty = first["records"]
            first_ids = [record["candidate_id"] for record in first_thirty]
            self.assertEqual([record["source_key"] for record in first_thirty][::10], sources[:3])
            self.assertTrue(all(state["sources"][source]["status"] == "ok" for source in sources[:3]))

            code, event, attention, state = attempt(resume=True)
            self.assertEqual(code, 0)
            self.assertEqual((event["type"], event["source"], event["reason"], event["count"]),
                             ("attention", "web-of-science", "login", 30))
            self.assertEqual(event["files"], ["candidates.json", "candidates.csv"])
            self.assertEqual((state["pending_source"], state["pending_reason"]), ("web-of-science", "login"))
            self.assertFalse(attention["discovery_complete"])
            self.assertEqual(attention["records"], first_thirty)
            self.assertEqual([row["candidate_id"] for row in read_csv_rows(output)], first_ids)

            code, event, complete, state = attempt(resume=True, scrape_current=True)
            self.assertEqual(code, 0)
            self.assertEqual((event["type"], event["count"]), ("result", 60))
            self.assertTrue(complete["discovery_complete"])
            self.assertIsNone(state["pending_source"])
            self.assertEqual(complete["records"][:30], first_thirty)
            self.assertEqual([record["candidate_id"] for record in complete["records"]][::10],
                             ["PMID-001", "SCOPUS-001", "WF-001", "WOS-001", "CNKI-001", "GSC-001"])
            self.assertEqual(len({record["candidate_id"] for record in complete["records"]}), 60)
            self.assertTrue(all(len(state["sources"][source]["results"]) == 10 for source in sources))
            self.assertEqual([call[0] for call in calls], sources[:4] + ["web-of-science", "web-of-science"] + sources[4:])
            self.assertEqual([call for call in calls if call[2]], [("web-of-science", queries["web-of-science"], True)])

            previous_calls = list(calls)
            code, event, repeated, _state = attempt(resume=True)
            self.assertEqual((code, event["count"]), (0, 60))
            self.assertEqual(calls, previous_calls, "重复继续不能再次检索已完成来源")
            self.assertEqual(repeated["records"], complete["records"], "同批次不得重复累计或换编号")

    def test_new_batch_has_new_checkpoint_and_preserves_old_batch(self) -> None:
        calls = []
        def browser_run(source, query, scrape_current, limit, year_from, year_to, **kwargs):
            calls.append(source)
            return {"status": "ok", "results": [{"title": "Repeated candidate", "year": 2020}]}
        config = {**CONFIG, "sources": ["cnki", "web-of-science"], "batch": {"size": 2, "maxBatches": 2}}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}), redirect_stdout(io.StringIO()):
            output = Path(temp)
            self.assertEqual(run(config, output), 0)
            self.assertEqual(run(config, output), 0)
            report = read_report(output)
            self.assertEqual([record["candidate_id"] for record in report["records"]], ["CNKI-001", "WOS-001", "CNKI-B2-001", "WOS-B2-001"])
        self.assertEqual(calls, ["cnki", "web-of-science", "cnki", "web-of-science"])

    def test_six_sources_keep_user_order_per_source_limit_pmid_and_transport(self) -> None:
        sources = ["pubmed", "scopus", "wanfang", "web-of-science", "cnki", "google-scholar"]
        calls = []
        def browser_run(source, query, scrape_current, limit, year_from, year_to, **kwargs):
            calls.append((source, query, limit))
            transport = "ncbi_eutilities" if source == "pubmed" else "browser"
            return {"status": "ok", "transport": transport,
                    "applied_filters": ["query", "publicationYearFrom", "publicationYearTo"],
                    "results": [{"title": f"{source} paper {index}", "year": 2020,
                                 "pmid": str(30000 + index) if source == "pubmed" else "",
                                 **({"transport": "pubmed_web"} if source == "pubmed" and index == 1 else {})}
                                for index in range(15)]}
        config = {**CONFIG, "sources": sources, "sourceQueries": {key: key + " confirmed terms" for key in sources}}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}), redirect_stdout(io.StringIO()):
            output = Path(temp)
            self.assertEqual(run(config, output), 0)
            report, rows = read_report(output), read_csv_rows(output)
        self.assertEqual(calls, [(source, source + " confirmed terms", 10) for source in sources])
        self.assertEqual(report["count"], 60)
        self.assertEqual([record["candidate_id"] for record in report["records"]][::10],
                         ["PMID-001", "SCOPUS-001", "WF-001", "WOS-001", "CNKI-001", "GSC-001"])
        self.assertEqual([record["source_key"] for record in report["records"]][::10], sources)
        self.assertEqual(report["records"][0]["pmid"], "30000")
        self.assertNotEqual(report["records"][0]["candidate_id"], report["records"][0]["pmid"])
        self.assertEqual(report["records"][0]["transport"], "ncbi_eutilities")
        self.assertEqual(report["records"][1]["transport"], "pubmed_web")
        self.assertEqual(report["source_status"]["pubmed"]["transport"], "ncbi_eutilities")
        self.assertEqual(rows[0]["pmid"], "30000")
        self.assertEqual(rows[0]["transport"], "ncbi_eutilities")
        self.assertEqual(rows[10]["transport"], "browser")

    def test_each_new_source_attention_resumes_original_batch_with_stable_ids(self) -> None:
        sources = ["google-scholar", "cnki", "web-of-science", "wanfang", "scopus", "pubmed"]
        prefixes = ["GSC", "CNKI", "WOS", "WF", "SCOPUS", "PMID"]
        for pause_source in ("wanfang", "scopus", "pubmed"):
            with self.subTest(source=pause_source):
                calls, paused = [], False
                def browser_run(source, query, scrape_current, limit, year_from, year_to, **kwargs):
                    nonlocal paused
                    calls.append((source, scrape_current))
                    transport = "ncbi_eutilities" if source == "pubmed" and not scrape_current else "browser"
                    if source == pause_source and not paused:
                        paused = True
                        return {"status": "attention", "reason": "login", "transport": "browser",
                                "message": "需要在官方页面手动处理"}
                    return {"status": "ok", "transport": transport, "results": [{"title": f"{source} heat study", "year": 2020,
                                     "pmid": "123456" if source == "pubmed" else ""}]}
                config = {**CONFIG, "sources": sources, "sourceQueries": {key: key + " frozen query" for key in sources}}
                with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser_run)}), redirect_stdout(io.StringIO()):
                    output = Path(temp)
                    self.assertEqual(run(config, output), 0)
                    report = read_report(output)
                    pause_index = sources.index(pause_source)
                    before = [record["candidate_id"] for record in report["records"]]
                    self.assertEqual(before, [prefix + "-001" for prefix in prefixes[:pause_index]])
                    self.assertFalse(report["discovery_complete"])
                    self.assertEqual(report["pending_source"], pause_source)
                    self.assertEqual(report["source_status"][pause_source]["transport"], "browser")
                    self.assertEqual(run(config, output, resume=True), 0)
                    complete = read_report(output)
                    self.assertTrue(complete["discovery_complete"])
                    self.assertEqual([record["candidate_id"] for record in complete["records"]], [prefix + "-001" for prefix in prefixes])
                    self.assertEqual(complete["records"][:pause_index], report["records"], "已完成来源元数据和编号保持不变")
                    self.assertEqual(complete["records"][-1]["pmid"], "123456")
                    self.assertEqual(read_csv_rows(output)[-1]["pmid"], "123456")
                    self.assertEqual(complete["source_status"]["pubmed"]["transport"], "browser" if pause_source == "pubmed" else "ncbi_eutilities")
                    self.assertEqual([call[0] for call in calls], sources[:pause_index + 1] + sources[pause_index:])
                    self.assertEqual([call for call in calls if call[1]], [(pause_source, True)])
                    count = len(calls)
                    self.assertEqual(run(config, output, resume=True), 0)
                    self.assertEqual(len(calls), count)

    def test_new_sources_second_batch_ids_and_legacy_optional_fields(self) -> None:
        raw = [{"title": source, "source_key": source, "pmid": "123" if source == "pubmed" else "",
                "transport": "ncbi_eutilities" if source == "pubmed" else "browser"}
               for source in ("wanfang", "scopus", "pubmed")]
        records = normalize_candidates(raw, "q", "now", batch_index=2)
        self.assertEqual([record["candidate_id"] for record in records], ["WF-B2-001", "SCOPUS-B2-001", "PMID-B2-001"])
        self.assertEqual(records[-1]["pmid"], "123")
        legacy = normalize_candidates([{"title": "old"}], "q", "now")[0]
        self.assertEqual((legacy["pmid"], legacy["transport"]), ("", ""))

    def test_new_source_date_postfilter_unknown_year_and_metadata_whitelist(self) -> None:
        for source in ("wanfang", "scopus", "pubmed"):
            with self.subTest(source=source):
                search = {"status": "ok", "transport": "browser", "applied_filters": ["query"], "results": [
                    {"title": "old", "year": 2014, "pmid": "111"},
                    {"title": "known", "year": "2020-03-15", "pmid": "222", "cookies": "private", "browser_state": "private"},
                    {"title": "unknown", "year": "2019-2021", "byline": "Author - Journal, 2019-2021", "pmid": "333"},
                    {"title": "unsafe metadata", "pmid": "token=private", "transport": "https://user:private@proxy"},
                ]}
                filtered = filtered_source_results(search, CONFIG, source, "q")
                records = normalize_candidates(filtered["results"], "q", "now", source_key=source)
                self.assertEqual([record["title"] for record in records], ["known", "unknown", "unsafe metadata"])
                self.assertIsNone(records[1]["year"])
                self.assertEqual(records[0]["pmid"], "222")
                self.assertEqual(records[2]["pmid"], "")
                self.assertEqual(records[2]["transport"], "browser")
                self.assertNotIn("private", json.dumps(filtered))
                self.assertEqual(filtered["year_filtering"]["unknown_year_retained"], 2)
                self.assertIn("unknown_publication_year_review", filtered["deferred_rules"])


if __name__ == "__main__":
    unittest.main()
