"""DOM-snapshot fixtures: no real browser, credentials, network, or CAPTCHA use."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import literature_browser as adapter


QUERY = 'broiler "heat stress" "growth performance"'
ROW = {
    "title": "Effects of heat stress on broiler growth", "authors": "A Author; B Author",
    "year": "2024", "venue": "Poultry Science", "doi": "10.1000/test.2024",
    "result_url": "https://www.webofscience.com/wos/woscc/full-record/WOS:123",
    "snippet": "An experimental study", "fulltext_links": [{"label": "PDF", "url": "https://example.org/paper.pdf"}],
}


def snapshot(**changes):
    value = {"captcha": False, "password": False, "loginPrompt": False,
             "accessRequired": False, "queries": [QUERY], "results": [],
             "resultContainer": False, "noResults": False}
    value.update(changes)
    return value


class CDPSession:
    def __init__(self, page):
        self.page = page

    def send(self, name):
        assert name == "Target.getTargetInfo"
        return {"targetInfo": {"targetId": self.page.target}}

    def detach(self):
        pass


class Control:
    def __init__(self, page, kind):
        self.page, self.kind = page, kind

    def count(self):
        return 1

    def nth(self, index):
        return self

    def is_visible(self):
        return self.page.has_form

    def fill(self, value):
        assert self.kind == "field"
        self.page.filled = value

    def input_value(self):
        return self.page.filled

    def inner_text(self):
        return self.page.search_field if self.kind == "picker" else "Topic"

    def click(self):
        if self.kind == "picker":
            self.page.picker_open = True
            return
        if self.kind == "topic-option":
            if self.page.topic_change_applies:
                self.page.search_field = "Topic"
            self.page.picker_open = False
            return
        assert self.kind == "button"
        self.page.clicked += 1
        self.page.dom = copy.deepcopy(self.page.after_search)
        self.page.dom["queries"] = [self.page.filled]
        self.page.url = "https://www.webofscience.com/wos/woscc/summary/abcdef/relevance/1"


class EmptyControl:
    def count(self):
        return 0


class Page:
    def __init__(self, target, dom):
        self.target, self.dom = target, copy.deepcopy(dom)
        self.url = "about:blank"
        self.front = 0
        self.navigations = []
        self.has_form = False
        self.has_picker = True
        self.picker_open = False
        self.search_field = "Topic"
        self.topic_change_applies = True
        self.filled = ""
        self.clicked = 0
        self.after_search = snapshot(results=[ROW], resultContainer=True)

    def bring_to_front(self):
        self.front += 1

    def goto(self, url, **kwargs):
        self.url = url
        self.navigations.append(url)
        if self.dom.get("results") and "kw=" in url:
            self.dom["queries"] = parse_qs(urlsplit(url).query).get("kw", [])

    def wait_for_selector(self, *args, **kwargs):
        pass

    def evaluate(self, javascript, arguments):
        assert "literature_snapshot" in javascript
        assert "source" in arguments and "limit" in arguments
        return copy.deepcopy(self.dom)

    def locator(self, selector):
        if selector == '[data-ta="search-field-dropdown"]' and self.has_form and self.has_picker:
            return Control(self, "picker")
        if selector == 'mat-option:has-text("Topic")' and self.picker_open:
            return Control(self, "topic-option")
        if selector == 'textarea[data-ta="search-criteria-input"]' and self.has_form:
            return Control(self, "field")
        if selector == 'button[data-ta="run-search"]' and self.has_form:
            return Control(self, "button")
        return EmptyControl()


class Context:
    def __init__(self, dom):
        self.initial_dom = dom
        self.pages = []

    def new_page(self):
        page = Page(f"target-{len(self.pages) + 1}", self.initial_dom)
        self.pages.append(page)
        return page

    def new_cdp_session(self, page):
        return CDPSession(page)


class PagerControl:
    def __init__(self, page):
        self.page = page

    def count(self):
        return 1

    def nth(self, index):
        return self

    def is_visible(self):
        return True

    def is_enabled(self):
        return self.page.position < len(self.page.result_pages) - 1

    def get_attribute(self, name):
        return None

    def evaluate(self, script):
        return False

    def click(self, **kwargs):
        self.page.position += 1
        self.page.next_clicks += 1
        self.page.dom = copy.deepcopy(self.page.result_pages[self.page.position])


class PagedPage(Page):
    def __init__(self, pages):
        super().__init__("paged-target", pages[0])
        self.result_pages, self.position, self.next_clicks = pages, 0, 0

    def goto(self, url, **kwargs):
        self.position = 0
        self.dom = copy.deepcopy(self.result_pages[0])
        super().goto(url, **kwargs)

    def locator(self, selector):
        return PagerControl(self) if selector == "#PageNext" else EmptyControl()

    def evaluate(self, javascript, arguments):
        if "literature_pagination" in javascript:
            return {"total_count": 41, "explicit_end": False}
        return super().evaluate(javascript, arguments)


class BrowserAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="literature-browser-test-")
        self.job = Path(self.temporary.name)
        self.context = Context(snapshot(results=[ROW], resultContainer=True))

        @contextmanager
        def runtime():
            yield self.context

        self.runtime_patch = patch.object(adapter, "_runtime", runtime)
        self.runtime_patch.start()

    def tearDown(self):
        self.runtime_patch.stop()
        self.temporary.cleanup()

    def call(self, source="cnki", resume=False, **kwargs):
        return adapter.run(source, QUERY, resume, 10, job_dir=self.job, **kwargs)

    def test_logged_in_results_preserve_bibliography(self):
        result = self.call()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["results"][0]["title"], ROW["title"])
        self.assertEqual(result["results"][0]["doi"], ROW["doi"])
        self.assertEqual(result["results"][0]["fulltext_links"][0]["url"], "https://example.org/paper.pdf")
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))
        self.assertEqual(binding["cnki"]["target_id"], "target-1")
        self.assertNotIn("url", binding["cnki"])

    def test_login_is_attention_and_resume_reuses_exact_tab(self):
        self.context.initial_dom = snapshot(password=True, queries=[])
        result = self.call()
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))
        page = self.context.pages[0]
        page.url = "https://passport.cnki.net/login?ticket=secret-token"
        page.dom = snapshot(results=[ROW], resultContainer=True)
        page.url = "https://kns.cnki.net/kns8s/defaultresult/index?kw=broiler"
        result = self.call(resume=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(self.context.pages), 1)
        self.assertEqual(page.front, 2)
        self.assertNotIn("secret-token", json.dumps(result))
        self.assertNotIn("passport", json.dumps(result))

    def test_captcha_and_missing_access_never_report_zero(self):
        for marker, reason in [("captcha", "verification"), ("accessRequired", "access_required")]:
            with self.subTest(reason=reason):
                self.context = Context(snapshot(**{marker: True}))
                result = self.call()
                self.assertEqual((result["status"], result["reason"]), ("attention", reason))

    def test_explicit_no_results_is_required(self):
        self.context.initial_dom = snapshot(noResults=True, resultContainer=True)
        self.assertEqual(self.call()["status"], "no_results")
        self.context.pages[0].dom = snapshot(resultContainer=True)
        result = self.call(resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))

    def test_unknown_layout_and_unrelated_query_are_not_candidates(self):
        self.context.initial_dom = snapshot(queries=[], results=[], resultContainer=False)
        self.assertEqual(self.call()["reason"], "results_unrecognized")
        self.context.pages[0].dom = snapshot(queries=["unrelated query"], results=[ROW])
        # CNKI navigation puts the confirmed query into the real query URL.
        result = self.call(resume=True)
        self.assertEqual(result["status"], "ok")
        self.assertIn("kw=", self.context.pages[0].url)

    def test_visible_query_overrules_stale_url(self):
        page_url = "https://kns.cnki.net/kns8s/defaultresult/index?kw=" + QUERY
        self.assertFalse(adapter._matches_query(snapshot(queries=["a different query"]), page_url, "cnki", QUERY))

    def test_query_with_extra_condition_is_not_the_confirmed_query(self):
        self.assertFalse(adapter._matches_query(snapshot(queries=[QUERY + " AND extra"]), "https://example.org", "web-of-science", QUERY))

    def test_wos_uses_core_collection_form_submission(self):
        self.context.initial_dom = snapshot(queries=[], results=[])
        page = self.context.new_page()
        page.has_form = True
        adapter._save_binding(self.job, "web-of-science", page.target)
        result = self.call("web-of-science", year_from=2010, year_to=2025)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)
        self.assertEqual(page.navigations, [adapter.SOURCES["web-of-science"][1]])
        self.assertNotIn("?", page.navigations[0])
        self.assertEqual(result["applied_filters"], {})
        self.assertTrue(result["deferred_rules"])

    def test_wos_plain_query_changes_remembered_author_field_to_topic(self):
        page = self.context.new_page()
        page.has_form = True
        page.search_field = "Author"
        self.assertTrue(adapter._submit_wos(page, QUERY))
        self.assertEqual(page.search_field, "Topic")
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)

    def test_wos_missing_or_unapplied_field_picker_does_not_submit(self):
        for missing in (True, False):
            page = self.context.new_page()
            page.has_form = True
            page.search_field = "Title"
            page.has_picker = not missing
            page.topic_change_applies = False
            self.assertFalse(adapter._submit_wos(page, QUERY))
            self.assertEqual(page.clicked, 0)

    def test_wos_missing_picker_returns_resumable_attention(self):
        self.context.initial_dom = snapshot(queries=[])
        page = self.context.new_page()
        page.has_form, page.has_picker = True, False
        adapter._save_binding(self.job, "web-of-science", page.target)
        result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertEqual(page.clicked, 0)

    def test_wos_topic_prefix_only_translates_after_topic_confirmed(self):
        page = self.context.new_page()
        page.has_form = True
        page.search_field = "Author"
        self.assertTrue(adapter._submit_wos(page, f"TS=({QUERY})"))
        self.assertEqual(page.search_field, "Topic")
        self.assertEqual(page.filled, QUERY)

    def test_wos_login_redirect_and_result_auth_links_are_redacted(self):
        page = self.context.new_page()
        page.url = "https://auth.example.edu/saml/login?ticket=secret-token"
        page.dom = snapshot(queries=[])
        adapter._save_binding(self.job, "web-of-science", page.target)
        result = self.call("web-of-science", resume=True)
        self.assertEqual(result["reason"], "login")
        self.assertNotIn("secret-token", json.dumps(result))
        self.assertEqual(adapter.safe_url("https://example.org/oauth/callback?code=secret"), "")
        self.assertEqual(adapter.safe_url("https://example.org/article?token=secret"), "")
        self.assertEqual(adapter.safe_url("https://kns.cnki.net/detail?filename=ABC&v=opaque"), "https://kns.cnki.net/detail?filename=ABC")

    def test_open_source_preserves_waiting_auth_tab_and_rejects_other_source(self):
        self.call()
        page = self.context.pages[0]
        page.url = "https://passport.cnki.net/login?ticket=secret-token"
        (self.job / "run_config.json").write_text(json.dumps({"sources": ["cnki"], "query": QUERY}), encoding="utf-8")
        (self.job / "discovery-state.json").write_text(json.dumps({"pending_source": "cnki"}), encoding="utf-8")
        navigations = len(page.navigations)
        result = adapter.open_source("cnki", job_dir=self.job)
        self.assertEqual(result, {"opened": True, "source": "cnki", "label": "中国知网", "message": "已打开该任务的官方检索页面，请在页面中完成登录或验证。"})
        self.assertEqual(len(page.navigations), navigations)
        self.assertEqual(len(self.context.pages), 1)
        with self.assertRaises(ValueError):
            adapter.open_source("web-of-science", job_dir=self.job)

    def test_scholar_forwards_confirmed_years_without_changing_source(self):
        result = self.call("google-scholar", year_from=2010, year_to=2024)
        self.assertEqual(result["status"], "ok")
        query = parse_qs(urlsplit(self.context.pages[0].url).query)
        self.assertEqual(query["q"], [QUERY])
        self.assertEqual(query["as_ylo"], ["2010"])
        self.assertEqual(query["as_yhi"], ["2024"])
        self.assertEqual(result["applied_filters"], {"publicationYearFrom": 2010, "publicationYearTo": 2024})

    def test_errors_never_disclose_redirect_url(self):
        with patch.object(adapter, "_snapshot", side_effect=RuntimeError("https://sso.example/login?ticket=secret-token")):
            result = self.call()
        self.assertEqual(result["status"], "error")
        self.assertNotIn("secret-token", json.dumps(result))

    def test_legacy_wos_access_and_clarivate_auth_are_attention(self):
        page = self.context.new_page()
        adapter._save_binding(self.job, "web-of-science", page.target)
        for url, reason in [
            ("https://www.webofknowledge.com/?action=transfer&session=secret-token", "access_required"),
            ("https://access.clarivate.com/?ticket=secret-token", "login"),
        ]:
            page.url, page.dom = url, snapshot(queries=[])
            result = self.call("web-of-science", resume=True)
            self.assertEqual((result["status"], result["reason"]), ("attention", reason))
            self.assertNotIn("secret-token", json.dumps(result))

    def test_navigation_failure_on_official_auth_page_still_allows_login(self):
        page = self.context.new_page()
        adapter._save_binding(self.job, "web-of-science", page.target)

        def interrupted_navigation(*args, **kwargs):
            page.url = "https://access.clarivate.com/login?ticket=secret-token"
            page.dom = snapshot(password=True, queries=[])
            raise RuntimeError(page.url)

        with patch.object(page, "goto", side_effect=interrupted_navigation):
            result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))
        self.assertNotIn("secret-token", json.dumps(result))

    def test_pubmed_api_success_does_not_open_browser(self):
        published = {"status": "ok", "source_key": "pubmed", "results": [{**ROW, "pmid": "123"}],
                     "transport": "ncbi_eutilities"}
        with patch.object(adapter.literature_pubmed, "run", return_value=published) as api, \
                patch.object(adapter, "_runtime", side_effect=AssertionError("must not launch")):
            self.assertEqual(self.call("pubmed", year_from=2000), published)
        api.assert_called_once_with(QUERY, limit=10, year_from=2000, year_to=None)

    def test_pubmed_api_confirmed_zero_does_not_launch_browser(self):
        with patch.object(adapter.literature_pubmed, "run", return_value={"status": "no_results", "results": []}), \
                patch.object(adapter, "_runtime", side_effect=AssertionError("must not launch")):
            self.assertEqual(self.call("pubmed")["status"], "no_results")

    def test_pubmed_api_failure_stays_on_same_source_with_transport(self):
        dom = snapshot(results=[{**ROW, "pmid": "123", "result_url": "https://pubmed.ncbi.nlm.nih.gov/123/"}])
        with patch.object(adapter.literature_pubmed, "run", return_value={"status": "error"}), \
                patch.object(adapter.extra_sources, "snapshot", return_value=dom), \
                patch.object(adapter.extra_sources, "navigate", return_value=True) as navigate:
            result = self.call("pubmed")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["source_key"], "pubmed")
        self.assertEqual(result["transport"], "browser_after_api_error")
        self.assertEqual(result["results"][0]["pmid"], "123")
        self.assertEqual(navigate.call_args.args[1], "pubmed")

    def test_pubmed_manual_resume_does_not_restart_api(self):
        with patch.object(adapter.literature_pubmed, "run", side_effect=AssertionError("resume the tab")), \
                patch.object(adapter.extra_sources, "snapshot", return_value=snapshot(captcha=True)), \
                patch.object(adapter.extra_sources, "navigate", return_value=True):
            result = self.call("pubmed", resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "verification"))

    def test_wanfang_links_resolve_only_after_query_and_auth_checks(self):
        row = {**ROW, "result_url": "", "doi": "", "_title_index": 0}
        with patch.object(adapter.extra_sources, "snapshot", return_value=snapshot(results=[row])), \
                patch.object(adapter.extra_sources, "navigate", return_value=True), \
                patch.object(adapter.extra_sources, "resolve_result_links", return_value=[row]) as resolve:
            self.assertEqual(self.call("wanfang")["reason"], "results_unrecognized")
            self.assertEqual(resolve.call_count, 1)
            with patch.object(adapter.extra_sources, "snapshot", return_value=snapshot(password=True, results=[row])):
                self.assertEqual(self.call("wanfang")["reason"], "login")
                self.assertEqual(resolve.call_count, 1)

    def test_scopus_wrapped_query_matches_only_exact_inner_expression(self):
        self.assertTrue(adapter._matches_query(snapshot(), "https://www.scopus.com", "scopus", f"TITLE-ABS-KEY({QUERY})"))
        self.assertFalse(adapter._matches_query(snapshot(queries=[QUERY + " OR more"]), "https://www.scopus.com", "scopus", f"TITLE-ABS-KEY({QUERY})"))

    def test_scopus_unverified_manual_field_requires_form_resubmission(self):
        with patch.object(adapter.extra_sources, "snapshot", return_value=snapshot(results=[ROW])), \
                patch.object(adapter.extra_sources, "navigate", return_value=False) as navigate, \
                patch.object(adapter.extra_sources, "query_context_valid", return_value=False):
            result = self.call("scopus", resume=True)
        self.assertEqual(result["reason"], "results_unrecognized")
        self.assertGreaterEqual(navigate.call_count, 1)

    def paged(self, count=3, rows=20):
        pages = [snapshot(results=[{**ROW, "title": f"Page {number} paper {index}",
                 "result_url": f"https://example.org/{number}/{index}"} for index in range(rows)], resultContainer=True)
                 for number in range(count)]
        page = PagedPage(pages)
        self.context.pages.append(page)
        adapter._save_binding(self.job, "cnki", page.target)
        return page

    def test_formal_reads_full_visible_page_without_losing_after_first_ten(self):
        self.paged()
        result = self.call(full_page=True)
        self.assertEqual(len(result["results"]), 20)
        self.assertTrue(result["has_next"])
        self.assertEqual(result["total_count"], 41)
        self.assertEqual(result["page_index"], 0)

    def test_default_call_still_returns_at_most_ten(self):
        self.paged()
        result = self.call()
        self.assertEqual(len(result["results"]), 10)

    def test_native_page_larger_than_read_cap_pauses_instead_of_skipping_tail(self):
        page = self.paged()
        page.result_pages[0]["visible_result_count"] = 500
        result = self.call(full_page=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertEqual(result["results"], [])
        self.assertIn("200", result["message"])

    def test_sequential_page_reuses_confirmed_target_and_visible_next(self):
        page = self.paged()
        self.call(full_page=True)
        second = self.call(page_index=1, full_page=True)
        third = self.call(page_index=2, full_page=True)
        self.assertEqual((second["status"], third["status"]), ("ok", "ok"))
        self.assertIn("Page 1", second["results"][0]["title"])
        self.assertIn("Page 2", third["results"][0]["title"])
        self.assertEqual(page.next_clicks, 2)
        self.assertEqual(len(page.navigations), 1)
        self.assertFalse(third["has_next"])
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))["cnki"]
        self.assertEqual(binding["page_index"], 2)
        self.assertEqual(len(binding["result_fingerprint"]), 64)
        self.assertNotIn("url", binding)

    def test_return_from_login_replays_frozen_search_to_requested_page(self):
        page = self.paged()
        self.call(full_page=True)
        page.dom = snapshot(password=True, queries=[])
        waiting = self.call(page_index=1, full_page=True)
        self.assertEqual(waiting["reason"], "login")
        page.dom = snapshot(results=[{**ROW, "title": "Unproven manual page"}])
        result = self.call(resume=True, page_index=1, full_page=True)
        self.assertEqual(result["status"], "ok")
        self.assertIn("Page 1", result["results"][0]["title"])
        self.assertEqual(len(page.navigations), 2)

    def test_changed_manual_query_does_not_reuse_page_proof(self):
        page = self.paged()
        self.call(full_page=True)
        page.dom["queries"] = ["another query"]
        result = self.call(page_index=1, full_page=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(page.navigations), 2)
        self.assertIn("Page 1", result["results"][0]["title"])

    def test_formal_first_page_without_page_proof_resubmits_after_manual_login(self):
        page = self.paged()
        page.dom = copy.deepcopy(page.result_pages[2])
        page.url = adapter.SOURCES["cnki"][1] + "?kw=broiler"
        result = self.call(resume=True, full_page=True)
        self.assertEqual(result["status"], "ok")
        self.assertIn("Page 0", result["results"][0]["title"])
        self.assertEqual(len(page.navigations), 1)

    def test_missing_or_unchanged_next_page_is_attention(self):
        self.paged()
        self.call(full_page=True)
        with patch.object(adapter, "_advance_page", return_value=None):
            result = self.call(page_index=1, full_page=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))

    def test_next_waits_through_empty_ajax_loading_frame(self):
        page = self.paged()
        previous = page.dom
        fresh = page.result_pages[1]
        with patch.object(adapter, "_snapshot", side_effect=[snapshot(), fresh]) as read, \
                patch.object(adapter.time, "sleep"):
            result = adapter._advance_page(page, "cnki", previous, 200)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(result, fresh)

    def test_absent_next_button_is_unknown_not_proven_last_page(self):
        result = self.call(full_page=True)
        self.assertIsNone(result["has_next"])

    def test_recreated_browser_target_cannot_inherit_old_page_proof(self):
        self.paged()
        self.call(full_page=True)
        adapter._save_binding(self.job, "cnki", "new-target")
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))["cnki"]
        self.assertNotIn("page_index", binding)
        self.assertNotIn("result_fingerprint", binding)

    def test_actual_wanfang_pager_and_count_dom(self):
        from test_literature_extra_sources import dom_snapshot
        for current, end in [("2 / 19", False), ("19 / 19", True)]:
            metadata = dom_snapshot("wanfang", {"count": {"text": "369"}, "pages": {"text": current}},
                {".total-number .mark-number": ["count"], ".small-paginate .page-number": ["pages"]},
                script=adapter._PAGINATION_JS)
            self.assertEqual(metadata["total_count"], 369)
            self.assertEqual(metadata["explicit_end"], end)

    def test_actual_scopus_results_header_exposes_reported_total_count(self):
        from test_literature_extra_sources import dom_snapshot
        metadata = dom_snapshot("scopus", {"header": {"text": "2,417 documents found"}},
            {'h2[data-testid="label-search-results-header"]': ["header"]},
            script=adapter._PAGINATION_JS)
        self.assertEqual(metadata["total_count"], 2417)
        self.assertFalse(metadata["explicit_end"])

    def test_pubmed_forwards_exact_offset_page(self):
        published = {"status": "ok", "results": [], "page_index": 3, "has_next": False, "total_count": 21}
        with patch.object(adapter.literature_pubmed, "run", return_value=published) as api:
            result = self.call("pubmed", page_index=3, full_page=True)
        self.assertEqual(result, published)
        api.assert_called_once_with(QUERY, limit=10, year_from=None, year_to=None, page_index=3)

    def test_pubmed_api_transport_does_not_switch_to_browser_at_later_offset(self):
        published = {"status": "ok", "results": [ROW], "transport": "ncbi_eutilities", "page_index": 0}
        failed = {"status": "error", "results": [], "transport": "ncbi_eutilities", "page_index": 1}
        with patch.object(adapter.literature_pubmed, "run", side_effect=[published, failed]) as api, \
                patch.object(adapter, "_runtime", side_effect=AssertionError("API task must retain offset")):
            self.call("pubmed")
            result = self.call("pubmed", resume=True, page_index=1, full_page=True)
        self.assertEqual(result, failed)
        self.assertEqual(api.call_count, 2)

    def test_pubmed_browser_fallback_is_locked_for_subsequent_pages(self):
        dom = snapshot(captcha=True)
        with patch.object(adapter.literature_pubmed, "run", return_value={"status": "error"}) as api, \
                patch.object(adapter.extra_sources, "snapshot", return_value=dom), \
                patch.object(adapter.extra_sources, "navigate", return_value=True):
            self.call("pubmed")
            result = self.call("pubmed", page_index=1, full_page=True)
        self.assertEqual(api.call_count, 1)
        self.assertEqual(result["transport"], "browser_after_api_error")
        self.assertEqual(result["reason"], "verification")

    def test_corrupt_pubmed_transport_marker_cannot_mix_pagination(self):
        (self.job / "pubmed-transport.json").write_text('{"query_hash":"different","transport":"ncbi_eutilities"}', encoding="utf-8")
        with patch.object(adapter.literature_pubmed, "run", side_effect=AssertionError("invalid checkpoint")):
            self.assertEqual(self.call("pubmed")["status"], "error")


if __name__ == "__main__":
    unittest.main()
