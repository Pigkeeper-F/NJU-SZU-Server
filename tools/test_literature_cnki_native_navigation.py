"""CNKI native navigation regressions; local DOM/flow fixtures only."""
import copy
import unittest
from unittest.mock import patch

import literature_native_queries as native
from test_literature_native_queries import (
    NativeLocator, NativePage, QUERIES, dom, state,
)


MENU = ".headsch > a.nxgp-title"
PROFESSIONAL = "https://kns.cnki.net/kns8s/AdvSearch?major=1"


def date_dom(start="2000-01-01", end="2026-12-31", *, labelled=False, **changes):
    nodes = {
        "datepane": {"parent": "pane", "text": "发表时间"},
        "datefrom": {"tagName": "INPUT", "parent": "datepane", "value": start,
                     "attrs": {"id": "datebox0", **({"aria-label": "开始时间"} if labelled else {})}},
        "dateto": {"tagName": "INPUT", "parent": "datepane", "value": end,
                   "attrs": {"id": "datebox1", **({"aria-label": "结束时间"} if labelled else {})}},
    }
    nodes.update(changes)
    return dom("cnki", nodes=nodes, mapping={'input[type="text"]': ["datefrom", "dateto"]})


class NavigationLocator(NativeLocator):
    def nth(self, index):
        return NavigationLocator(self.page, self.selector, index)

    def hover(self, **kwargs):
        if self.selector != MENU:
            raise AssertionError("Unexpected hover outside the explicit CNKI menu")
        self.page.hovers += 1
        self.page.native = copy.deepcopy(self.page.after_hover)
        if self.page.block_after_hover:
            self.page.block = self.page.block_after_hover


class NavigationPage(NativePage):
    def __init__(self):
        super().__init__("cnki")
        self.url = "https://kns.cnki.net/kns8s/defaultresult/index"
        self.hovers = 0
        self.after_hover = {}
        self.block_after_hover = None
        self.route_states = {}

    def locator(self, selector):
        return NavigationLocator(self, selector)

    def goto(self, url, **kwargs):
        super().goto(url, **kwargs)
        if url in self.route_states:
            self.native = copy.deepcopy(self.route_states[url])


class CNKINativeDOMTests(unittest.TestCase):
    def test_hidden_professional_header_does_not_authorize_editor(self):
        result = dom("cnki", nodes={"tab": {"text": "专业检索", "hidden": True}},
                     mapping={"a": ["tab"]})
        self.assertFalse(result["modeVerified"])
        self.assertIsNone(result["editor"])
        self.assertIsNone(result["entry"])

    def test_visible_professional_header_link_is_navigation_only(self):
        result = dom("cnki", mapping={".active": [], "a": ["tab"]})
        self.assertIsNone(result["editor"])
        self.assertEqual(result["entry"]["label"], "专业检索")

    def test_visible_search_menu_can_reveal_hidden_professional_entry(self):
        result = dom("cnki", nodes={
            "tab": {"text": "专业检索", "hidden": True},
            "menu": {"tagName": "A", "text": "检索"},
        }, mapping={"a": ["tab", "menu"], MENU: ["menu"]})
        self.assertIsNone(result["editor"])
        self.assertIsNone(result["entry"])
        self.assertEqual(result["menu"], MENU)

    def test_hidden_search_menu_is_not_hover_target(self):
        result = dom("cnki", nodes={
            "tab": {"text": "专业检索", "hidden": True},
            "menu": {"tagName": "A", "text": "检索", "hidden": True},
        }, mapping={MENU: ["menu"]})
        self.assertIsNone(result["menu"])
        self.assertIsNone(result["editor"])

    def test_ambiguous_visible_search_menus_do_not_choose_one(self):
        result = dom("cnki", nodes={
            "tab": {"text": "专业检索", "hidden": True},
            "menu1": {"tagName": "A", "text": "检索"},
            "menu2": {"tagName": "A", "text": "检索"},
        }, mapping={MENU: ["menu1", "menu2"]})
        self.assertIsNone(result["menu"])

    def test_professional_li_is_recognized_as_navigation(self):
        result = dom("cnki", nodes={
            "major": {"tagName": "LI", "text": "专业检索", "attrs": {"name": "majorSearch"}},
            "grade": {"tagName": "LI", "text": "高级检索", "attrs": {"name": "gradeSearch"}},
        }, mapping={".active": [], 'li[name="majorSearch"]': ["major"], 'li[name="gradeSearch"]': ["grade"]})
        self.assertIsNone(result["editor"])
        self.assertEqual(result["entry"]["label"], "专业检索")
        self.assertEqual(result["entry"]["index"], 2)  # Search and Add buttons precede the LI entries.

    def test_blank_target_and_visible_href_are_preserved(self):
        result = dom("cnki", nodes={"tab": {
            "tagName": "A", "text": "专业检索", "attrs": {"target": "_blank", "href": PROFESSIONAL},
        }}, mapping={".active": [], "a": ["tab"]})
        self.assertEqual(result["entry"]["target"], "_blank")
        self.assertEqual(result["entry"]["href"], PROFESSIONAL)
        self.assertIsNone(result["editor"])


