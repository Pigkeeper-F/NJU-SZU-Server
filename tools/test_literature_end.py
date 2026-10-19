"""End-of-accessible-results discovery has no candidate-count stop condition."""
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
from test_literature_paging import page, rows, report


CONFIG = {"topic": "end-of-results verification", "query": "heat stress", "sources": ["pubmed"],
          "limit": 10, "searchMode": "formal", "stopMode": "end", "perSourceLimit": None}


class EndOfResultsTests(unittest.TestCase):
    def execute(self, root, browser, config=None, **kwargs):
        output = io.StringIO()
        with patch.dict(sys.modules, {"literature_browser": types.SimpleNamespace(run=browser)}), redirect_stdout(output):
            code = run(config or CONFIG, root, **kwargs)
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_more_than_1000_candidates_are_saved_until_explicit_end(self):
        visited = []

        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            visited.append(index)
            return page(index, rows(index * 200, 200 if index < 6 else 5), index < 6, total_count=1205)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, events = self.execute(root, browser)
            data = report(root)
            self.assertEqual(code, 0)
            self.assertEqual(data["count"], 1205)
            self.assertEqual(visited, list(range(7)))
            self.assertEqual(data["scope"], "accessible_pages_until_end")
            self.assertTrue(data["discovery_complete"])
            self.assertEqual(data["source_status"]["pubmed"]["stop_reason"], "exhausted")
            self.assertIsNone(data["run_config"]["perSourceLimit"])
            self.assertNotIn("/None", json.dumps(events, ensure_ascii=False))
            self.assertIn("可访问末页", events[-1]["message"])

    def test_unknown_next_and_network_failures_pause_without_losing_page(self):
        for failure in ({"status": "attention", "reason": "login", "message": "Please sign in"},
                        {"status": "error", "message": "Network unavailable"},
                        page(1, rows(10, 10), None)):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)

                def browser(*args, **kwargs):
                    return page(0, rows(0, 10), True) if kwargs["page_index"] == 0 else failure

                code, events = self.execute(root, browser)
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertGreaterEqual(report(root)["count"], 10)
                self.assertFalse(report(root)["discovery_complete"])

    def test_login_resume_preserves_rows_id_and_uses_original_waiting_page(self):
        pause, calls = True, []

        def browser(source, query, current, *args, **kwargs):
            nonlocal pause
            index = kwargs["page_index"]
            calls.append((index, current))
            if index == 1 and pause:
                pause = False
                return {"status": "attention", "reason": "login"}
            return page(index, rows(index * 10, 10), index == 0)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.execute(root, browser)
            previous = copy.deepcopy(report(root)["records"])
            self.execute(root, browser, resume=True)
            self.assertEqual(calls, [(0, False), (1, False), (1, True)])
            self.assertEqual(report(root)["records"][:10], previous)
            self.assertEqual(report(root)["count"], 20)
            self.assertTrue(report(root)["discovery_complete"])

    def test_source_access_limit_saves_current_page_but_never_claims_end(self):
        def browser(*args, **kwargs):
            return page(0, rows(0, 10), False, source_limit_reached=True,
                        source_limit_message="Source exposes only the first results; split this query.")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, events = self.execute(root, browser)
            self.assertEqual(report(root)["count"], 10)
            self.assertFalse(report(root)["discovery_complete"])
            self.assertEqual(events[-1]["type"], "attention")
            self.assertNotEqual(report(root)["source_status"]["pubmed"]["stop_reason"], "exhausted")

    def test_end_resume_can_cross_the_previous_1000_page_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = {"version": 2, "config_fingerprint": config_fingerprint(CONFIG), "batch_index": 1,
                     "pending_source": "pubmed", "pending_reason": None,
                     "sources": {"pubmed": {"status": "running", "query": CONFIG["query"],
                        "url": "", "results": rows(0, 1), "applied_filters": ["query"], "deferred_rules": [],
                        "pages": [{"page_index": 999, "fingerprint": "prior", "returned": 1}], "next_page": 1000,
                        "pages_fetched": 1, "retrieved_count": 1, "count": 1, "total_count": None, "stop_reason": None}}}
            (root / "discovery-state.json").write_text(json.dumps(state), encoding="utf-8")
            visited = []

            def browser(*args, **kwargs):
                visited.append(kwargs["page_index"])
                return page(1000, rows(1, 1), False)

            self.execute(root, browser, resume=True)
            self.assertEqual(visited, [1000])
            self.assertEqual(report(root)["count"], 2)
            self.assertTrue(report(root)["discovery_complete"])

    def test_legacy_count_fingerprint_is_unchanged_and_end_is_distinct(self):
        legacy = {key: value for key, value in CONFIG.items() if key != "stopMode"}
        legacy["perSourceLimit"] = 25
        self.assertEqual(config_fingerprint(legacy), config_fingerprint({**legacy, "stopMode": "count"}))
        self.assertNotEqual(config_fingerprint(legacy), config_fingerprint(CONFIG))
        validate_config(CONFIG)
        for bad in ({**CONFIG, "stopMode": "all"}, {**CONFIG, "searchMode": "test", "perSourceLimit": 10},
                    {**CONFIG, "perSourceLimit": 1000}):
            with self.assertRaises(ValueError):
                validate_config(bad)


if __name__ == "__main__":
    unittest.main()
