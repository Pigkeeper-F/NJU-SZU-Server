"""Offline recovery of an explicitly resumed, manually opened CNKI detail."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import literature_cnki_fulltext as cnki
import literature_fulltext_browser as browser
from test_literature_cnki_fulltext import Clock, Context, ui, version_record, version_rows
from test_literature_metadata import ABSTRACT


ROOT = Path(__file__).resolve().parents[1]


class ManualResumeTests(unittest.TestCase):
    def setUp(self):
        temp_root = ROOT / ".tmp-literature-tests"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "job"
        self.clock = Clock()
        self.context = Context(self.clock)
        self.record = version_record()
        self.context.initial_ui = version_rows()
        self.context.initial_ui["rows"][1]["authors"] = ""
        first = self.fetcher()
        result = cnki.run_cnki(first, self.record, self.options())
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous", result)
        self.owner = first._page
        self.original_binding = copy.deepcopy(first._binding)
        first.close()

    def options(self, *, explicit=False):
        result = {"metadata_only": True, "metadata_timeout_sec": 30}
        if explicit:
            result["cnki_manual_resume"] = True
        return result

    def fetcher(self):
        return browser.FulltextBrowserFetcher({}, self.path, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)

    def detail(self, *, opener="owner", title=None, year=None, authors=None,
               verification=False, loading=False, url=None, doi=""):
        actual_opener = self.owner if opener == "owner" else self.context.pages[0] if opener == "researcher" else None
        page = self.context.new_page(opener=actual_opener)
        page.url = url or "https://kns.cnki.net/kcms2/article/abstract?v=fixture-manual"
        wanted = self.record
        title = wanted["title"] if title is None else title
        year = str(wanted["year"]) if year is None else year
        authors = wanted["authors"].split(";") if authors is None else authors
        page.ui = ui(title=title, query=wanted["title"])
        page.snap.update(citation_title=title, citation_year=str(year), citation_date=str(year),
                         citation_authors=authors, citation_doi=doi,
                         ready_state="loading" if loading else "complete",
                         loading_pending=loading, verification=verification)
        original_evaluate = page.evaluate
        metadata_snapshot = {"title": title, "year": str(year), "authors": authors, "doi": doi,
            "abstract": ABSTRACT, "abstract_method": "explicit_abstract_dom", "abstract_complete": True,
            "ready_state": "loading" if loading else "complete", "loading_pending": loading,
            "verification": verification, "keywords": ["heat stress", "growth"]}

        def evaluate(script):
            if "literature_metadata_snapshot" in script:
                return copy.deepcopy(metadata_snapshot)
            return original_evaluate(script)
        page.evaluate = evaluate
        return page

    def resume(self, *, explicit=True):
        fetcher = self.fetcher()
        self.addCleanup(fetcher.close)
        result = cnki.run_cnki(fetcher, self.record, self.options(explicit=explicit))
        return fetcher, result

    def assert_not_adopted(self, child, result, fetcher):
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertIs(fetcher._page, self.owner)
        self.assertFalse(child.closed)
        self.assertFalse(child.gotos)
        self.assertEqual((child.title_clicks, child.download_clicks), (0, 0))
        self.assertFalse(self.context.pages[0].closed)

    def test_explicit_resume_adopts_unique_manual_child_without_clicking_again(self):
        child = self.detail()
        before = (len(self.owner.gotos), self.owner.title_clicks, self.owner.download_clicks)
        fetcher, result = self.resume()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertTrue(result.get("metadata_only"))
        self.assertIs(fetcher._page, child)
        flow = fetcher._binding["cnki_flow"]
        self.assertEqual(flow["step"], "detail")
        self.assertEqual(flow["target_id"], child.target)
        self.assertTrue(flow["pending_popup"]["opener_verified"])
        self.assertTrue(flow["pending_popup"]["adopted"])
        self.assertTrue(flow["pending_popup"]["manual_resume"])
        self.assertEqual(flow["pending_popup"]["owner_target_id"], self.owner.target)
        self.assertIn(self.owner.target, flow.get("cleanup_target_ids", [flow.get("cleanup_target_id")]))
        self.assertEqual(before, (len(self.owner.gotos), self.owner.title_clicks, self.owner.download_clicks))
        self.assertFalse(child.gotos)
        self.assertEqual(child.download_clicks, 0)
        self.assertFalse(self.context.pages[0].closed)
        self.assertTrue(fetcher.complete_paper().get("closed"))
        self.assertTrue(self.owner.closed)
        self.assertTrue(child.closed)
        self.assertFalse(self.context.pages[0].closed)

    def test_without_explicit_resume_existing_child_is_not_claimed(self):
        child = self.detail()
        fetcher, result = self.resume(explicit=False)
        self.assert_not_adopted(child, result, fetcher)
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous")

    def test_download_mode_does_not_claim_a_manual_metadata_detail(self):
        child = self.detail()
        fetcher = self.fetcher()
        self.addCleanup(fetcher.close)
        result = cnki.run_cnki(fetcher, self.record, {"cnki_manual_resume": True})
        self.assert_not_adopted(child, result, fetcher)

    def test_unrelated_or_unofficial_child_is_not_claimed(self):
        for changes in ({"opener": None}, {"opener": "researcher"},
                        {"url": "https://publisher.example/article/123"},
                        {"url": "http://kns.cnki.net/kcms2/article/abstract?v=fixture-manual"}):
            with self.subTest(changes=changes):
                child = self.detail(**changes)
                fetcher, result = self.resume()
                self.assert_not_adopted(child, result, fetcher)
                child.closed = True

    def test_wrong_title_authors_or_year_cannot_be_claimed(self):
        for changes in ({"title": self.record["title"] + "其他研究"},
                        {"authors": ["不同作者"]}, {"year": "2025"},
                        {"authors": []}, {"authors": ["赵杉", "等"]}, {"year": ""}):
            with self.subTest(changes=changes):
                child = self.detail(**changes)
                fetcher, result = self.resume()
                self.assert_not_adopted(child, result, fetcher)
                child.closed = True

    def test_other_task_owned_child_is_not_claimed_even_with_matching_parent(self):
        child = self.detail()
        other = self.path.parent / "11111111-1111-4111-8111-111111111111"
        other.mkdir()
        (other / "fulltext-browser.json").write_text(json.dumps({"version": 1, "target_id": child.target}), encoding="utf-8")
        fetcher, result = self.resume()
        self.assert_not_adopted(child, result, fetcher)

    def test_deferred_paper_owned_child_is_not_claimed(self):
        child = self.detail()
        binding_file = self.path / "fulltext-browser.json"
        binding = json.loads(binding_file.read_text(encoding="utf-8"))
        binding["deferred_papers"] = {"OTHER-PAPER": {"binding": {"target_id": child.target}}}
        binding_file.write_text(json.dumps(binding), encoding="utf-8")
        fetcher, result = self.resume()
        self.assert_not_adopted(child, result, fetcher)

    def test_two_qualified_manual_children_are_not_guessed(self):
        first, second = self.detail(), self.detail()
        fetcher, result = self.resume()
        self.assert_not_adopted(first, result, fetcher)
        self.assert_not_adopted(second, result, fetcher)

    def test_new_qualified_child_before_handoff_keeps_both_unclaimed(self):
        first = self.detail()
        fetcher = self.fetcher()
        self.addCleanup(fetcher.close)
        original_children = fetcher._cnki_manual_resume_pages
        discoveries = []

        def children(owner):
            discoveries.append(owner.target)
            if len(discoveries) == 2:
                self.detail()
            return original_children(owner)

        fetcher._cnki_manual_resume_pages = children
        result = cnki.run_cnki(fetcher, self.record, self.options(explicit=True))
        self.assertGreaterEqual(len(discoveries), 2)
        self.assert_not_adopted(first, result, fetcher)
        second = self.context.pages[-1]
        self.assertIsNot(second, first)
        self.assert_not_adopted(second, result, fetcher)
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous")
        self.assertEqual(self.owner.title_clicks, 0)

    def test_explicit_resume_with_unqualified_child_does_not_fall_back_to_new_click(self):
        child = self.detail(authors=["Different author"])
        self.owner.ui = version_rows()
        self.owner.ui["rows"] = self.owner.ui["rows"][:1]
        fetcher, result = self.resume()
        self.assert_not_adopted(child, result, fetcher)
        self.assertEqual(self.owner.title_clicks, 0)
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous")

    def test_matching_doi_does_not_override_conflicting_authors_or_year(self):
        self.record["doi"] = "10.1234/manual-detail"
        for changes in ({"authors": ["Different author"]}, {"year": "2025"}):
            with self.subTest(changes=changes):
                child = self.detail(doi=self.record["doi"], **changes)
                fetcher, result = self.resume()
                self.assert_not_adopted(child, result, fetcher)
                child.closed = True

    def test_challenged_or_unready_child_cannot_be_claimed(self):
        for changes in ({"verification": True}, {"loading": True}):
            with self.subTest(changes=changes):
                child = self.detail(**changes)
                fetcher, result = self.resume()
                self.assert_not_adopted(child, result, fetcher)
                child.closed = True


if __name__ == "__main__":
    unittest.main()
