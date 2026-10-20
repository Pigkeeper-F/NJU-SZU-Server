"""Additional source adapter tests; only DOM fixtures and mock controls are used."""
import copy
import json
import shutil
import subprocess
import unittest
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

import literature_extra_sources as adapter


QUERY = 'broiler "heat stress"'


class Empty:
    def count(self):
        return 0


class Control:
    def __init__(self, page, kind):
        self.page, self.kind = page, kind

    def count(self):
        return 1

    def nth(self, index):
        return self

    def is_visible(self):
        return True

    def fill(self, value):
        self.page.filled = value if self.page.fill_applies else "changed unexpectedly"

    def input_value(self):
        return self.page.filled

    def click(self):
        self.page.clicked += 1

    def select_option(self, value):
        if self.kind != "picker":
            raise AssertionError("not a field picker")
        self.page.selected = value
        if self.page.selection_applies:
            self.page.fields = "Article title, Abstract, Keywords"


class Page:
    def __init__(self, source, form=True, modern=False):
        self.source = source
        self.form = form
        self.modern = modern
        self.document_mode = True
        self.fields = "Article title, Abstract, Keywords"
        self.selection_applies = True
        self.fill_applies = True
        self.selected = None
        self.filled = None
        self.clicked = 0
        self.visited = []

    def goto(self, url, **kwargs):
        self.visited.append(url)

    def wait_for_selector(self, selector, **kwargs):
        pass

    def evaluate(self, script, arguments=None):
        if "scopus_document_mode" in script:
            return self.document_mode
        if "scopus_search_field" in script:
            return self.fields
        raise AssertionError("unknown fixture script")

    def locator(self, selector):
        if not self.form:
            return Empty()
        fields = {'#basic-panel input[id^="autosuggest-"]'} if self.modern else {'input#searchterm1', 'input#search-input'}
        buttons = {'button#search', 'button.search-btn'}
        if selector in fields:
            return Control(self, "input")
        if selector in buttons:
            return Control(self, "button")
        picker = '#basic-panel select[data-testid="select-search-within"]' if self.modern else 'select#field1'
        if selector == picker:
            return Control(self, "picker")
        return Empty()

    def get_by_role(self, role, *, name, exact):
        if self.source != "wanfang":
            raise AssertionError("Scopus submission must keep its existing controls")
        assert role == "button" and exact is True
        return Control(self, "button") if self.form and name == "检索" else Empty()


# This small DOM implements only the selector/visibility APIs consumed by the
# production extraction script.  Running that exact script catches extraction
# bugs that a page.evaluate() stub returning an already-made result would miss.
NODE_DOM = r"""
const fs=require('fs');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
class El {
 constructor(data={}) { Object.assign(this,data); this.offsetWidth=this.hidden?0:1; this.offsetHeight=0; this.map=this.map||{}; }
 get innerText(){return this.text||'';}
 get textContent(){return this.text||'';}
 getClientRects(){return this.hidden?[]:[{}];}
 querySelectorAll(selector){
   const keys=this.map[selector]||selector.split(',').flatMap(part=>this.map[part]||[]);
   return [...new Set(keys.map(key=>nodes[key]))];
 }
 getAttribute(name){return this.attrs?.[name]||null;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return nodes[this.parent]||null;}
}
const nodes={}; for(const [key,data] of Object.entries(input.nodes)) nodes[key]=new El(data);
const document=new El({map:input.map}); document.body=new El({text:input.head||''});
global.getComputedStyle=el=>({visibility:el.hidden?'hidden':'visible',display:el.hidden?'none':'block'});
const result=eval('('+input.script+')')({source:input.source,limit:input.limit||10});
process.stdout.write(JSON.stringify(result));
"""


def dom_snapshot(source, nodes=None, mapping=None, head="", limit=10, script=None):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("Node.js is required for fixture-only DOM extraction tests")
    payload = {"script": script or adapter._SNAPSHOT_JS, "source": source, "nodes": nodes or {},
               "map": mapping or {}, "head": head, "limit": limit}
    process = subprocess.run([node, "-e", NODE_DOM], input=json.dumps(payload),
                             text=True, encoding="utf-8", capture_output=True, check=True)
    return json.loads(process.stdout)


