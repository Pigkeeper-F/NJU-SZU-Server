"""Source pause/readiness regressions; local DOM and task-directory fixtures only."""
from contextlib import contextmanager, redirect_stdout
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_browser as adapter
import test_literature_browser as fixtures
from test_literature_extra_sources import dom_snapshot


class SourceAccessWaitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="source-access-wait-")
        self.addCleanup(self.temporary.cleanup)
        self.job = Path(self.temporary.name)
        self.context = fixtures.Context(fixtures.snapshot(results=[fixtures.ROW], resultContainer=True))

        @contextmanager
        def runtime():
            yield self.context

        self.runtime_patch = patch.object(adapter, "_runtime", runtime)
        self.runtime_patch.start()
        self.addCleanup(self.runtime_patch.stop)

    def call(self, source="cnki", resume=False, **kwargs):
        return adapter.run(source, fixtures.QUERY, resume, 10, job_dir=self.job, **kwargs)

    def paged(self, count=3):
        pages = [fixtures.snapshot(results=[{**fixtures.ROW, "title": f"Page {n} row {i}"}
                 for i in range(20)], resultContainer=True, visible_result_count=20) for n in range(count)]
        page = fixtures.PagedPage(pages)
        page.target = f"paged-access-{len(self.context.pages)}"
        self.context.pages.append(page)
        adapter._save_binding(self.job, "cnki", page.target)
        return page

    def binding(self):
        return (self.job / "browser-tabs.json").read_bytes()

    def test_foreground_rate_limits_and_access_blocks_are_distinct(self):
        for source in ("google-scholar", "cnki", "wanfang", "web-of-science", "scopus"):
            for text, marker, reason in (
                    ("HTTP 429 Too Many Requests. Please try again later.", "rateLimited", "rate_limited"),
                    ("您的访问过于频繁，请稍后再试", "rateLimited", "rate_limited"),
                    ("Access denied. Your request has been blocked.", "accessBlocked", "access_blocked")):
                with self.subTest(source=source, text=text):
                    state = dom_snapshot(source, head=text, script=adapter._ACCESS_STATE_JS)
                    self.assertTrue(state[marker])
                    page = fixtures.Page("status", {})
                    self.assertEqual(adapter._auth_reason(page, state), reason)

    def test_visible_loader_only_and_bibliographic_rate_word_is_not_a_block(self):
        state = dom_snapshot("scopus", {"spinner": {"hidden": True}},
            {'.loading-overlay': ["spinner"]}, head="Rate limiting in animal metabolism",
            script=adapter._ACCESS_STATE_JS)
        self.assertFalse(any(state.values()))
        state = dom_snapshot("scopus", {"spinner": {}}, {'.loading-overlay': ["spinner"]},
            script=adapter._ACCESS_STATE_JS)
        self.assertTrue(state["resultsLoading"])

    def test_common_status_probe_is_applied_to_extra_source_snapshot(self):
        page = fixtures.Page("source", fixtures.snapshot(rateLimited=True))
        with patch.object(adapter.extra_sources, "snapshot", return_value=fixtures.snapshot()):
            state = adapter._snapshot(page, "wanfang", 200)
        self.assertTrue(state["rateLimited"])
        self.assertEqual(adapter._auth_reason(page, state), "rate_limited")

    def test_native_query_cannot_reuse_legacy_basic_result_binding(self):
        before = b'{"scopus":{"target_id":"old-basic","page_index":4}}'
        (self.job / "browser-tabs.json").write_bytes(before)
        for source, query in (("scopus", 'TITLE-ABS(cattle) AND AUTHKEY(methane) AND PUBYEAR AFT 1999'),
                              ("wanfang", '主题:(牛 OR 羊) AND 题名或关键词:(温度)'),
                              ("web-of-science", 'TI=(cattle) AND AK=(methane) AND DOP=2000-01-01/2026-10-31'),
                              ("cnki", "TKA=('牛'+'羊') AND TI=('气温')")):
            with self.subTest(source=source), patch.object(adapter, "_runtime", side_effect=AssertionError("Must not open browser")):
                result = adapter.run(source, query, True, 10, job_dir=self.job, page_index=4, full_page=True)
            self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
            self.assertTrue(result["diagnostics"]["native_query_required"])
            self.assertFalse(result["diagnostics"]["advanced_form_verified"])
            self.assertEqual(result["results"], [])
            self.assertIsNone(result["has_next"])
            self.assertIn("导出题录后导入", result["message"])
            self.assertEqual(self.binding(), before)

    def test_open_source_for_native_query_opens_home_without_executing_it(self):
        for source, query in (("wanfang", "主题:(肉鸡) AND 题名:(热应激)"),
                              ("scopus", "TITLE-ABS(cattle) AND PUBYEAR AFT 1999"),
                              ("web-of-science", "TI=(cattle) AND AB=(methane)"),
                              ("cnki", "TKA=('肉鸡') AND TI=('热应激')")):
            with self.subTest(source=source):
                config = {"sources": [source], "sourceQueries": {source: query}}
                (self.job / "run_config.json").write_text(json.dumps(config), encoding="utf-8")
                (self.job / "discovery-state.json").write_text(json.dumps({"pending_source": source}), encoding="utf-8")
                with patch.object(adapter, "_navigate_search", side_effect=AssertionError("Must not submit native query")):
                    result = adapter.open_source(source, job_dir=self.job)
                self.assertTrue(result["opened"])
                self.assertIn("未自动提交检索式", result["message"])
                self.assertEqual(self.context.pages[-1].navigations, [adapter.SOURCES[source][1]])
                self.assertEqual(self.context.pages[-1].clicked, 0)

    def test_wos_and_cnki_internal_native_entry_points_stop_before_dom_or_navigation(self):
        page = fixtures.Page("no-native-submit", fixtures.snapshot())
        page.has_form = True
        queries = {
            "web-of-science": ['TI=(cattle) AND AK=(heat)', 'TS=(cattle) AND PY=2026', 'TS=(cattle) OR TS=(fish)', '#1 AND #2'],
            "cnki": ["TKA=('牛') AND TI=('温度')", "SU='热应激'", "YE>=2020 AND KY='奶牛'"]}
        with patch.object(adapter, "_snapshot", side_effect=AssertionError("No DOM read should be needed")):
            for source, expressions in queries.items():
                for query in expressions:
                    with self.subTest(source=source, query=query):
                        self.assertFalse(adapter._navigate_search(page, source, query, 2000, 2026))
                        if source == "web-of-science":
                            self.assertFalse(adapter._submit_wos(page, query))
        self.assertEqual(page.navigations, [])
        self.assertEqual(page.clicked, 0)
        self.assertEqual(page.filled, "")

    def test_plain_cnki_and_single_wos_topic_wrapper_keep_verified_basic_mapping(self):
        page = fixtures.Page("plain-basic", fixtures.snapshot())
        self.assertTrue(adapter._navigate_search(page, "cnki", "肉鸡 热应激", 2000, 2026))
        self.assertIn("korder=SU", page.url)
        for query, expected in [('TS=(cattle AND (heat OR cold))', 'cattle AND (heat OR cold)'),
                                ('TS=("TI=(literal)" OR heat*)', '"TI=(literal)" OR heat*'),
                                ('cattle heat', 'cattle heat')]:
            with self.subTest(query=query):
                page.has_form = True
                with patch.object(adapter, "_snapshot", return_value=fixtures.snapshot()):
                    self.assertTrue(adapter._submit_wos(page, query))
                self.assertEqual(page.filled, expected)

    def test_all_eight_confirmed_native_forms_use_dedicated_native_adapter(self):
        catalog = json.loads((Path(__file__).resolve().parents[1] / "config" / "confirmed-climate-research.json").read_text(encoding="utf-8"))
        entries = [entry for entry in catalog["entries"] if entry["source"] != "google-scholar"]
        self.assertEqual(len(entries), 8)
        sentinel = {"status": "attention", "reason": "results_unrecognized", "results": []}
        with patch.object(adapter.native_queries, "run", return_value=sentinel) as native_run, \
                patch.object(adapter, "_navigate_search", side_effect=AssertionError("Native queries must not use basic search")):
            for entry in entries:
                with self.subTest(preset=entry["id"]):
                    result = adapter.run(entry["source"], entry["query"], False, 10, job_dir=self.job)
                    self.assertIs(result, sentinel)
                    self.assertEqual(native_run.call_args.args[1:3], (entry["source"], entry["query"]))
            self.assertEqual(native_run.call_count, 8)
        self.assertFalse((self.job / "browser-tabs.json").exists())

    def test_driver_preserves_rate_and_access_pause_then_resumes_pending_page(self):
        import literature_search as search
        config = {"topic": "isolated access fixture", "query": "frozen query", "sources": ["cnki"],
                  "searchMode": "formal", "stopMode": "end", "perSourceLimit": None, "limit": 10}
        for reason in ("rate_limited", "access_blocked"):
            with self.subTest(reason=reason):
                job = self.job / reason
                calls, restored = [], False
                def source(*args, **kwargs):
                    index = kwargs.get("page_index", 0)
                    calls.append(index)
                    if index == 1 and not restored:
                        return {"status": "attention", "reason": reason, "results": [], "message": "fixture pause"}
                    return {"status": "ok", "results": [{"title": f"page {index} row {n}", "year": 2020}
                            for n in range(5)], "page_index": index, "has_next": index == 0}
                with patch.object(search, "injected_source_runner", source), redirect_stdout(io.StringIO()):
                    self.assertEqual(search.run(config, job), 0)
                state = json.loads((job / "discovery-state.json").read_text(encoding="utf-8"))
                self.assertEqual(state["pending_reason"], reason)
                self.assertEqual(state["sources"]["cnki"]["next_page"], 1)
                self.assertEqual(calls, [0, 1])
                self.assertFalse(json.loads((job / "candidates.json").read_text(encoding="utf-8"))["discovery_complete"])
                restored = True
                with patch.object(search, "injected_source_runner", source), redirect_stdout(io.StringIO()):
                    self.assertEqual(search.run(config, job, resume=True), 0)
                self.assertEqual(calls, [0, 1, 1])
                data = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
                self.assertEqual(data["count"], 10)
                self.assertTrue(data["discovery_complete"])

    def test_bound_challenge_or_rate_block_never_navigates_even_on_page_zero(self):
        for marker, reason in (("captcha", "verification"), ("rateLimited", "rate_limited"),
                               ("accessBlocked", "access_blocked")):
            with self.subTest(marker=marker):
                page = self.paged()
                self.assertEqual(self.call(full_page=True)["status"], "ok")
                before, navigations = self.binding(), len(page.navigations)
                page.dom = fixtures.snapshot(**{marker: True})
                for resume in (False, True):
                    result = self.call(resume=resume, full_page=True)
                    self.assertEqual((result["status"], result["reason"]), ("attention", reason))
                    self.assertIsNone(result["has_next"])
                    self.assertEqual(result["results"], [])
                self.assertEqual(self.binding(), before)
                self.assertEqual(len(page.navigations), navigations)
                self.assertEqual(page.next_clicks, 0)

    def test_next_page_rate_limit_keeps_checkpoint_then_resumes_same_page(self):
        page = self.paged()
        self.assertEqual(self.call(full_page=True)["status"], "ok")
        before = self.binding()
        second_page = copy.deepcopy(page.result_pages[1])
        page.result_pages[1] = fixtures.snapshot(rateLimited=True, queries=[])
        result = self.call(page_index=1, full_page=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "rate_limited"))
        self.assertEqual(self.binding(), before)
        self.assertEqual(page.next_clicks, 1)
        for _ in range(2):
            self.assertEqual(self.call(resume=True, page_index=1, full_page=True)["reason"], "rate_limited")
        self.assertEqual(page.next_clicks, 1)
        self.assertEqual(len(page.navigations), 1)
        page.result_pages[1] = second_page
        page.dom = copy.deepcopy(page.result_pages[0])  # Source access restored at saved anchor.
        page.position = 0
        recovered = self.call(resume=True, page_index=1, full_page=True)
        self.assertEqual(recovered["status"], "ok")
        self.assertEqual(recovered["results"][0]["title"], "Page 1 row 0")
        self.assertEqual(json.loads(self.binding())["cnki"]["page_index"], 1)

    def test_blank_shell_and_partial_titles_wait_for_complete_visible_page(self):
        page = fixtures.Page("loading", {})
        empty = fixtures.snapshot(resultContainer=True, resultsLoading=True, visible_result_count=20)
        full = fixtures.snapshot(resultContainer=True, results=[{**fixtures.ROW, "title": str(n)}
                     for n in range(20)], visible_result_count=20)
        partial = {**full, "results": full["results"][:3]}
        with patch.object(adapter, "_snapshot", side_effect=[partial, full]) as read, patch.object(adapter.time, "sleep"):
            result = adapter._wait_source_records(page, "cnki", empty, 200, full_page=True)
        self.assertEqual(len(result["results"]), 20)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(page.navigations, [])

    def test_loading_zero_does_not_claim_no_results(self):
        page = fixtures.Page("loading", {})
        loading = fixtures.snapshot(resultContainer=True, resultsLoading=True, noResults=True)
        with patch.object(adapter.time, "monotonic", side_effect=[0, 16]), patch.object(adapter.time, "sleep") as sleep:
            result = adapter._wait_source_records(page, "cnki", loading, 200, full_page=True)
        self.assertTrue(result["_source_loading_pending"])
        sleep.assert_not_called()

    def test_auth_or_rate_limit_ends_wait_without_sleep_or_request(self):
        page = fixtures.Page("waiting", {})
        for marker in ("password", "captcha", "rateLimited", "accessBlocked"):
            state = fixtures.snapshot(**{marker: True, "resultsLoading": True})
            with patch.object(adapter.time, "sleep") as sleep, patch.object(adapter, "_snapshot") as read:
                self.assertEqual(adapter._wait_source_records(page, "cnki", state, 200, full_page=True), state)
            sleep.assert_not_called()
            read.assert_not_called()

    def test_wos_form_is_not_submitted_beneath_new_access_challenge(self):
        for marker in ("password", "captcha", "rateLimited", "accessBlocked"):
            page = fixtures.Page("wos-form", fixtures.snapshot(**{marker: True}))
            page.has_form = True
            self.assertFalse(adapter._submit_wos(page, fixtures.QUERY))
            self.assertEqual(page.clicked, 0)
            self.assertEqual(page.filled, "")

    def test_next_page_never_accepts_partially_loaded_records(self):
        page = self.paged()
        previous = copy.deepcopy(page.dom)
        full = page.result_pages[1]
        partial = {**full, "results": full["results"][:2]}
        with patch.object(adapter, "_snapshot", side_effect=[partial, full]) as read, patch.object(adapter.time, "sleep"):
            result = adapter._advance_page(page, "cnki", previous, 200)
        self.assertEqual(result, full)
        self.assertEqual(read.call_count, 2)

    def test_unreachable_pending_page_is_attention_not_exhausted(self):
        page = self.paged(count=1)
        self.assertEqual(self.call(full_page=True)["status"], "ok")
        before = self.binding()
        result = self.call(page_index=1, full_page=True)
        self.assertEqual(result["status"], "attention")
        self.assertIsNone(result["has_next"])
        self.assertIn("尚未恢复到原待处理页", result["message"])
        self.assertEqual(self.binding(), before)
        self.assertEqual(page.next_clicks, 0)


if __name__ == "__main__":
    unittest.main()