class CNKINativeNavigationFlowTests(unittest.TestCase):
    def setUp(self):
        self.page = NavigationPage()

    def test_hover_reveals_professional_entry_without_submitting_search(self):
        self.page.native = {"menu": MENU}
        self.page.after_hover = {"entry": {"index": 2, "label": "专业检索", "href": "", "target": ""}}
        self.page.after_entry = state("cnki")
        result = native.find_editor(self.page, "cnki")
        self.assertIsNotNone(result["editor"])
        self.assertEqual((self.page.hovers, self.page.entries, self.page.submits), (1, 1, 0))
        self.assertEqual(self.page.fills, [])

    def test_blank_official_link_navigates_bound_page_instead_of_opening_popup(self):
        self.page.native = {"entry": {"index": 0, "label": "专业检索", "href": PROFESSIONAL, "target": "_blank"}}
        self.page.route_states[PROFESSIONAL] = state("cnki")
        target_before = self.page.target
        result = native.find_editor(self.page, "cnki")
        self.assertIsNotNone(result["editor"])
        self.assertEqual(self.page.target, target_before)
        self.assertEqual(self.page.navigations, [PROFESSIONAL])
        self.assertEqual((self.page.entries, self.page.submits), (0, 0))

    def test_blank_relative_official_link_resolves_in_bound_page(self):
        self.page.native = {"entry": {"index": 0, "label": "专业检索", "href": "/kns8s/AdvSearch?major=1", "target": "_blank"}}
        self.page.route_states[PROFESSIONAL] = state("cnki")
        self.assertIsNotNone(native.find_editor(self.page, "cnki")["editor"])
        self.assertEqual(self.page.navigations, [PROFESSIONAL])
        self.assertEqual(self.page.entries, 0)

    def test_external_and_credentialed_entry_links_never_navigate(self):
        for href in ("https://attacker.invalid/advanced", "//attacker.invalid/advanced",
                     "https://kns.cnki.net.attacker.invalid/advanced", "https://user@kns.cnki.net/advanced"):
            with self.subTest(href=href):
                self.page.native = {"entry": {"index": 0, "label": "专业检索", "href": href, "target": "_blank"}}
                result = native.find_editor(self.page, "cnki")
                self.assertIsNone(result.get("editor"))
                self.assertEqual(self.page.navigations, [])
                self.assertEqual(self.page.entries, 0)

    def test_access_challenge_after_hover_prevents_navigation(self):
        self.page.native = {"menu": MENU}
        self.page.after_hover = {"entry": {"index": 0, "label": "专业检索", "href": PROFESSIONAL, "target": "_blank"}}
        self.page.block_after_hover = "captcha"
        result = native.find_editor(self.page, "cnki")
        self.assertEqual(result, {})
        self.assertEqual(self.page.hovers, 1)
        self.assertEqual(self.page.navigations, [])
        self.assertEqual((self.page.entries, self.page.submits), (0, 0))