def bibliographic_fixture(source):
    prefix = {"wanfang": ".record-item", "scopus": '[data-testid="search-result"]',
              "pubmed": "article.full-docsum"}[source]
    title_selector = {"wanfang": ".title a", "scopus": 'a[data-testid="document-title"]',
                      "pubmed": "a.docsum-title"}[source]
    author_selector = {"wanfang": ".authors", "scopus": '[data-testid="authors"]',
                       "pubmed": ".docsum-authors.full-authors"}[source]
    venue_selector = {"wanfang": ".source", "scopus": '[data-testid="source-title"]',
                      "pubmed": ".docsum-journal-citation.full-journal-citation"}[source]
    year_selector = {"wanfang": ".year", "scopus": '[data-testid="publication-year"]',
                     "pubmed": ".docsum-pmid"}[source]
    url = {"wanfang": "https://d.wanfangdata.com.cn/periodical/example202401",
           "scopus": "https://www.scopus.com/record/display.uri?eid=2-s2.0-123",
           "pubmed": "https://pubmed.ncbi.nlm.nih.gov/12345678/"}[source]
    nodes = {
        "row": {"text": "Heat stress research 10.1234/test.2024", "map": {
            title_selector: ["title"], author_selector: ["authors"],
            venue_selector: ["venue"], year_selector: ["year"],
            'a[href*="doi.org/"]': ["doi"]}},
        "title": {"text": "Effects of heat stress on growth", "href": url,
                  "attrs": {"href": "/12345678/"}},
        "authors": {"text": "A Author; B Author"},
        "venue": {"text": "Poultry Science. 2024; 103:100."},
        "year": {"text": "12345678" if source == "pubmed" else "2024"},
        "doi": {"href": "https://doi.org/10.1234/test.2024", "text": "DOI"},
    }
    return nodes, {prefix: ["row"]}


