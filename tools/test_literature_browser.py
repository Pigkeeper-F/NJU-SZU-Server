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

    def test_explicit_resume_rechecks_old_sso_target_with_shared_session(self):
        page = self.context.new_page()
        page.url = "https://passport.cnki.net/login?ticket=must-not-export"
        page.dom = snapshot(password=True, queries=[])
        adapter._save_binding(self.job, "cnki", page.target)

        def shared_session_search(bound, source, query, year_from, year_to):
            self.assertIs(bound, page)
            self.assertEqual((source, query, year_from, year_to), ("cnki", QUERY, 2000, 2025))
            bound.url = adapter.SOURCES[source][1]
            bound.dom = snapshot(results=[ROW], resultContainer=True)
            return True

        with patch.object(adapter, "_navigate_search", side_effect=shared_session_search) as navigate:
            result = self.call(resume=True, year_from=2000, year_to=2025)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(navigate.call_count, 1)
        self.assertEqual(len(self.context.pages), 1)
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))["cnki"]
        self.assertEqual(binding["target_id"], page.target)
        self.assertNotIn("must-not-export", json.dumps(result))

    def test_explicit_resume_still_requires_login_if_official_recheck_fails(self):
        page = self.context.new_page()
        page.url = "https://passport.cnki.net/login"
        page.dom = snapshot(password=True, queries=[QUERY])
        adapter._save_binding(self.job, "cnki", page.target)
        with patch.object(adapter, "_navigate_search", return_value=False) as navigate:
            result = self.call(resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))
        self.assertEqual(navigate.call_count, 1)
        self.assertEqual(result["results"], [])

    def test_explicit_resume_rechecks_stale_institution_access_page(self):
        page = self.context.new_page()
        page.url = adapter.SOURCES["cnki"][1]
        page.dom = snapshot(accessRequired=True, queries=[QUERY])
        adapter._save_binding(self.job, "cnki", page.target)

        def shared_session_search(bound, *args):
            bound.dom = snapshot(results=[ROW], resultContainer=True)
            return True

        with patch.object(adapter, "_navigate_search", side_effect=shared_session_search) as navigate:
            result = self.call(resume=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(navigate.call_count, 1)

    def test_unresolved_verification_is_not_refreshed_on_resume(self):
        page = self.context.new_page()
        page.url = "https://kns.cnki.net/verify"
        page.dom = snapshot(captcha=True, password=True, queries=[])
        adapter._save_binding(self.job, "cnki", page.target)
        with patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve manual challenge")):
            result = self.call(resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "verification"))
        self.assertEqual(page.url, "https://kns.cnki.net/verify")

    def test_non_resume_later_page_does_not_reprobe_login_target(self):
        page = self.context.new_page()
        page.url = "https://passport.cnki.net/login"
        page.dom = snapshot(password=True, queries=[])
        adapter._save_binding(self.job, "cnki", page.target)
        with patch.object(adapter, "_navigate_search", side_effect=AssertionError("only explicit resume rechecks")):
            result = self.call(page_index=1, full_page=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))

    def test_cnki_institution_navigation_label_does_not_require_login(self):
        from test_literature_extra_sources import dom_snapshot
        state = dom_snapshot("cnki", head="中国知网 登录 注册 机构登录 选择机构 高级检索", script=adapter._SNAPSHOT_JS)
        page = Page("cnki", state)
        page.url = adapter.SOURCES["cnki"][1]
        self.assertFalse(state["loginPrompt"])
        self.assertIsNone(adapter._auth_reason(page, state))

    def test_cnki_explicit_login_requirement_remains_attention(self):
        from test_literature_extra_sources import dom_snapshot
        state = dom_snapshot("cnki", head="请先登录，登录后方可继续检索", script=adapter._SNAPSHOT_JS)
        page = Page("cnki", state)
        page.url = adapter.SOURCES["cnki"][1]
        self.assertTrue(state["loginPrompt"])
        self.assertEqual(adapter._auth_reason(page, state), "login")

    def test_wanfang_homepage_with_frozen_query_resubmits_instead_of_reading_home(self):
        page = self.context.new_page()
        page.url = adapter.SOURCES["wanfang"][1]
        page.dom = snapshot(queries=[QUERY], results=[], resultContainer=False)
        adapter._save_binding(self.job, "wanfang", page.target)
        row = {**ROW, "result_url": "https://d.wanfangdata.com.cn/periodical/example202401"}

        def submit_homepage(bound, source, query, year_from, year_to):
            self.assertIs(bound, page)
            self.assertEqual((source, query, year_from, year_to), ("wanfang", QUERY, None, None))
            bound.url = "https://s.wanfangdata.com.cn/paper?q=broiler"
            bound.dom = snapshot(results=[row], resultContainer=True)
            return True

        with patch.object(adapter.extra_sources, "snapshot", side_effect=lambda bound, *args: copy.deepcopy(bound.dom)), \
                patch.object(adapter, "_navigate_search", side_effect=submit_homepage) as navigate:
            result = self.call("wanfang", resume=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["results"][0]["title"], row["title"])
        self.assertEqual(navigate.call_count, 1)
        self.assertEqual(len(self.context.pages), 1)
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))["wanfang"]
        self.assertEqual(binding["target_id"], page.target)
        self.assertEqual(binding["page_index"], 0)
        self.assertTrue(binding["query_hash"])

    def test_wanfang_homepage_without_working_form_stays_unrecognized_not_login(self):
        page = self.context.new_page()
        page.url = adapter.SOURCES["wanfang"][1]
        page.dom = snapshot(queries=[QUERY], results=[], resultContainer=False)
        adapter._save_binding(self.job, "wanfang", page.target)
        with patch.object(adapter.extra_sources, "snapshot", side_effect=lambda bound, *args: copy.deepcopy(bound.dom)), \
                patch.object(adapter, "_navigate_search", return_value=False) as navigate:
            result = self.call("wanfang", resume=True)
        self.assertEqual(navigate.call_count, 1)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertEqual(result["results"], [])

    def test_manual_official_result_page_and_explicit_zero_can_still_be_read(self):
        for source in ("wanfang", "scopus"):
            for zero in (False, True):
                with self.subTest(source=source, zero=zero):
                    self.context = Context(snapshot())
                    page = self.context.new_page()
                    page.url = adapter.SOURCES[source][1]
                    row = {**ROW, "result_url": "https://d.wanfangdata.com.cn/periodical/example202401"}
                    page.dom = snapshot(results=[] if zero else [row], resultContainer=True, noResults=zero)
                    adapter._save_binding(self.job, source, page.target)
                    with patch.object(adapter.extra_sources, "snapshot", side_effect=lambda bound, *args: copy.deepcopy(bound.dom)), \
                            patch.object(adapter.extra_sources, "query_context_valid", return_value=True), \
                            patch.object(adapter, "_navigate_search", side_effect=AssertionError("manual actual result should be read")):
                        result = self.call(source, resume=True)
                    self.assertEqual(result["status"], "no_results" if zero else "ok")

    def test_manual_result_on_nonofficial_domain_cannot_skip_resubmission(self):
        page = self.context.new_page()
        page.url = "https://unrelated.example/search"
        page.dom = snapshot(results=[ROW], resultContainer=True)
        adapter._save_binding(self.job, "cnki", page.target)
        with patch.object(adapter, "_navigate_search", return_value=True) as navigate:
            self.call(resume=True)
        self.assertEqual(navigate.call_count, 1)

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

    def test_wos_official_china_host_is_allowed_without_allowing_similar_hosts(self):
        page = Page("regional-wos", snapshot())
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        self.assertTrue(adapter._official_result_page(page, "web-of-science"))
        for host in ("webofscience.clarivate.cn.evil.test", "proxy.webofscience.clarivate.cn",
                     "evilwebofscience.clarivate.cn", "clarivate.cn", "webofscience.example"):
            page.url = "https://" + host + "/wos/"
            self.assertFalse(adapter._official_result_page(page, "web-of-science"), host)

    def test_wos_bound_failed_task_can_use_visible_form_without_scrape_current_flag(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        page.dom = snapshot(queries=[], results=[])
        page.has_form = True
        page.search_field = "Author"
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(adapter, "_navigate_search", side_effect=AssertionError("do not reopen the global transfer")):
            result = self.call("web-of-science")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.search_field, "Topic")
        self.assertEqual(page.clicked, 1)
        self.assertEqual(page.navigations, [])
        self.assertEqual(len(self.context.pages), 1)

    def test_wos_navigation_timeout_can_use_actual_official_form_in_same_tab(self):
        page = self.context.new_page()
        page.has_form = True
        adapter._save_binding(self.job, "web-of-science", page.target)

        def regional_timeout(*args, **kwargs):
            page.url = "https://webofscience.clarivate.cn/wos/"
            page.dom = snapshot(queries=[], results=[])
            raise TimeoutError("unexportable transfer diagnostic")

        with patch.object(page, "goto", side_effect=regional_timeout) as navigate:
            result = self.call("web-of-science")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)
        self.assertEqual(navigate.call_count, 1)
        self.assertNotIn("unexportable", json.dumps(result))

    def test_wos_empty_official_transfer_timeout_is_recoverable_not_failed(self):
        page = self.context.new_page()
        adapter._save_binding(self.job, "web-of-science", page.target)

        def regional_timeout(*args, **kwargs):
            page.url = "https://webofscience.clarivate.cn/wos/"
            page.dom = snapshot(queries=[], results=[])
            raise TimeoutError("unexportable transfer diagnostic")

        with patch.object(page, "goto", side_effect=regional_timeout):
            result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertIn("Web of Science", result["message"])
        self.assertIn("检查并继续", result["message"])
        self.assertEqual(page.clicked, 0)
        self.assertEqual(result["results"], [])
        self.assertNotIn("unexportable", json.dumps(result))

    def test_wos_timeout_auth_and_challenge_are_not_submitted_automatically(self):
        for marker, reason, url in (
            ("password", "login", "https://access.clarivate.com/login"),
            ("captcha", "verification", "https://webofscience.clarivate.cn/wos/"),
            ("accessRequired", "access_required", "https://webofscience.clarivate.cn/wos/"),
        ):
            with self.subTest(reason=reason):
                self.context = Context(snapshot())
                page = self.context.new_page()
                page.has_form = True
                adapter._save_binding(self.job, "web-of-science", page.target)

                def gated_timeout(*args, **kwargs):
                    page.url = url
                    page.dom = snapshot(queries=[], **{marker: True})
                    raise TimeoutError("private diagnostic")

                with patch.object(page, "goto", side_effect=gated_timeout):
                    result = self.call("web-of-science")
                self.assertEqual((result["status"], result["reason"]), ("attention", reason))
                self.assertEqual(page.clicked, 0)
                self.assertEqual(page.url, url)
                self.assertNotIn("private diagnostic", json.dumps(result))

    def test_wos_official_control_exception_is_recoverable_and_sanitized(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        page.dom = snapshot(queries=[], results=[])
        page.has_form = True
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(Control, "click", side_effect=TimeoutError("private overlay diagnostic")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertIn("原任务窗口", result["message"])
        self.assertNotIn("private overlay", json.dumps(result))

    def test_wos_unavailable_browser_or_closed_page_is_still_environment_error(self):
        with patch.object(adapter, "_runtime", side_effect=RuntimeError("private unavailable browser")):
            result = self.call("web-of-science")
        self.assertEqual(result["status"], "error")
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/"
        page.is_closed = lambda: True
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(adapter, "_snapshot", side_effect=RuntimeError("private disconnected DOM")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("private disconnected", json.dumps(result))

    def test_wos_navigation_destroyed_dom_on_live_official_tab_is_recoverable(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/"
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(adapter, "_snapshot", side_effect=RuntimeError("private execution context destroyed")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertNotIn("private execution context", json.dumps(result))

    def test_wos_auth_exception_is_classified_while_runtime_is_still_connected(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        page.dom = snapshot(queries=[], results=[])
        page.has_form = True
        adapter._save_binding(self.job, "web-of-science", page.target)
        active = False
        reads = []
        actual_snapshot = adapter._snapshot

        @contextmanager
        def live_runtime():
            nonlocal active
            active = True
            try:
                yield self.context
            finally:
                active = False

        def read_live(*args):
            reads.append(active)
            if not active:
                raise RuntimeError("transport already disconnected")
            return actual_snapshot(*args)

        def redirected_control(*args):
            page.url = "https://access.clarivate.com/login"
            page.dom = snapshot(password=True, queries=[])
            raise TimeoutError("private redirect diagnostic")

        with patch.object(adapter, "_runtime", live_runtime), \
                patch.object(adapter, "_snapshot", side_effect=read_live), \
                patch.object(Control, "click", side_effect=redirected_control):
            result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))
        self.assertGreaterEqual(len(reads), 2)
        self.assertTrue(all(reads), "all recovery reads must precede runtime disconnect")
        self.assertFalse(active)
        self.assertNotIn("private redirect", json.dumps(result))

    def test_wos_bound_challenge_is_not_refreshed_when_failed_task_omits_resume_flag(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/"
        page.dom = snapshot(captcha=True, queries=[])
        page.has_form = True
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve human challenge")):
            result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "verification"))
        self.assertEqual(page.clicked, 0)

    def test_wos_sid_bearing_links_are_never_exported(self):
        for key in ("SID", "sid", "SiD"):
            url = "https://webofscience.clarivate.cn/wos/woscc/full-record/WOS:123?" + key + "=fixture-sensitive"
            self.assertEqual(adapter.safe_url(url), "")
        self.assertEqual(adapter.safe_url("https://webofscience.clarivate.cn/wos/woscc/full-record/WOS:123"),
                         "https://webofscience.clarivate.cn/wos/woscc/full-record/WOS:123")

    def wos_summary(self, state, page_number=1):
        page = self.context.new_page()
        page.url = f"https://webofscience.clarivate.cn/wos/woscc/summary/fixture/relevance/{page_number}"
        page.dom, page.has_form = copy.deepcopy(state), True
        adapter._save_binding(self.job, "web-of-science", page.target)
        return page

    def test_actual_wos_empty_record_shell_is_not_title_readiness(self):
        from test_literature_extra_sources import dom_snapshot
        nodes = {"container": {}, "row1": {}, "row2": {"map": {'a.summary-title': ["title"]}},
                 "title": {"text": ROW["title"], "href": ROW["result_url"]}}
        mapping = {"app-record": ["row1", "row2"], "app-records-list": ["container"]}
        state = dom_snapshot("web-of-science", nodes, mapping, script=adapter._SNAPSHOT_JS)
        self.assertEqual((state["visible_result_count"], state["loaded_title_count"]), (2, 1))
        self.assertFalse(adapter._wos_records_ready(state, 200, full_page=True))
        state = dom_snapshot("web-of-science", nodes, mapping, limit=1, script=adapter._SNAPSHOT_JS)
        self.assertTrue(adapter._wos_records_ready(state, 1))
        nodes["title"]["hidden"] = True
        state = dom_snapshot("web-of-science", nodes, mapping, script=adapter._SNAPSHOT_JS)
        self.assertEqual(state["loaded_title_count"], 0)
        self.assertEqual(state["results"], [])

    def test_wos_wait_selector_requires_title_not_empty_component(self):
        page = Page("fixture", snapshot())
        with patch.object(page, "wait_for_selector") as wait:
            adapter._wait_results(page, "web-of-science")
        selector = wait.call_args.args[0]
        self.assertIn('[data-ta="summary-record"]) :is(a', selector)
        self.assertIn('a[data-ta="summary-record-title-link"]', selector)

    def test_wos_bound_empty_summary_waits_then_reads_delayed_titles_same_page(self):
        empty = snapshot(resultContainer=True, visible_result_count=50, loaded_title_count=0)
        page = self.wos_summary(empty)
        loaded = snapshot(results=[{**ROW, "title": f"Paper {i}"} for i in range(10)],
                          resultContainer=True, visible_result_count=50, loaded_title_count=10)
        original = page.url
        with patch.object(adapter, "_snapshot", side_effect=[empty, loaded]), \
                patch.object(adapter.time, "sleep"), \
                patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve summary")), \
                patch.object(adapter, "_submit_wos", side_effect=AssertionError("preserve summary")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual((result["status"], len(result["results"])), ("ok", 10))
        self.assertEqual(page.url, original)
        self.assertEqual(page.navigations, [])
        self.assertEqual(page.clicked, 0)

    def test_wos_empty_summary_timeout_keeps_original_page_and_binding(self):
        empty = snapshot(resultContainer=True, visible_result_count=50, loaded_title_count=0)
        page = self.wos_summary(empty, page_number=2)
        original, binding = page.url, (self.job / "browser-tabs.json").read_bytes()
        with patch.object(adapter.time, "monotonic", side_effect=[0, 16]), \
                patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve summary")), \
                patch.object(adapter, "_submit_wos", side_effect=AssertionError("preserve summary")), \
                patch.object(adapter, "_advance_page", side_effect=AssertionError("empty page never advances")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertEqual(result["message"], adapter._WOS_LOADING_MESSAGE)
        self.assertEqual(result["results"], [])
        self.assertEqual(page.url, original)
        self.assertEqual((self.job / "browser-tabs.json").read_bytes(), binding)

    def test_wos_page_two_delayed_titles_never_become_first_page_or_restart(self):
        empty = snapshot(resultContainer=True, visible_result_count=1, loaded_title_count=0)
        page = self.wos_summary(empty, page_number=2)
        loaded = snapshot(results=[ROW], resultContainer=True, visible_result_count=1, loaded_title_count=1)
        with patch.object(adapter, "_snapshot", side_effect=[empty, loaded]), patch.object(adapter.time, "sleep"), \
                patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve page two")), \
                patch.object(adapter, "_submit_wos", side_effect=AssertionError("preserve page two")):
            result = self.call("web-of-science", resume=True)
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["message"], adapter._WOS_PROOF_MESSAGE)
        self.assertTrue(page.url.endswith("/2"))
        self.assertEqual(result["results"], [])

    def test_wos_bound_loaded_summary_missing_or_changed_query_never_restarts(self):
        for queries in ([], ["different scientific query"]):
            with self.subTest(queries=queries):
                self.context = Context(snapshot())
                page = self.wos_summary(snapshot(queries=queries, results=[ROW], resultContainer=True))
                with patch.object(adapter, "_navigate_search", side_effect=AssertionError("preserve summary")), \
                        patch.object(adapter, "_submit_wos", side_effect=AssertionError("preserve summary")):
                    result = self.call("web-of-science", resume=True)
                self.assertEqual(result["message"], adapter._WOS_PROOF_MESSAGE)
                self.assertTrue(page.url.endswith("/1"))

    def test_wos_auth_or_524_during_title_wait_keeps_real_classification(self):
        for changes, reason in (({"captcha": True}, "verification"), ({"password": True}, "login"),
                                ({"accessRequired": True}, "access_required"),
                                ({"service_error": "wos_timeout_524"}, "results_unrecognized")):
            with self.subTest(reason=reason, changes=changes):
                self.context = Context(snapshot())
                empty = snapshot(resultContainer=True, visible_result_count=1, loaded_title_count=0)
                self.wos_summary(empty)
                interrupted = {**empty, **changes}
                with patch.object(adapter, "_snapshot", side_effect=[empty, interrupted]), \
                        patch.object(adapter.time, "sleep"), \
                        patch.object(adapter, "_navigate_search", side_effect=AssertionError("no auth refresh")):
                    result = self.call("web-of-science", resume=True)
                self.assertEqual(result["reason"], reason)
                self.assertNotEqual(result["message"], adapter._WOS_LOADING_MESSAGE)
                if "service_error" in changes:
                    self.assertEqual(result["message"], adapter._WOS_TIMEOUT_MESSAGE)

    def test_wos_formal_partial_titles_wait_before_accepting_whole_page(self):
        partial = snapshot(results=[ROW], resultContainer=True, visible_result_count=2, loaded_title_count=1)
        page = self.wos_summary(partial)
        complete = {**partial, "results": [ROW, {**ROW, "title": "Second paper"}], "loaded_title_count": 2}
        with patch.object(adapter, "_snapshot", side_effect=[partial, complete]), patch.object(adapter.time, "sleep"), \
                patch.object(adapter, "_submit_wos", side_effect=AssertionError("keep current page")):
            result = self.call("web-of-science", resume=True, full_page=True)
        self.assertEqual((result["status"], len(result["results"])), ("ok", 2))
        self.assertTrue(page.url.endswith("/1"))

    def test_wos_formal_partial_titles_timeout_returns_no_partial_page(self):
        partial = snapshot(results=[ROW], resultContainer=True, visible_result_count=2, loaded_title_count=1)
        self.wos_summary(partial)
        with patch.object(adapter.time, "monotonic", side_effect=[0, 16]):
            result = self.call("web-of-science", resume=True, full_page=True)
        self.assertEqual(result["message"], adapter._WOS_LOADING_MESSAGE)
        self.assertEqual(result["results"], [])

    def test_wos_empty_or_partial_current_page_cannot_click_next(self):
        page = Page("fixture", snapshot())
        for previous in (snapshot(), snapshot(results=[ROW], visible_result_count=2, loaded_title_count=1)):
            with patch.object(adapter, "_next_control", side_effect=AssertionError("no Next lookup")):
                self.assertIsNone(adapter._advance_page(page, "web-of-science", previous, 200))

    def test_actual_wos_cloudflare_524_dom_is_service_timeout_not_auth_or_zero(self):
        from test_literature_extra_sources import dom_snapshot
        state = dom_snapshot("web-of-science", {"header": {"text": "A timeout occurred Error code 524"}},
            {"h1": ["header"]}, head="A timeout occurred Error code 524 Browser Working Cloudflare Working Host Error Sign In Register",
            script=adapter._SNAPSHOT_JS)
        self.assertEqual(state["service_error"], "wos_timeout_524")
        self.assertFalse(state["captcha"])
        self.assertFalse(state["password"])
        self.assertFalse(state["loginPrompt"])
        self.assertFalse(state["noResults"])
        page = Page("wos-524", state)
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        self.assertIsNone(adapter._auth_reason(page, state))
        self.context.pages.append(page)
        adapter._save_binding(self.job, "web-of-science", page.target)
        with patch.object(adapter, "_navigate_search", side_effect=AssertionError("initial error detection must pause")):
            result = self.call("web-of-science")
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertIn("524", result["message"])
        self.assertIn("无需反复登录", result["message"])
        self.assertEqual(result["results"], [])

    def test_wos_524_only_uses_visible_error_evidence(self):
        from test_literature_extra_sources import dom_snapshot
        for nodes, mapping in (
            ({"header": {"text": "Error code 524", "hidden": True}}, {"h1": ["header"]}),
            ({"paper": {"text": "An article mentioning Error code 524"}}, {".summary-record": ["paper"]}),
        ):
            state = dom_snapshot("web-of-science", nodes, mapping, head="Reference text mentions Error code 524", script=adapter._SNAPSHOT_JS)
            self.assertIsNone(state["service_error"])

    def test_wos_old_524_retries_official_entry_once_on_explicit_continue(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
        page.dom = snapshot(queries=[], service_error="wos_timeout_524")
        adapter._save_binding(self.job, "web-of-science", page.target)

        def recovered_official_entry(url, **kwargs):
            self.assertEqual(url, adapter.SOURCES["web-of-science"][1])
            page.url = "https://webofscience.clarivate.cn/wos/woscc/basic-search"
            page.dom = snapshot(queries=[], results=[])
            page.has_form = True

        with patch.object(page, "goto", side_effect=recovered_official_entry) as navigate:
            result = self.call("web-of-science", resume=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(navigate.call_count, 1)
        self.assertEqual(page.clicked, 1)
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(len(self.context.pages), 1)

    def test_wos_524_after_a_page_exception_keeps_its_specific_message(self):
        page = self.context.new_page()
        page.url = "https://webofscience.clarivate.cn/wos/"
        adapter._save_binding(self.job, "web-of-science", page.target)
        reads = [0]

        def changing_dom(*args):
            reads[0] += 1
            if reads[0] == 1:
                raise RuntimeError("private navigation context destroyed")
            return snapshot(queries=[], service_error="wos_timeout_524")

        with patch.object(adapter, "_snapshot", side_effect=changing_dom):
            result = self.call("web-of-science", resume=True)
        self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
        self.assertIn("524", result["message"])
        self.assertNotIn("private navigation", json.dumps(result))

    def test_wos_login_redirect_and_result_auth_links_are_redacted(self):
        page = self.context.new_page()
        page.url = "https://auth.example.edu/saml/login?ticket=secret-token"
        page.dom = snapshot(queries=[])
        adapter._save_binding(self.job, "web-of-science", page.target)
        # The official recheck still redirects to this unresolved SSO page.
        with patch.object(adapter, "_navigate_search", return_value=False) as navigate:
            result = self.call("web-of-science", resume=True)
        self.assertEqual(navigate.call_count, 1)
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
            # Model the official entry point redirecting back to the same
            # required login/access page after the explicit resume recheck.
            with patch.object(adapter, "_navigate_search", return_value=False) as navigate:
                result = self.call("web-of-science", resume=True)
            self.assertEqual(navigate.call_count, 1)
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

    def test_sso_new_tab_completion_replays_to_formal_pending_page_without_skip(self):
        page = self.paged(count=4, rows=20)
        first = self.call(full_page=True)
        second = self.call(page_index=1, full_page=True)
        page.dom = snapshot(password=True, queries=[])
        page.url = "https://passport.cnki.net/login"
        waiting = self.call(page_index=2, full_page=True)
        self.assertEqual(waiting["reason"], "login")
        restored = self.call(resume=True, page_index=2, full_page=True)
        self.assertEqual(restored["status"], "ok")
        self.assertEqual(len(self.context.pages), 1)
        self.assertEqual(len(page.navigations), 2)
        self.assertEqual(page.next_clicks, 3)  # first 0->1, then replay 0->1->2
        self.assertEqual(len(first["results"]), 20)
        self.assertEqual(len(second["results"]), 20)
        self.assertEqual(len(restored["results"]), 20)
        self.assertIn("Page 2", restored["results"][0]["title"])
        binding = json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))["cnki"]
        self.assertEqual(binding["target_id"], page.target)
        self.assertEqual(binding["page_index"], 2)

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

    def test_bound_source_page_above_999_is_not_rejected(self):
        import hashlib
        page = self.paged()
        page.position = 2
        page.dom = copy.deepcopy(page.result_pages[2])
        page.url = adapter.SOURCES["cnki"][1]
        adapter._save_binding(self.job, "cnki", page.target,
            hashlib.sha256(QUERY.encode("utf-8")).hexdigest(),
            page_index=1000, result_fingerprint=adapter._row_fingerprint(page.dom))
        result = self.call(page_index=1000, full_page=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["page_index"], 1000)
        self.assertIn("Page 2", result["results"][0]["title"])
        self.assertEqual(page.next_clicks, 0)

    def test_scholar_display_cap_keeps_current_rows_before_pause(self):
        import hashlib
        page = Page("scholar-cap", snapshot(results=[ROW] * 10, resultContainer=True))
        page.url = "https://scholar.google.com/scholar?q=broiler&start=990"
        self.context.pages.append(page)
        adapter._save_binding(self.job, "google-scholar", page.target,
            hashlib.sha256(QUERY.encode("utf-8")).hexdigest(),
            page_index=99, result_fingerprint=adapter._row_fingerprint(page.dom))
        with patch.object(adapter, "_pagination", return_value={"has_next": False, "total_count": 5000}):
            result = self.call("google-scholar", page_index=99, full_page=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["results"]), 10)
        self.assertTrue(result["source_limit_reached"])
        self.assertTrue(result["has_next"])
        self.assertIn("1000", result["source_limit_message"])

    def test_scholar_thousandth_result_with_more_hits_is_not_complete(self):
        page = Page("scholar", snapshot(results=[ROW] * 10))
        page.url = "https://scholar.google.com/scholar?q=broiler&start=990"
        result = adapter._source_pagination(page, "google-scholar", page.dom,
            {"has_next": None, "total_count": 5000})
        self.assertTrue(result["source_limit_reached"])
        self.assertTrue(result["has_next"])

    def test_scholar_real_end_with_matching_count_is_unchanged(self):
        page = Page("scholar", snapshot(results=[ROW] * 5))
        page.url = "https://scholar.google.com/scholar?q=broiler&start=10"
        result = adapter._source_pagination(page, "google-scholar", page.dom,
            {"has_next": False, "total_count": 15})
        self.assertFalse(result["has_next"])
        self.assertNotIn("source_limit_reached", result)

    def test_scholar_estimated_total_does_not_override_disabled_next_below_cap(self):
        page = Page("scholar", snapshot(results=[ROW] * 5))
        page.url = "https://scholar.google.com/scholar?q=broiler&start=10"
        result = adapter._source_pagination(page, "google-scholar", page.dom,
            {"has_next": False, "total_count": 41})
        self.assertFalse(result["has_next"])
        self.assertNotIn("source_limit_reached", result)

    def test_scholar_estimated_total_keeps_missing_next_unknown_below_cap(self):
        page = Page("scholar", snapshot(results=[ROW] * 5))
        page.url = "https://scholar.google.com/scholar?q=broiler&start=10"
        result = adapter._source_pagination(page, "google-scholar", page.dom,
            {"has_next": None, "total_count": 41})
        self.assertIsNone(result["has_next"])
        self.assertNotIn("source_limit_reached", result)

    def test_scholar_unknown_count_does_not_invent_source_limit_or_end(self):
        page = Page("scholar", snapshot(results=[ROW]))
        page.url = "https://scholar.google.com/scholar?q=broiler"
        result = adapter._source_pagination(page, "google-scholar", page.dom,
            {"has_next": None, "total_count": None})
        self.assertIsNone(result["has_next"])
        self.assertNotIn("source_limit_reached", result)

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

    def test_pubmed_source_limit_attention_does_not_open_browser(self):
        limited = {"status": "attention", "reason": "results_unrecognized", "results": [],
                   "has_next": None, "source_limit_reached": True, "page_index": 1000}
        with patch.object(adapter.literature_pubmed, "run", return_value=limited), \
                patch.object(adapter, "_runtime", side_effect=AssertionError("source cap is not browser fallback")):
            result = self.call("pubmed", page_index=1000, full_page=True)
        self.assertEqual(result, limited)

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
