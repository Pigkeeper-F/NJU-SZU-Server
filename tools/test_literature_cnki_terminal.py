"""CNKI final-page DOM and saved-page recovery; no network/browser activity."""
import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import literature_browser as browser
import test_literature_native_queries as native_fixtures
import test_literature_end as end_fixtures
from test_literature_extra_sources import dom_snapshot
from test_literature_native_queries import QUERIES
from test_literature_paging import page, rows, report


def end_pagination(number=2):
    return {"has_next": False, "total_count": 2, "page_number": number, "total_pages": number,
            "end_evidence": {"kind": "page_count", "selector": ".countPageMark",
                             "page_number": number, "total_pages": number}}


class CNKITerminalPaginationTests(unittest.TestCase):
    def pagination(self, marks, *, disabled=None, total="共 3,814 条", hidden=False):
        nodes = {"count": {"text": total}}
        nodes.update({f"mark{i}": {"text": value, "hidden": hidden} for i, value in enumerate(marks)})
        metadata = dom_snapshot("cnki", nodes,
            {".pagerTitleCell": ["count"], ".countPageMark": [f"mark{i}" for i in range(len(marks))]},
            script=browser._PAGINATION_JS)
        source_page = types.SimpleNamespace(evaluate=lambda *args: metadata)
        with patch.object(browser, "_next_control", return_value=None if disabled is None else object()), \
                patch.object(browser, "_control_disabled", return_value=disabled):
            return browser._pagination(source_page, "cnki")

    def test_visible_191_of_191_proves_end_without_next(self):
        result = self.pagination(["191 / 191"])
        self.assertIs(result["has_next"], False)
        self.assertEqual(result["total_count"], 3814)
        self.assertEqual(result["end_evidence"], end_pagination(191)["end_evidence"])

    def test_nonfinal_or_missing_mark_never_uses_total_to_infer_end(self):
        for marks in ([], ["190 / 191"]):
            with self.subTest(marks=marks):
                self.assertIsNone(self.pagination(marks)["has_next"])

    def test_invalid_ambiguous_and_hidden_page_marks_do_not_prove_end(self):
        for marks in (["0 / 0"], ["192 / 191"], ["191"], ["191 / 191", "191 / 191"],
                      ["191 / 191", "190 / 191"], ["9007199254740992 / 9007199254740992"]):
            with self.subTest(marks=marks):
                self.assertIsNone(self.pagination(marks)["has_next"])
        self.assertIsNone(self.pagination(["191 / 191"], hidden=True)["has_next"])

    def test_contradictory_next_control_keeps_end_unknown(self):
        self.assertIsNone(self.pagination(["191 / 191"], disabled=False)["has_next"])
        self.assertIsNone(self.pagination(["190 / 191"], disabled=True)["has_next"])

    def test_disabled_next_remains_independent_positive_evidence(self):
        result = self.pagination([], disabled=True)
        self.assertIs(result["has_next"], False)
        self.assertEqual(result["end_evidence"], {"kind": "disabled_next"})


class CNKITerminalNativeTests(unittest.TestCase):
    setUp = native_fixtures.NativeFlowTests.setUp
    call = native_fixtures.NativeFlowTests.call
    binding = native_fixtures.NativeFlowTests.binding
    cnki_without_summary = native_fixtures.NativeFlowTests.cnki_without_summary

    def prepare_last_page(self):
        self.cnki_without_summary()
        self.assertEqual(self.call()["status"], "ok")
        self.assertEqual(self.call(page_index=1)["status"], "ok")
        self.before = copy.deepcopy(self.binding())
        self.pager = patch.object(browser, "_pagination", return_value=end_pagination())
        self.pager.start()
        self.addCleanup(self.pager.stop)

    def test_saved_last_page_recheck_never_clicks_submits_or_rebinds(self):
        self.prepare_last_page()
        result = self.call(page_index=2)
        self.assertEqual(result["status"], "ok", result)
        self.assertIs(result["has_next"], False)
        proof = result["terminal_page_verified"]
        self.assertEqual(proof["page_index"], 1)
        self.assertEqual(proof["result_fingerprint"], self.before["result_fingerprint"])
        self.assertEqual(proof["pagination"], end_pagination()["end_evidence"])
        self.assertEqual(result["results"][0]["title"], "Native page 1")
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 1))
        self.assertEqual(self.binding(), self.before)

    def assert_terminal_refused(self, expected_reason="results_unrecognized"):
        result = self.call(page_index=2)
        self.assertEqual((result["status"], result["reason"]), ("attention", expected_reason))
        self.assertNotIn("terminal_page_verified", result)
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 1))
        self.assertEqual(self.binding(), self.before)

    def test_changed_query_is_not_terminal_proof(self):
        self.prepare_last_page()
        self.page.native["editor"]["value"] += " OR TI=('其他条件')"
        self.assert_terminal_refused()

    def test_changed_dates_are_not_terminal_proof(self):
        self.prepare_last_page()
        self.page.native["years"][0]["value"] = "2000-02-01"
        self.assert_terminal_refused()

    def test_changed_rows_are_not_terminal_proof(self):
        self.prepare_last_page()
        self.page.dom["results"][0]["title"] = "Changed page"
        self.assert_terminal_refused()

    def test_access_block_is_not_terminal_proof(self):
        self.prepare_last_page()
        self.page.block = "captcha"
        self.assert_terminal_refused("verification")

    def test_missing_original_tab_does_not_create_or_rebind(self):
        self.prepare_last_page()
        self.pages.clear()
        self.assert_terminal_refused()
        self.assertEqual(self.pages, [])

    def test_unverified_end_or_wrong_page_cannot_close_saved_page(self):
        self.prepare_last_page()
        for pagination in ({"has_next": False, "total_count": 2}, end_pagination(3)):
            with self.subTest(pagination=pagination), patch.object(browser, "_pagination", return_value=pagination):
                self.assert_terminal_refused()

    def test_fresh_terminal_page_has_false_next_without_recovery_marker(self):
        self.prepare_last_page()
        result = self.call(page_index=1)
        self.assertEqual(result["status"], "ok")
        self.assertIs(result["has_next"], False)
        self.assertNotIn("terminal_page_verified", result)