class SourceNavigationTests(unittest.TestCase):
    def test_fixed_source_pages_and_pubmed_exact_query(self):
        page = Page("pubmed")
        self.assertTrue(adapter.navigate(page, "pubmed", QUERY, 2000, 2026))
        parsed = urlsplit(page.visited[0])
        self.assertEqual(parsed.hostname, "pubmed.ncbi.nlm.nih.gov")
        self.assertEqual(parse_qs(parsed.query), {"term": [QUERY]})
        self.assertEqual(page.clicked, 0)
        self.assertFalse(adapter.navigate(page, "unregistered", QUERY))

    def test_wanfang_submits_visible_form_and_verifies_input(self):
        page = Page("wanfang")
        self.assertTrue(adapter.navigate(page, "wanfang", QUERY))
        self.assertEqual(page.visited, [adapter.SOURCE_INFO["wanfang"][1]])
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)
        page.fill_applies = False
        self.assertFalse(adapter.navigate(page, "wanfang", QUERY))
        self.assertEqual(page.clicked, 1)

    def test_wanfang_placeholder_only_homepage_wait_fill_and_read_use_same_fields(self):
        class PlaceholderPage(Page):
            def __init__(self, selector):
                super().__init__("wanfang")
                self.selector, self.waited = selector, []

            def locator(self, selector):
                if selector == self.selector:
                    return Control(self, "input")
                if selector == 'button:text-is("检索")':
                    return Control(self, "button")
                return Empty()

            def wait_for_selector(self, selector, **kwargs):
                self.waited.append(selector)

        for selector in ('input[placeholder="海量资源, 等你发现"]',
                         'input[placeholder="海量资源，等你发现"]', 'input[placeholder^="海量资源"]'):
            with self.subTest(selector=selector):
                page = PlaceholderPage(selector)
                self.assertTrue(adapter.navigate(page, "wanfang", QUERY))
                self.assertEqual(page.filled, QUERY)
                self.assertEqual(page.clicked, 1)
                self.assertIn(selector, page.waited[0])
                state = dom_snapshot("wanfang", {"field": {"value": page.filled}},
                    {','.join(adapter.WANFANG_SEARCH_FIELDS): ["field"]},
                    head="南京大学图书馆 登录 / 注册")
                self.assertEqual(state["queries"], [QUERY])
                self.assertFalse(state["password"])
                self.assertFalse(state["loginPrompt"])
                self.assertFalse(state["accessRequired"])
                self.assertEqual(state["results"], [])
                self.assertFalse(state["noResults"])

    def test_actual_wanfang_nested_span_markup_is_submitted_by_exact_button_name(self):
        # This is the observed markup shape: no button class, an icon span and
        # a label span. The old direct-text CSS has zero matches on this DOM;
        # an accessible-name query sees the complete descendant label.
        markup = '''<main>
          <input id="search-input" placeholder="海量资源, 等你发现" />
          <button class="search-btn" type="button"><span>AI增强检索</span></button>
          <button type="button"><span aria-hidden="true"><svg /></span><span>检索</span></button>
        </main>'''

        class Button:
            def __init__(self, page, node):
                self.page, self.node = page, node

            def is_visible(self):
                return "hidden" not in self.node.attrib

            def inner_text(self):
                return "".join(self.node.itertext())

            def name(self):
                def visible_text(node):
                    if node.get("aria-hidden") == "true":
                        return ""
                    return (node.text or "") + "".join(visible_text(child) + (child.tail or "") for child in node)
                return " ".join(visible_text(self.node).split())

            def click(self):
                self.page.clicked_names.append(self.name())

        class Matches:
            def __init__(self, values):
                self.values = values

            def count(self):
                return len(self.values)

            def nth(self, index):
                return self.values[index]

        class MarkupPage(Page):
            def __init__(self):
                super().__init__("wanfang")
                self.tree = ET.fromstring(markup)
                self.buttons = [Button(self, node) for node in self.tree.findall("button")]
                self.clicked_names, self.waited = [], []

            def locator(self, selector):
                if selector == "input#search-input":
                    return Control(self, "input")
                if selector == "button.search-btn":
                    return Matches([button for button in self.buttons if "search-btn" in button.node.get("class", "").split()])
                if selector == 'button:text-is("检索")':
                    # Playwright text-is matches immediate text nodes, not the
                    # nested label's text. See installed textIsEngine.
                    return Matches([button for button in self.buttons if any(
                        " ".join(text.split()) == "检索"
                        for text in [button.node.text or "", *(child.tail or "" for child in button.node)])])
                return Empty()

            def get_by_role(self, role, *, name, exact):
                assert role == "button" and exact is True
                return Matches([button for button in self.buttons if button.name() == name])

            def wait_for_selector(self, selector, **kwargs):
                self.waited.append(selector)

        page = MarkupPage()
        self.assertEqual(page.locator('button:text-is("检索")').count(), 0)
        self.assertEqual(page.get_by_role("button", name="检索", exact=True).count(), 1)
        self.assertTrue(adapter.navigate(page, "wanfang", QUERY))
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked_names, ["检索"])
        result_wait = page.waited[-1].split(",")
        self.assertNotIn(".normal-list", result_wait)
        self.assertNotIn(".result-list", result_wait)
        self.assertIn("div.normal-list.periodical-list", result_wait)

        # Neither a hidden plain button nor a visible longer action is a valid
        # substitute when the exact search control is unavailable.
        page = MarkupPage()
        page.buttons[1].node.set("hidden", "hidden")
        self.assertFalse(adapter.navigate(page, "wanfang", QUERY))
        self.assertEqual(page.clicked_names, [])

    def test_unknown_forms_do_not_claim_submission(self):
        for source in ("wanfang", "scopus"):
            self.assertFalse(adapter.navigate(Page(source, form=False), source, QUERY))

    def test_scopus_rejects_author_search(self):
        page = Page("scopus")
        page.document_mode = False
        self.assertFalse(adapter.navigate(page, "scopus", QUERY))
        self.assertIsNone(page.filled)
        self.assertEqual(page.clicked, 0)

    def test_scopus_confirms_field_before_stripping_wrapper(self):
        page = Page("scopus")
        page.fields = "Authors"
        self.assertTrue(adapter.navigate(page, "scopus", f"TITLE-ABS-KEY({QUERY})"))
        self.assertEqual(page.selected, "TITLE_ABS_KEY")
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)

    def test_current_scopus_form_uses_observed_dynamic_input_and_field_select(self):
        page = Page("scopus", modern=True)
        self.assertTrue(adapter.navigate(page, "scopus", QUERY))
        self.assertEqual(page.filled, QUERY)
        self.assertEqual(page.clicked, 1)
        self.assertEqual(page.visited, ["https://www.scopus.com/pages/home?display=basic#basic"])

    def test_current_scopus_document_mode_does_not_confuse_selected_history_tab(self):
        class DOMPage:
            def evaluate(self, script):
                return dom_snapshot("scopus", nodes={
                    "basic": {"text": "Documents"}, "history": {"text": "Search history"},
                    "field": {"tagName": "SELECT", "selectedOptions": [{"textContent": "Article title, Abstract, Keywords"}]},
                }, mapping={
                    '[role="tab"][aria-selected="true"]': ["history", "basic"],
                    '#basic[aria-selected="true"]': ["basic"],
                    '#basic-panel select[data-testid="select-search-within"]': ["field"],
                }, script=script)
        page = DOMPage()
        self.assertTrue(adapter._scopus_document_mode(page))
        self.assertEqual(adapter._scopus_fields(page), "Article title, Abstract, Keywords")

    def test_scopus_unapplied_field_change_or_other_advanced_syntax_stops(self):
        page = Page("scopus")
        page.fields = "Authors"
        page.selection_applies = False
        self.assertFalse(adapter.navigate(page, "scopus", QUERY))
        self.assertIsNone(page.filled)
        page.fields = "Article title, Abstract, Keywords"
        self.assertFalse(adapter.navigate(page, "scopus", 'AUTHLASTNAME(smith)'))
        self.assertFalse(adapter.navigate(page, "scopus", 'TITLE(broiler) AND PUBYEAR > 2020'))
        self.assertFalse(adapter.navigate(page, "scopus", 'TITLE-ABS-KEY(broiler) AND TITLE-ABS-KEY(heat)'))
        self.assertTrue(adapter.navigate(page, "scopus", 'TITLE-ABS-KEY((broiler OR chicken) AND "heat stress")'))
        self.assertEqual(page.filled, '(broiler OR chicken) AND "heat stress"')

    def test_scopus_resume_query_requires_visible_document_context(self):
        page = Page("scopus", modern=True)
        self.assertTrue(adapter.query_context_valid(page, "scopus"))
        page.fields = "Authors"
        self.assertFalse(adapter.query_context_valid(page, "scopus"))
        page.fields = "Article title, Abstract, Keywords"
        page.document_mode = False
        self.assertFalse(adapter.query_context_valid(page, "scopus"))
        self.assertTrue(adapter.query_context_valid(page, "wanfang"))


