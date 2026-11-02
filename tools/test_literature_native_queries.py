"""Native advanced-search contracts. Entirely local; no source requests."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import literature_browser as browser
import literature_native_queries as native
import test_literature_browser as fixtures


QUERIES = {
    "web-of-science": 'TI=(cattle) AND AK=(methane) AND DOP=2000-01-01/2026-10-31',
    "scopus": 'TITLE-ABS(cattle) AND AUTHKEY(methane) AND PUBYEAR AFT 1999 AND PUBYEAR BEF 2027',
    "cnki": "TKA=('牛'+'羊') AND TI=('气温')",
    "wanfang": '主题:(牛 OR 羊) AND 题名或关键词:(温度)',
}

NODE_DOM = r'''
const fs=require('fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));
class El {
 constructor(data={}){Object.assign(this,data);this.map=this.map||{};this.offsetWidth=this.hidden?0:1;this.offsetHeight=0;this.tagName=(this.tagName||'DIV').toUpperCase();}
 get innerText(){return this.text||'';}get textContent(){return this.text||'';}
 get parentElement(){return nodes[this.parent]||null;}
 getClientRects(){return this.hidden?[]:[{}];}
 getAttribute(key){return this.attrs?.[key]||null;}
 querySelectorAll(s){return [...new Set((this.map[s]||s.split(',').flatMap(x=>this.map[x]||[])).map(k=>nodes[k]))];}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 contains(other){for(let p=other;p;p=p.parentElement)if(p===this)return true;return false;}
}
const nodes={};for(const [key,data] of Object.entries(input.nodes))nodes[key]=new El(data);
const document=new El({map:input.map});document.body=nodes.body||new El();
global.getComputedStyle=el=>({visibility:el.hidden?'hidden':'visible',display:el.hidden?'none':'block'});
process.stdout.write(JSON.stringify(eval('('+input.script+')')({source:input.source})));
'''


def dom(source, **changes):
    label = {"web-of-science": "Query Builder", "scopus": "Advanced search", "cnki": "专业检索", "wanfang": "专业检索"}[source]
    placeholder = {"web-of-science": "Enter or edit your query here. You can also combine previous searches e.g. #5 AND #2",
                   "scopus": "Advanced search query", "cnki": "", "wanfang": ""}[source]
    nodes = {
        "body": {}, "pane": {"parent": "body"}, "tab": {"text": label},
        "editor": {"tagName": "TEXTAREA", "parent": "pane", "attrs": {"placeholder": placeholder}, "value": "", "maxLength": 800},
        "search": {"tagName": "BUTTON", "parent": "pane", "text": "Search" if source in ("web-of-science", "scopus") else "检索"},
        "add": {"tagName": "BUTTON", "parent": "pane", "text": "Add to query"},
    }
    mapping = {".active": ["tab"], "textarea": ["editor"], "button": ["search", "add"]}
    nodes.update(changes.get("nodes", {}));mapping.update(changes.get("mapping", {}))
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("Node required for isolated production DOM-script test")
    result = subprocess.run([node, "-e", NODE_DOM], input=json.dumps({"nodes": nodes, "map": mapping,
        "source": source, "script": native.PROBE_JS}), text=True, encoding="utf-8", capture_output=True, check=True)
    return json.loads(result.stdout)


def state(source, query=""):
    return {"editor": {"index": 0, "label": "native editor", "value": query, "maxLength": 32768},
            "button": {"index": 0, "label": "Search"}, "entry": None, "modeVerified": True,
            "years": [{"role": role, "index": index, "label": role, "tag": "select", "value": str(year),
                       "options": [{"label": f"{year}年", "value": str(year)}]}
                      for index, (role, year) in enumerate((("from", 2000), ("to", 2026)))],
            "summaries": [], "dateSummaries": [], "syntaxError": False, "pageNumber": None}


class NativeLocator:
    def __init__(self, page, selector, index=0):
        self.page, self.selector, self.index = page, selector, index
    def nth(self, index):
        return NativeLocator(self.page, self.selector, index)
    def fill(self, value):
        self.page.fills.append(value)
        self.page.native["editor"]["value"] = value[:-1] if self.page.truncate else value
        if self.page.block_after_fill:
            self.page.block = self.page.block_after_fill
    def select_option(self, value):
        self.page.year_changes.append((self.index, value))
        self.page.native["years"][self.index]["value"] = value
    def click(self, **kwargs):
        if self.selector == native.ENTRY_SELECTOR:
            self.page.entries += 1
            self.page.native = self.page.after_entry
            return
        self.page.submits += 1
        self.page.position = 0
        self.page.native["summaries"] = self.page.result_summary
        self.page.native["pageNumber"] = 1
        self.page.dom = copy.deepcopy(self.page.result_pages[0])
        if self.page.block_after_submit:
            self.page.block = self.page.block_after_submit


class NativePage:
    def __init__(self, source):
        self.source = source
        self.target = "native-" + source
        self.url = "about:blank"
        self.native = state(source)
        self.result_summary = [QUERIES[source]]
        self.dom = fixtures.snapshot()
        self.result_pages = [fixtures.snapshot(results=[{**fixtures.ROW, "title": f"Native page {i}"}], resultContainer=True, visible_result_count=1) for i in range(2)]
        self.position, self.submits, self.entries, self.next_clicks = 0, 0, 0, 0
        self.fills, self.navigations, self.year_changes = [], [], []
        self.block = self.block_after_fill = self.block_after_submit = None
        self.truncate = False
    def evaluate(self, script, args=None):
        if "literature_native_probe" in script:
            return copy.deepcopy(self.native)
        if "literature_cnki_visible_dates" in script:
            return {row["role"]: row["value"] for row in self.native.get("years", [])
                    if row.get("tag") == "cnki-date"}
        if "literature_snapshot_access_state" in script:
            return {self.block: True} if self.block else {}
        raise AssertionError("Unplanned DOM script")
    def goto(self, url, **kwargs):
        self.navigations.append(url);self.url = url
    def bring_to_front(self):
        pass
    def locator(self, selector):
        return NativeLocator(self, selector)


class NativeDOMTests(unittest.TestCase):
    def test_native_modes_and_unique_final_search_are_positive_proofs(self):
        for source in QUERIES:
            with self.subTest(source=source):
                result = dom(source)
                self.assertTrue(result["modeVerified"])
                self.assertEqual(result["editor"]["index"], 0)
                self.assertEqual(result["button"]["index"], 0)
    def test_basic_page_navigation_link_is_not_an_active_professional_editor(self):
        for source in ("cnki", "wanfang", "scopus"):
            with self.subTest(source=source):
                result = dom(source, mapping={".active": [], "a": ["tab"]})
                self.assertIsNone(result["editor"])
                self.assertIsNotNone(result["entry"])
    def test_multiple_editors_or_search_buttons_fail_closed(self):
        result = dom("wanfang", nodes={"second": {"tagName": "TEXTAREA", "parent": "pane"}}, mapping={"textarea": ["editor", "second"]})
        self.assertIsNone(result["editor"])
        result = dom("web-of-science", nodes={"second": {"tagName": "BUTTON", "text": "Search", "parent": "pane"}}, mapping={"button": ["search", "second"]})
        self.assertIsNone(result["button"])
    def test_hidden_mode_does_not_authorize_submit(self):
        result = dom("cnki", nodes={"tab": {"text": "专业检索", "hidden": True}})
        self.assertIsNone(result["editor"])
    def test_execution_summary_never_comes_from_editor_or_its_wrapper(self):
        result = dom("web-of-science", nodes={"wrapper": {"text": QUERIES["web-of-science"], "map": {"textarea": ["editor"]}},
                    "resultquery": {"text": "检索表达式：" + QUERIES["web-of-science"]}},
                     mapping={".search-query": ["editor", "wrapper", "resultquery"]})
        self.assertEqual(result["summaries"], ["检索表达式：" + QUERIES["web-of-science"]])
    def test_labelled_dates_and_explicit_syntax_errors_are_extracted(self):
        result = dom("wanfang", nodes={"from": {"tagName": "SELECT", "value": "2000", "attrs": {"aria-label": "开始年份"}},
                    "to": {"tagName": "SELECT", "value": "2026", "attrs": {"aria-label": "结束年份"}},
                    "err": {"text": "检索式语法错误"}}, mapping={"select": ["from", "to"], '[role="alert"]': ["err"]})
        self.assertEqual([(x["role"], x["value"]) for x in result["years"]], [("from", "2000"), ("to", "2026")])
        self.assertTrue(result["syntaxError"])
    def test_results_require_full_query_and_matching_years(self):
        for source, query in QUERIES.items():
            with self.subTest(source=source):
                current = state(source);current["summaries"] = [query]
                self.assertTrue(native.result_proof(current, source, query, 2000, 2026))
                self.assertFalse(native.result_proof(current, source, query + " OR fish", 2000, 2026))
                self.assertFalse(native.result_proof(current, source, query, 2001, 2027))
                current["years"][0]["value"] = "2010"
                self.assertFalse(native.result_proof(current, source, query, 2000, 2026))
                current["years"][0]["value"] = "2000"
                current["summaries"] = [query[:15] + "..."]
                self.assertFalse(native.result_proof(current, source, query, 2000, 2026))


class NativeFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-query-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        self.page = NativePage("web-of-science")
        self.pages = []
        class Context:
            pages = self.pages
            def new_page(_self):
                self.pages.append(self.page)
                return self.page
            def new_cdp_session(_self, page):
                return fixtures.CDPSession(page)
        self.context = Context()
        @contextmanager
        def runtime():
            yield self.context
        def snapshot(page, source, limit):
            return {**copy.deepcopy(page.dom), **({page.block: True} if page.block else {})}
        class Next:
            def click(_self, **kwargs):
                self.page.next_clicks += 1;self.page.position += 1
                self.page.dom = copy.deepcopy(self.page.result_pages[self.page.position])
                self.page.native["pageNumber"] = self.page.position + 1
        patches = [patch.object(browser, "_runtime", runtime), patch.object(browser, "_snapshot", snapshot),
                   patch.object(browser, "_pagination", lambda page, source: {"has_next": page.position == 0, "total_count": 2}),
                   patch.object(browser, "_next_control", lambda *a: Next()), patch.object(browser, "_control_disabled", return_value=False),
                   patch.object(browser.extra_sources, "resolve_result_links", side_effect=lambda p,s,r,l:r)]
        for item in patches:
            item.start();self.addCleanup(item.stop)
    def call(self, source=None, **kwargs):
        source = source or self.page.source
        return browser.run(source, QUERIES[source], False, 10, 2000, 2026, job_dir=self.job, full_page=True, **kwargs)
    def binding(self):
        return json.loads((self.job / "browser-tabs.json").read_text(encoding="utf-8"))[self.page.source]
    def cnki_without_summary(self):
        self.page = NativePage("cnki")
        self.page.result_summary = []
        for row in self.page.native["years"]:
            row["tag"] = "cnki-date"
            row["value"] = "2000-01-01" if row["role"] == "from" else "2026-12-31"
    def test_cnki_witnessed_submit_without_summary_persists_a_visible_ui_receipt(self):
        self.cnki_without_summary()
        result = self.call()
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(self.page.native["summaries"], [])
        self.assertEqual((self.page.submits, self.page.fills), (1, [QUERIES["cnki"]]))
        receipt = self.binding()["native_query_proof"]["cnki_receipt"]
        self.assertEqual(receipt["version"], "cnki-visible-submit-chain-v1")
        self.assertEqual(receipt["page_index"], 0)
        self.assertEqual(receipt["result_fingerprint"], browser._row_fingerprint(self.page.dom))
        self.assertEqual(receipt["bounds"], {"from": "2000-01-01", "to": "2026-12-31"})
    def test_cnki_receipt_resume_and_successive_next_pages_do_not_repeat_submit(self):
        self.cnki_without_summary()
        self.page.result_pages.append(fixtures.snapshot(results=[{**fixtures.ROW, "title": "Native page 2"}],
                                                       resultContainer=True, visible_result_count=1))
        with patch.object(browser, "_pagination", lambda page, source: {
                "has_next": page.position < len(page.result_pages) - 1, "total_count": 3}):
            self.assertEqual(self.call()["status"], "ok")
            self.assertEqual(self.call()["status"], "ok", "An unchanged first page resumes from its persisted receipt")
            for index in (1, 2):
                result = self.call(page_index=index)
                self.assertEqual(result["status"], "ok", result)
                receipt = self.binding()["native_query_proof"]["cnki_receipt"]
                self.assertEqual(receipt["page_index"], index)
                self.assertEqual(receipt["previous_page_index"], index - 1)
                self.assertEqual(receipt["result_fingerprint"], browser._row_fingerprint(self.page.dom))
                self.assertEqual(self.call(page_index=index)["status"], "ok")
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 2))
        self.assertEqual(self.binding()["page_index"], 2)
    def test_cnki_receipt_rejects_edited_query_without_rebinding_or_paging(self):
        self.cnki_without_summary()
        self.assertEqual(self.call()["status"], "ok")
        before = self.binding()
        self.page.native["editor"]["value"] += " OR TI=('其他条件')"
        result = self.call(page_index=1)
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["reason"], "results_unrecognized")
        self.assertEqual(result["results"], [])
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 0))
        self.assertEqual(self.binding(), before)
    def test_cnki_results_appearing_in_before_click_callback_prevent_submit(self):
        self.cnki_without_summary()
        self.page.url = browser.SOURCES["cnki"][1]
        failure, submission, observed = {}, {}, []
        def results_arrived_before_click():
            observed.append(self.page.native["editor"]["value"])
            self.page.dom = copy.deepcopy(self.page.result_pages[0])
            return copy.deepcopy(self.page.dom)
        self.assertFalse(native.submit(self.page, "cnki", QUERIES["cnki"], 2000, 2026,
            failure_out=failure, submission_out=submission,
            before_click_snapshot=results_arrived_before_click))
        self.assertEqual(observed, [QUERIES["cnki"]], "Callback observes the fully written editor")
        self.assertEqual(self.page.submits, 0, "Late existing results must not be overwritten by a submit click")
        self.assertNotEqual(submission.get("clicked_normally"), True)
        self.assertEqual(failure["diagnostics"]["native_failure_code"], "native_navigation_unverified")
        self.assertEqual(self.page.dom["results"], self.page.result_pages[0]["results"])
    def test_four_native_queries_submit_and_require_execution_proof(self):
        for source in QUERIES:
            with self.subTest(source=source):
                self.page = NativePage(source)
                result = self.call()
                self.assertEqual(result["status"], "ok", result)
                self.assertEqual(self.page.fills, [QUERIES[source]])
                self.assertEqual(self.page.submits, 1)
                self.assertTrue(result["diagnostics"]["native_execution_verified"])
                self.assertEqual(result["applied_filters"], {"publicationYearFrom": 2000, "publicationYearTo": 2026})
                self.assertEqual(self.binding()["native_query_proof"]["version"], native.PROOF)
    def test_native_checkpoint_advances_once_and_reuses_verified_current_page(self):
        self.assertEqual(self.call()["status"], "ok")
        result = self.call(page_index=1)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(self.page.next_clicks, 1)
        self.assertEqual(self.call(page_index=1)["status"], "ok")
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 1))
        self.assertEqual(self.binding()["page_index"], 1)
    def test_changed_rows_or_query_do_not_replay_or_rebind(self):
        self.assertEqual(self.call()["status"], "ok")
        before = self.binding()
        self.page.dom["results"][0]["title"] = "resorted page"
        self.assertEqual(self.call(page_index=1)["status"], "attention")
        self.assertEqual((self.page.submits, self.page.next_clicks), (1, 0))
        self.assertEqual(self.binding(), before)
    def test_missing_native_bound_tab_does_not_destroy_checkpoint(self):
        self.assertEqual(self.call()["status"], "ok")
        before = self.binding()
        self.pages.clear()
        self.assertEqual(self.call(page_index=1)["status"], "attention")
        self.assertEqual(self.pages, [])
        self.assertEqual(self.binding(), before)
    def test_editor_echo_and_result_count_without_execution_summary_are_not_success(self):
        self.page.result_summary = []
        result = self.call()
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("native_query_proof", self.binding())
        self.assertEqual(result["results"], [])
        self.assertIsNone(result["has_next"])
    def test_empty_results_need_explicit_zero_and_correct_query(self):
        self.page.result_pages = [fixtures.snapshot(noResults=True, resultContainer=True)]
        self.assertEqual(self.call()["status"], "no_results")
    def test_query_truncation_or_character_cap_never_submits(self):
        self.page.native["editor"]["maxLength"] = 10
        self.assertEqual(self.call()["status"], "attention")
        self.assertEqual(self.page.fills, [])
        self.page.native["editor"]["maxLength"] = 32768;self.page.truncate = True
        self.assertEqual(self.call()["status"], "attention")
        self.assertEqual(self.page.submits, 0)
    def test_challenge_or_rate_limit_before_submit_never_retries(self):
        for marker, reason in (("captcha", "verification"), ("rateLimited", "rate_limited"), ("accessBlocked", "access_blocked")):
            with self.subTest(marker=marker):
                self.page.block = marker
                result = self.call()
                self.assertEqual(result["reason"], reason)
                self.assertEqual(self.page.submits, 0)
                self.assertEqual(self.page.fills, [])
    def test_new_block_after_fill_prevents_submit(self):
        self.page.block_after_fill = "rateLimited"
        self.assertEqual(self.call()["reason"], "rate_limited")
        self.assertEqual(self.page.submits, 0)
    def test_post_submit_block_never_saves_result_proof(self):
        self.page.block_after_submit = "captcha"
        self.assertEqual(self.call()["reason"], "verification")
        self.assertNotIn("native_query_proof", self.binding())
    def test_unknown_professional_form_and_external_years_fail_closed(self):
        self.page = NativePage("wanfang");self.page.native["years"] = []
        self.assertEqual(self.call()["status"], "attention")
        self.assertEqual(self.page.submits, 0)
        self.page.native["editor"] = None
        self.assertEqual(self.call()["status"], "attention")
        self.assertEqual(self.page.fills, [])
    def test_visible_labelled_select_years_can_be_set_then_verified(self):
        self.page = NativePage("wanfang");self.page.native["years"][0]["value"] = "2010"
        self.assertEqual(self.call()["status"], "ok")
        self.assertEqual(self.page.year_changes, [(0, "2000")])
    def test_native_navigation_uses_only_explicit_visible_entry(self):
        self.page.after_entry = copy.deepcopy(self.page.native)
        self.page.native = {"entry": {"index": 0, "label": "Advanced search", "href": "/advanced"}}
        self.assertEqual(self.call()["status"], "ok")
        self.assertEqual(self.page.entries, 1)
    def test_wos_other_collection_cannot_submit_core_collection_query(self):
        self.page.url = "https://www.webofscience.com/wos/alldb/advanced-search"
        self.assertFalse(native.submit(self.page, "web-of-science", QUERIES["web-of-science"], 2000, 2026))
        self.assertEqual(self.page.fills, [])
        self.assertEqual(self.page.submits, 0)
    def test_official_entry_cannot_follow_external_or_protocol_relative_host(self):
        for href in ("https://attacker.invalid/advanced", "//attacker.invalid/advanced"):
            with self.subTest(href=href):
                self.page.native = {"entry": {"index": 0, "label": "Advanced search", "href": href}}
                self.assertEqual(self.call()["status"], "attention")
        self.assertEqual(self.page.entries, 0)

    def test_all_eight_actual_frozen_queries_reach_only_native_editor(self):
        catalog = json.loads((Path(__file__).resolve().parents[1] / "config" / "confirmed-climate-research.json").read_text(encoding="utf-8"))
        for entry in [item for item in catalog["entries"] if item["source"] in QUERIES]:
            with self.subTest(preset=entry["id"]):
                self.pages.clear()
                self.page = NativePage(entry["source"])
                self.page.result_summary = [entry["query"]]
                job = self.job / entry["id"]
                with patch.object(browser, "_navigate_search", side_effect=AssertionError("No basic submit")):
                    result = browser.run(entry["source"], entry["query"], False, 10, 2000, 2026, job_dir=job, full_page=True)
                self.assertEqual(result["status"], "ok", result)
                self.assertEqual(self.page.fills, [entry["query"]])


if __name__ == "__main__":
    unittest.main()