class CNKITerminalDiscoveryTests(unittest.TestCase):
    execute = end_fixtures.EndOfResultsTests.execute
    config = {**end_fixtures.CONFIG, "sources": ["cnki"], "query": QUERIES["cnki"]}

    def seed_paused_last(self, root):
        self.execute(root, lambda *args, **kwargs: page(0, rows(0, 14), None, total_count=14), self.config)
        return json.loads((root / "discovery-state.json").read_text(encoding="utf-8"))

    def recovery(self):
        return page(1, rows(0, 14), False, total_count=14,
            diagnostics={"native_execution_verified": True},
            terminal_page_verified={"source": "cnki", "page_index": 0, "result_fingerprint": "a" * 64,
                "pagination": end_pagination(1)["end_evidence"]})

    def test_verified_recovery_keeps_page_ledger_counts_and_records_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = self.seed_paused_last(root)["sources"]["cnki"]
            previous = copy.deepcopy(report(root)["records"])
            calls = []
            def recover(*args, **kwargs):
                calls.append(kwargs["page_index"])
                return self.recovery()
            _, events = self.execute(root, recover, self.config, resume=True)
            new = json.loads((root / "discovery-state.json").read_text(encoding="utf-8"))["sources"]["cnki"]
            for key in ("pages", "pages_fetched", "next_page", "retrieved_count", "count", "results"):
                self.assertEqual(new[key], old[key], key)
            self.assertEqual(report(root)["records"], previous)
            self.assertTrue(report(root)["discovery_complete"])
            self.assertEqual(new["stop_reason"], "exhausted")
            self.assertEqual(calls, [1])
            self.assertEqual(events[-1]["type"], "result")
            self.execute(root, recover, self.config, resume=True)
            self.assertEqual(calls, [1], "Completed source must not rerun")

    def test_bad_terminal_proof_cannot_turn_saved_count_into_completion(self):
        for case in ("rows", "page", "evidence", "missing_evidence", "fingerprint", "native", "has_next", "source_limit"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                old = self.seed_paused_last(root)["sources"]["cnki"]
                result = self.recovery()
                proof = result["terminal_page_verified"]
                if case == "rows": result["results"][0]["title"] = "Different article"
                elif case == "page": proof["page_index"] = 1
                elif case == "evidence": proof["pagination"]["total_pages"] = 2
                elif case == "missing_evidence": proof["pagination"] = {}
                elif case == "fingerprint": proof["result_fingerprint"] = ""
                elif case == "native": result["diagnostics"] = {}
                elif case == "has_next": result["has_next"] = None
                elif case == "source_limit": result["source_limit_reached"] = True
                _, events = self.execute(root, lambda *args, **kwargs: result, self.config, resume=True)
                new = json.loads((root / "discovery-state.json").read_text(encoding="utf-8"))["sources"]["cnki"]
                self.assertEqual(events[-1]["type"], "attention")
                self.assertFalse(report(root)["discovery_complete"])
                for key in ("pages", "pages_fetched", "next_page", "retrieved_count", "count", "results"):
                    self.assertEqual(new[key], old[key], key)


if __name__ == "__main__":
    unittest.main()