class SourceSnapshotTests(unittest.TestCase):
    def test_each_source_preserves_real_metadata(self):
        for source in adapter.SOURCE_INFO:
            with self.subTest(source=source):
                nodes, mapping = bibliographic_fixture(source)
                value = dom_snapshot(source, nodes, mapping)
                self.assertEqual(len(value["results"]), 1)
                row = value["results"][0]
                self.assertEqual(row["title"], "Effects of heat stress on growth")
                self.assertEqual(row["authors"], "A Author; B Author")
                self.assertEqual(row["year"], "2024")
                self.assertEqual(row["doi"], "10.1234/test.2024")
                self.assertTrue(row["result_url"].startswith("https://"))
                if source == "pubmed":
                    self.assertEqual(row["pmid"], "12345678")

    def test_unknown_empty_layout_never_claims_zero_hits(self):
        for source in adapter.SOURCE_INFO:
            value = dom_snapshot(source)
            self.assertFalse(value["noResults"])
            self.assertFalse(value["resultContainer"])
            self.assertEqual(value["results"], [])

    def test_zero_requires_explicit_result_message(self):
        for source, message, selector in [
            ("wanfang", "共 0 条结果", ".no-result"),
            ("scopus", "No documents were found", ".no-results"),
            ("pubmed", "No results were found.", ".no-results"),
        ]:
            value = dom_snapshot(source, {"empty": {"text": message}}, {selector: ["empty"]})
            self.assertTrue(value["noResults"])

    def test_authentication_markers_are_flags_not_sensitive_text(self):
        secret = "private-password-value"
        value = dom_snapshot("wanfang", {"password": {"value": secret}},
                             {'input[type="password"]': ["password"]},
                             head="请先登录 private-token-value")
        self.assertTrue(value["password"])
        self.assertTrue(value["loginPrompt"])
        self.assertNotIn(secret, json.dumps(value))
        self.assertNotIn("private-token-value", json.dumps(value))
        self.assertFalse(dom_snapshot("wanfang", head="登录 / 注册 机构登录")["loginPrompt"])

    def test_verification_and_access_are_not_zero_hits(self):
        for message, flag in [("Verify you are human", "captcha"),
                              ("Your institution does not have access", "accessRequired")]:
            value = dom_snapshot("scopus", head=message)
            self.assertTrue(value[flag])
            self.assertFalse(value["noResults"])

    def test_hidden_nodes_and_limit_are_respected(self):
        nodes, mapping = bibliographic_fixture("scopus")
        nodes["second"] = copy.deepcopy(nodes["row"])
        mapping['[data-testid="search-result"]'].append("second")
        self.assertEqual(len(dom_snapshot("scopus", nodes, mapping, limit=1)["results"]), 1)
        nodes["row"]["hidden"] = True
        nodes["second"]["hidden"] = True
        self.assertEqual(dom_snapshot("scopus", nodes, mapping)["results"], [])

    def test_formal_snapshot_reads_twenty_visible_rows(self):
        nodes, mapping = bibliographic_fixture("scopus")
        mapping['[data-testid="search-result"]'] = []
        for number in range(20):
            nodes[f"row{number}"] = copy.deepcopy(nodes["row"])
            mapping['[data-testid="search-result"]'].append(f"row{number}")
        self.assertEqual(len(dom_snapshot("scopus", nodes, mapping, limit=200)["results"]), 20)

    def test_pubmed_show_more_reads_latest_nonempty_visible_chunk(self):
        nodes, mapping = bibliographic_fixture("pubmed")
        nodes["old"] = copy.deepcopy(nodes["row"])
        nodes["oldTitle"] = {"text": "Earlier page result", "href": "https://pubmed.ncbi.nlm.nih.gov/1/"}
        nodes["old"]["map"]["a.docsum-title"] = ["oldTitle"]
        nodes["chunk1"] = {"map": {"article.full-docsum": ["old"]}}
        nodes["chunk2"] = {"map": {"article.full-docsum": ["row"]}}
        nodes["emptyChunk"] = {"map": {}}
        mapping[".search-results-chunk"] = ["chunk1", "chunk2", "emptyChunk"]
        mapping["article.full-docsum"] = ["old", "row"]
        results = dom_snapshot("pubmed", nodes, mapping, limit=200)["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["pmid"], "12345678")

    def test_actual_wanfang_visible_span_card_preserves_authors_year_and_position(self):
        nodes = {
            "row": {"className": "normal-list periodical-list", "text": "Real paper card", "map": {
                '.ajust span.title': ["title"], '.author-area .authors': ["author1", "author2", "date"],
                'span.periodical-title': ["venue"], 'div.abstract-area': ["abstract"]}},
            "title": {"tagName": "SPAN", "text": "热应激对肉鸡生长性能的影响"},
            "author1": {"text": "陈静龙"}, "author2": {"text": "雷闯闯"},
            "date": {"text": "2026年2期"}, "venue": {"text": "《动物营养学报》"},
            "abstract": {"text": "试验研究了高温对肉鸡的影响。"},
        }
        mapping = {'div.normal-list.periodical-list': ["row"], 'span.title': ["title"]}
        result = dom_snapshot("wanfang", nodes, mapping)["results"][0]
        self.assertEqual(result["authors"], "陈静龙; 雷闯闯")
        self.assertEqual(result["year"], "2026")
        self.assertEqual(result["venue"], "《动物营养学报》")
        self.assertEqual(result["_title_index"], 0)
        self.assertEqual(result["result_url"], "")
        self.assertEqual(result["snippet"], "试验研究了高温对肉鸡的影响。")

    def test_wanfang_nonpaper_card_is_excluded(self):
        nodes, mapping = bibliographic_fixture("wanfang")
        nodes["kind"] = {"text": "专利"}
        nodes["row"]["map"][".essay-type"] = ["kind"]
        self.assertEqual(dom_snapshot("wanfang", nodes, mapping)["results"], [])

    def test_current_scopus_result_table_and_query_are_parsed_without_search_token(self):
        nodes = {
            "row": {"className": "TableItems_resultsRow__cvjWr TableItems_content__g7iNF", "map": {
                'a[href*="/pages/publications/"]': ["title"],
                'div[data-testid="author-list"]': ["authors"],
                'div[data-component="document-source"] a': ["source"],
                'div[data-testid="document-publication-year"]': ["year"],
            }},
            "title": {"text": "Heat stress and broiler growth",
                      "href": "https://www.scopus.com/pages/publications/105042460627?origin=resultslist"},
            "authors": {"text": "Wang, A., Li, B., ... Zhang, C."},
            "source": {"text": "Poultry Science"}, "year": {"text": "2026"},
            "query": {"value": QUERY}, "heading": {"text": "2,417 documents found"},
        }
        mapping = {'tr[class*="TableItems_resultsRow"]': ["row"],
                   'input[id^="autosuggest-"]': ["query"], 'h2': ["heading"]}
        value = dom_snapshot("scopus", nodes, mapping)
        self.assertEqual(value["queries"], [QUERY])
        self.assertTrue(value["resultContainer"])
        self.assertFalse(value["noResults"])
        row = value["results"][0]
        self.assertEqual(row["authors"], "Wang, A., Li, B., ... Zhang, C.")
        self.assertEqual(row["venue"], "Poultry Science")
        self.assertEqual(row["year"], "2026")
        self.assertEqual(row["result_url"], nodes["title"]["href"])
        self.assertNotIn("searchId", json.dumps(value))

    def test_current_scopus_explicit_zero_document_count(self):
        value = dom_snapshot("scopus", {"heading": {"text": "0 documents found"}}, {'h2': ["heading"]})
        self.assertTrue(value["noResults"])


class Popup:
    def __init__(self, url):
        self.url = url
        self.closed = False

    def wait_for_load_state(self, state, **kwargs):
        self.loaded = state

    def close(self):
        self.closed = True


class PopupExpectation:
    def __init__(self, page):
        self.page = page

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self.page.same_tab:
            raise TimeoutError("fixture: navigation happened in same tab")

    @property
    def value(self):
        return self.page.popup


class VisibleTitle:
    def __init__(self, page):
        self.page = page

    def count(self):
        return 1

    def nth(self, index):
        return self

    def is_visible(self):
        return True

    def inner_text(self):
        return "Visible title"

    def click(self):
        self.page.clicks += 1
        if self.page.same_tab:
            self.page.url = self.page.popup.url


class ResultPage:
    def __init__(self, detail_url, same_tab=False):
        self.url = "https://s.wanfangdata.com.cn/paper?q=broiler&p=1"
        self.initial = self.url
        self.popup = Popup(detail_url)
        self.same_tab = same_tab
        self.clicks = self.restored = 0

    def locator(self, selector):
        assert selector == "span.title"
        return VisibleTitle(self)

    def expect_popup(self, **kwargs):
        return PopupExpectation(self)

    def go_back(self, **kwargs):
        self.url = self.initial
        self.restored += 1


class WanfangDetailLinkTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{"title": "Visible title", "result_url": "", "_title_index": 0}]
        self.actual = "https://d.wanfangdata.com.cn/periodical/opaque-actual-value?query=broiler&qid=123"

    def test_title_click_reads_actual_popup_url_and_closes_only_its_popup(self):
        page = ResultPage(self.actual)
        result = adapter.resolve_result_links(page, "wanfang", self.rows)
        self.assertEqual(result[0]["result_url"], self.actual)
        self.assertNotIn("_title_index", result[0])
        self.assertEqual(page.clicks, 1)
        self.assertEqual(page.url, page.initial)
        self.assertTrue(page.popup.closed)
        self.assertEqual(self.rows[0]["result_url"], "")

    def test_same_tab_navigation_is_restored(self):
        page = ResultPage(self.actual, same_tab=True)
        result = adapter.resolve_result_links(page, "wanfang", self.rows)
        self.assertEqual(result[0]["result_url"], self.actual)
        self.assertEqual(page.url, page.initial)
        self.assertEqual(page.restored, 1)

    def test_formal_resolves_records_after_the_tenth_visible_title(self):
        page = ResultPage(self.actual)
        rows = [dict(self.rows[0]) for _ in range(20)]
        result = adapter.resolve_result_links(page, "wanfang", rows, limit=200)
        self.assertEqual(len(result), 20)
        self.assertEqual(page.clicks, 20)
        self.assertTrue(all(row["result_url"] == self.actual for row in result))

    def test_authentication_popup_is_not_exported_as_bibliography(self):
        page = ResultPage("https://login.wanfangdata.com.cn/sso?ticket=private")
        result = adapter.resolve_result_links(page, "wanfang", self.rows)
        self.assertEqual(result[0]["result_url"], "")
        self.assertNotIn("private", json.dumps(result))

    def test_changed_title_is_not_clicked(self):
        page = ResultPage(self.actual)
        rows = [{"title": "A different manually changed result", "result_url": "", "_title_index": 0}]
        self.assertEqual(adapter.resolve_result_links(page, "wanfang", rows)[0]["result_url"], "")
        self.assertEqual(page.clicks, 0)


if __name__ == "__main__":
    unittest.main()
