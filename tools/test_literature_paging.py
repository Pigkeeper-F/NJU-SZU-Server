"""Formal discovery: real aggregation/checkpoints, mocked source pages only."""
from contextlib import redirect_stdout
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from literature_search import config_fingerprint, run, validate_config


CONFIG = {"topic": "pagination test", "query": "heat stress", "sources": ["pubmed"],
          "limit": 10, "searchMode": "formal", "perSourceLimit": 25}


def rows(start, count, year=2020):
    return [{"title": f"Paper {i}", "year": year, "pmid": str(i + 1000),
             "result_url": f"https://pubmed.ncbi.nlm.nih.gov/{i + 1000}/"}
            for i in range(start, start + count)]


def page(index, records, has_next, **extra):
    return {"status": "ok" if records else "no_results", "page_index": index,
            "results": records, "has_next": has_next, "transport": "ncbi_eutilities",
            "url": "https://pubmed.ncbi.nlm.nih.gov/", **extra}


def report(root):
    return json.loads((root / "candidates.json").read_text(encoding="utf-8"))


class FormalPagingTests(unittest.TestCase):
    def execute(self, config, root, browser, **kwargs):
        output = io.StringIO()
        with patch("literature_search.injected_source_runner", browser), redirect_stdout(output):
            code = run(config, root, **kwargs)
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_formal_three_pages_stops_exactly_at_25(self):
        calls = []

        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            calls.append((index, kwargs["full_page"], args[3]))
            return page(index, rows(index * 10, 10), True, total_count=500)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, events = self.execute(CONFIG, root, browser)
            self.assertEqual(code, 0)
            data = report(root)
            self.assertEqual(calls, [(0, True, 10), (1, True, 10), (2, True, 10)])
            self.assertEqual(data["count"], 25)
            self.assertEqual(data["records"][-1]["candidate_id"], "PMID-025")
            self.assertTrue(data["discovery_complete"])
            self.assertEqual(data["scope"], "paged_candidates_up_to_source_limit")
            detail = data["source_status"]["pubmed"]
            self.assertEqual((detail["pages_fetched"], detail["retrieved_count"], detail["count"], detail["total_count"]), (3, 30, 25, 500))
            self.assertEqual(detail["stop_reason"], "limit_reached")
            self.assertIn("25/25", events[-1]["message"])

    def test_native_20_record_page_does_not_skip_middle_records(self):
        config = {**CONFIG, "sources": ["wanfang"]}
        calls = []

        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            calls.append(index)
            return page(index, rows(index * 20, 20), True)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(self.execute(config, root, browser)[0], 0)
            self.assertEqual(calls, [0, 1])
            self.assertEqual([r["title"] for r in report(root)["records"]], [f"Paper {i}" for i in range(25)])

    def test_same_source_page_two_login_keeps_page_one_and_resumes_exact_page(self):
        calls, pause = [], True

        def browser(source, query, current, *args, **kwargs):
            nonlocal pause
            index = kwargs["page_index"]
            calls.append((index, current))
            if index == 1 and pause:
                pause = False
                return {"status": "attention", "reason": "login", "message": "Login required"}
            return page(index, rows(index * 10, 10), True)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(self.execute(CONFIG, root, browser)[0], 0)
            partial = report(root)
            self.assertEqual(partial["count"], 10)
            self.assertFalse(partial["discovery_complete"])
            original = copy.deepcopy(partial["records"])
            self.assertEqual(self.execute(CONFIG, root, browser, resume=True)[0], 0)
            self.assertEqual(calls, [(0, False), (1, False), (1, True), (2, False)])
            self.assertEqual(report(root)["records"][:10], original)
            self.assertEqual(report(root)["count"], 25)

    def test_deferred_formal_source_keeps_pages_and_resumes_exact_page(self):
        for stop_mode in ("count", "end"):
            with self.subTest(stop_mode=stop_mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = {**CONFIG, "sources": ["web-of-science", "scopus"], "stopMode": stop_mode,
                          "perSourceLimit": None if stop_mode == "end" else 25}
                frozen = json.dumps(config).encode("utf-8")
                (root / "run_config.json").write_bytes(frozen)
                calls, available = [], False

                def browser(source, query, current, *args, **kwargs):
                    index = kwargs["page_index"]
                    calls.append((source, index, current))
                    if source == "scopus":
                        return page(index, rows(100, 10), False)
                    if index == 1 and not available:
                        return {"status": "attention", "reason": "login", "message": "WOS login required"}
                    return page(index, rows(index * 10, 5 if index == 2 else 10), index < 2)

                _, events = self.execute(config, root, browser)
                original = copy.deepcopy(report(root)["records"])
                self.assertEqual((events[-1]["type"], len(original)), ("attention", 10))
                state_path = root / "discovery-state.json"
                checkpoint = json.loads(state_path.read_text(encoding="utf-8"))
                pending_page = copy.deepcopy(checkpoint["sources"]["web-of-science"])
                self.assertEqual((pending_page["next_page"], pending_page["pages_fetched"]), (1, 1))

                code, events = self.execute(config, root, browser, resume=True, defer_source="web-of-science")
                self.assertEqual(code, 0)
                self.assertEqual((events[-1]["type"], events[-1]["source"], events[-1]["count"]), ("attention", "web-of-science", 20))
                self.assertFalse(any(event["type"] == "result" for event in events))
                self.assertTrue(all(event["deferred_sources"] == ["web-of-science"] for event in events))
                checkpoint = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual(checkpoint["sources"]["web-of-science"], pending_page)
                self.assertEqual(checkpoint["deferred_sources"], ["web-of-science"])
                self.assertFalse(report(root)["discovery_complete"])
                twenty = {row["candidate_id"]: row for row in report(root)["records"]}
                before_calls = list(calls)
                self.execute(config, root, browser, resume=True, defer_source="web-of-science")
                self.assertEqual(calls, before_calls, "仅剩暂缓来源时不能自动重试")
                self.assertEqual(json.loads(state_path.read_text(encoding="utf-8"))["sources"]["web-of-science"], pending_page)

                available = True
                code, events = self.execute(config, root, browser, resume=True)
                self.assertEqual((code, events[-1]["type"], events[-1]["count"]), (0, "result", 35))
                complete = report(root)
                self.assertTrue(complete["discovery_complete"])
                self.assertEqual(complete["deferred_sources"], [])
                self.assertEqual(complete["records"][:10], original)
                self.assertTrue(all(row in complete["records"] for row in twenty.values()))
                self.assertEqual(calls, [("web-of-science", 0, False), ("web-of-science", 1, False),
                                         ("scopus", 0, False), ("web-of-science", 1, True), ("web-of-science", 2, False)])
                checkpoint = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual(checkpoint["config_fingerprint"], config_fingerprint(config))
                self.assertEqual(checkpoint["batch_index"], 1)
                self.assertEqual((root / "run_config.json").read_bytes(), frozen)
                self.assertEqual(complete["source_status"]["web-of-science"]["stop_reason"],
                                 "exhausted" if stop_mode == "end" else "limit_reached")

    def test_invalid_formal_defer_keeps_all_saved_page_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def browser(*args, **kwargs):
                index = kwargs["page_index"]
                return page(0, rows(0, 10), True) if index == 0 else {"status": "attention", "reason": "login"}
            self.execute(CONFIG, root, browser)
            before = {path.name: path.read_bytes() for path in root.iterdir()}
            for options in ({"defer_source": "pubmed"}, {"resume": True, "defer_source": "cnki"}):
                with self.subTest(options=options):
                    code, _ = self.execute(CONFIG, root, lambda *args, **kwargs: self.fail("invalid defer launched browser"), **options)
                    self.assertEqual(code, 1)
                    self.assertEqual({path.name: path.read_bytes() for path in root.iterdir()}, before)

    def test_mid_page_technical_failure_retry_preserves_checkpoint(self):
        fail = True

        def browser(*args, **kwargs):
            nonlocal fail
            index = kwargs["page_index"]
            if index == 1 and fail:
                fail = False
                return {"status": "error", "message": "Network unavailable"}
            return page(index, rows(index * 10, 10), True)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(self.execute(CONFIG, root, browser)[0], 1)
            self.assertEqual(report(root)["count"], 10)
            self.assertEqual(self.execute(CONFIG, root, browser, resume=True)[0], 0)
            self.assertEqual(report(root)["count"], 25)

    def test_repeated_page_is_attention_and_never_adds_duplicates(self):
        def browser(*args, **kwargs):
            return page(kwargs["page_index"], rows(0, 10), True)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, events = self.execute(CONFIG, root, browser)
            self.assertEqual(report(root)["count"], 10)
            self.assertFalse(report(root)["discovery_complete"])
            self.assertEqual(events[-1]["type"], "attention")
            self.assertIn("重复", events[-1]["message"])

    def test_end_before_target_is_honest_and_empty_result_is_valid(self):
        for last_count in (0, 3):
            with self.subTest(count=last_count), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)

                def browser(*args, **kwargs):
                    return page(0, rows(0, last_count), False, total_count=last_count)

                _, events = self.execute(CONFIG, root, browser)
                data = report(root)
                self.assertEqual(data["count"], last_count)
                self.assertTrue(data["discovery_complete"])
                self.assertEqual(data["source_status"]["pubmed"]["stop_reason"], "exhausted")
                self.assertIn("已到末页", events[-1]["message"])

    def test_unknown_next_saves_page_then_pauses_not_complete(self):
        def browser(*args, **kwargs):
            return page(0, rows(0, 10), None)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, events = self.execute(CONFIG, root, browser)
            self.assertEqual(report(root)["count"], 10)
            self.assertFalse(report(root)["discovery_complete"])
            self.assertEqual(events[-1]["reason"], "results_unrecognized")

    def test_explicit_exhausted_empty_ok_page_finishes_existing_records(self):
        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            return page(0, rows(0, 10), True) if index == 0 else {"status": "ok", "results": [], "page_index": 1, "has_next": False}

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.execute(CONFIG, root, browser)
            self.assertEqual(report(root)["count"], 10)
            self.assertTrue(report(root)["discovery_complete"])
            self.assertEqual(report(root)["source_status"]["pubmed"]["stop_reason"], "exhausted")

    def test_pubmed_transport_cannot_switch_page_size_mid_source(self):
        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            return page(index, rows(index * 10, 10), True,
                        transport="browser_after_api_error" if index else "ncbi_eutilities")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, events = self.execute(CONFIG, root, browser)
            self.assertEqual(code, 1)
            self.assertEqual(report(root)["count"], 10)
            self.assertFalse(report(root)["discovery_complete"])
            self.assertIn("获取方式发生变化", events[-1]["message"])

    def test_filtering_and_source_local_duplicates_do_not_fill_target(self):
        config = {**CONFIG, "perSourceLimit": 3, "publicationYearFrom": 2015, "publicationYearTo": 2024}

        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            data = rows(0, 1, 2010) + rows(1, 1) if index == 0 else rows(1, 3)
            return page(index, data, index == 0)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.execute(config, root, browser)
            self.assertEqual([r["title"] for r in report(root)["records"]], ["Paper 1", "Paper 2", "Paper 3"])

    def test_completed_source_not_researched_after_next_source_login(self):
        config = {**CONFIG, "perSourceLimit": 2, "sources": ["pubmed", "scopus"]}
        calls, paused = [], True

        def browser(source, query, current, *args, **kwargs):
            nonlocal paused
            calls.append((source, kwargs["page_index"], current))
            if source == "scopus" and paused:
                paused = False
                return {"status": "attention", "reason": "verification"}
            return page(0, rows(0, 2), False)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.execute(config, root, browser)
            self.execute(config, root, browser, resume=True)
            self.assertEqual(calls, [("pubmed", 0, False), ("scopus", 0, False), ("scopus", 0, True)])
            self.assertEqual(report(root)["count"], 4)

    def test_mode_and_target_are_frozen_but_old_fingerprint_unchanged(self):
        old = {key: value for key, value in CONFIG.items() if key not in ("searchMode", "perSourceLimit")}
        self.assertEqual(config_fingerprint(old), config_fingerprint({**old, "sourceQueries": {}}))
        self.assertNotEqual(config_fingerprint(CONFIG), config_fingerprint({**CONFIG, "perSourceLimit": 26}))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.execute(CONFIG, root, lambda *a, **k: page(0, rows(0, 10), None))
            code, events = self.execute({**CONFIG, "perSourceLimit": 26}, root, lambda *a, **k: self.fail("must not search"), resume=True)
            self.assertEqual(code, 1)
            self.assertIn("配置已更改", events[-1]["message"])

    def test_invalid_modes_and_quantities_are_rejected(self):
        for update in ({"searchMode": "all"}, {"perSourceLimit": 0}, {"perSourceLimit": 1001},
                       {"perSourceLimit": True}, {"perSourceLimit": 1.5}, {"searchMode": "test"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate_config({**CONFIG, **update})
        validate_config({**CONFIG, "searchMode": "test", "perSourceLimit": 10})


if __name__ == "__main__":
    unittest.main()