class CNKINativeYearProofTests(unittest.TestCase):
    def test_datebox_pair_requires_shared_publication_parent(self):
        result = date_dom()
        self.assertEqual([(x["role"], x["tag"]) for x in result["years"]],
                         [("from", "cnki-date"), ("to", "cnki-date")])
        self.assertTrue(native._visible_years(result, 2000, 2026))
        separated = date_dom(dateto={"tagName": "INPUT", "parent": "pane", "value": "2026-12-31", "attrs": {"id": "datebox1"}})
        self.assertEqual(separated["years"], [])
        unrelated = date_dom(datepane={"parent": "pane", "text": "采样时间"})
        self.assertEqual(unrelated["years"], [])

    def test_partial_dates_and_bare_years_are_not_full_year_proof(self):
        for start, end in (("2000-02-01", "2026-12-31"), ("2000-01-01", "2026-10-31"),
                           ("2000", "2026"), ("2000-01-01", "2026-12-30")):
            with self.subTest(start=start, end=end):
                result = date_dom(start, end)
                result["summaries"] = [QUERIES["cnki"]]
                self.assertFalse(native._visible_years(result, 2000, 2026))
                self.assertFalse(native.result_proof(result, "cnki", QUERIES["cnki"], 2000, 2026))

    def test_complete_slash_delimited_dates_remain_valid(self):
        result = date_dom("2000/01/01", "2026/12/31")
        result["summaries"] = [QUERIES["cnki"]]
        self.assertTrue(native.result_proof(result, "cnki", QUERIES["cnki"], 2000, 2026))

    def test_partial_date_controls_cannot_borrow_complete_year_summary(self):
        result = date_dom("2000-02-01", "2026-10-31")
        result["dateSummaries"] = ["发表时间：2000-2026"]
        result["summaries"] = [QUERIES["cnki"]]
        self.assertFalse(native.result_proof(result, "cnki", QUERIES["cnki"], 2000, 2026))

    def test_aria_labels_do_not_downgrade_datebox_proof_to_year_only(self):
        result = date_dom("2000-02-01", "2026-10-31", labelled=True)
        self.assertEqual([x["tag"] for x in result["years"]], ["cnki-date", "cnki-date"])
        result["summaries"] = [QUERIES["cnki"]]
        self.assertFalse(native.result_proof(result, "cnki", QUERIES["cnki"], 2000, 2026))

    def test_submit_sets_complete_dates_through_calendar_helper(self):
        page = NavigationPage()
        page.native = date_dom("2000-02-01", "2026-10-31")

        def calendar(_page, role, year):
            self.assertIs(_page, page)
            value = f"{year}-01-01" if role == "from" else f"{year}-12-31"
            next(row for row in page.native["years"] if row["role"] == role)["value"] = value
            return True

        with patch("literature_cnki_dates.set_year_bound", side_effect=calendar) as setter:
            self.assertTrue(native.submit(page, "cnki", QUERIES["cnki"], 2000, 2026))
        self.assertEqual([(call.args[1], call.args[2]) for call in setter.call_args_list],
                         [("from", 2000), ("to", 2026)])
        self.assertEqual(page.year_changes, [])  # Never use generic select or text-fill on date inputs.
        self.assertEqual(page.fills, [QUERIES["cnki"]])
        self.assertEqual(page.submits, 1)

    def test_calendar_failure_or_incomplete_readback_never_submits(self):
        for reported_success in (False, True):
            with self.subTest(reported_success=reported_success):
                page = NavigationPage()
                page.native = date_dom("2000-02-01", "2026-10-31")
                with patch("literature_cnki_dates.set_year_bound", return_value=reported_success):
                    self.assertFalse(native.submit(page, "cnki", QUERIES["cnki"], 2000, 2026))
                self.assertEqual(page.fills, [])
                self.assertEqual(page.submits, 0)


if __name__ == "__main__":
    unittest.main()
