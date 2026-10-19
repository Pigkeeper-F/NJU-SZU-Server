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


if __name__ == "__main__":
    unittest.main()
