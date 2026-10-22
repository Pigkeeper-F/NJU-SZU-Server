"""Offline skip-policy browser fixtures; no sites, sessions or real jobs."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext_browser as mod
from test_literature_fulltext_browser import Clock, Context, Page, snapshot


class SkipBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "skip-test"
        self.clock = Clock()

    def tearDown(self):
        self.temp.cleanup()

    def fetcher(self, context):
        return mod.FulltextBrowserFetcher({}, self.path,
            runtime_factory=context.runtime, clock=self.clock.time, sleep=self.clock.sleep)

    def block(self, context, *, reason="verification", requested="https://doi.org/10.1/paper",
              destination="https://publisher.test/paper"):
        context.next_steps = [{"url": destination, "snapshot": snapshot(**{reason: True})}]
        fetcher = self.fetcher(context)
        self.assertEqual(fetcher.fetch_page(requested, {})["reason"], reason)
        return fetcher, context.pages[-1]

    def test_default_attention_still_stops_until_explicit_defer(self):
        context = Context()
        fetcher, page = self.block(context)
        first = dict(fetcher._blocked)
        self.assertEqual(fetcher.fetch_page("https://different.test/paper", {}), first)
        self.assertEqual(len(page.gotos), 1)
        self.assertFalse(fetcher.complete_paper()["closed"])

    def test_defer_keeps_exact_original_and_allows_different_publisher_with_pacing(self):
        context = Context()
        fetcher, original = self.block(context)
        result = fetcher.defer_paper(reason="verification", url="https://doi.org/10.1/paper")
        self.assertTrue(result["deferred"])
        self.assertFalse(original.closed)
        self.assertIsNone(fetcher._blocked)
        self.assertNotIn("target_id", fetcher._binding)
        retained = json.loads(fetcher.binding_path.read_text(encoding="utf-8"))["last_deferred_paper"]
        self.assertEqual(retained["binding"]["target_id"], original.target)
        self.assertEqual(retained["site"], "publisher.test")
        self.assertTrue(fetcher.open_current()["opened"])
        self.assertEqual(original.fronts, 1)
        self.assertEqual(len(original.gotos), 1)
        context.next_steps = [{}]
        self.assertEqual(fetcher.fetch_page("https://different.test/accessible", {})["status"], "ok")
        self.assertEqual(context.creates, 2)
        self.assertEqual(self.clock.sleeps, [8])
        self.assertIsNot(fetcher._page, original)
        self.assertFalse(any(page.closed for page in context.pages))

    def test_same_restricted_destination_is_not_requested_and_doi_not_blacklisted(self):
        for reason in ("login", "verification", "access_required", "rate_limited"):
            with self.subTest(reason=reason):
                self.path = Path(self.temp.name) / reason
                context = Context()
                fetcher, original = self.block(context, reason=reason)
                fetcher.defer_paper(reason=reason, url="https://doi.org/10.1/paper")
                retained = fetcher._binding["last_deferred_paper"].copy()
                cached = fetcher.fetch_page("https://www.publisher.test/another", {})
                self.assertEqual((cached["status"], cached["reason"]), ("attention", reason))
                self.assertTrue(cached["deferred_site"])
                fetcher.defer_paper(reason=reason, url=cached["url"])
                self.assertEqual(fetcher._binding["last_deferred_paper"], retained)
                self.assertEqual(context.creates, 1)
                self.assertEqual(len(original.gotos), 1)
                self.assertIsNone(fetcher._blocked)
                context.next_steps = [{"url": "https://different.test/article"}]
                self.assertEqual(fetcher.fetch_page("https://doi.org/10.2/other", {})["status"], "ok")

    def test_common_gateways_are_never_cached_as_whole_site_restrictions(self):
        for site in ("doi.org", "dx.doi.org", "pubmed.ncbi.nlm.nih.gov"):
            with self.subTest(site=site):
                self.path = Path(self.temp.name) / site
                context = Context()
                fetcher, _ = self.block(context, requested="https://" + site + "/one",
                    destination="https://" + site + "/one")
                fetcher.defer_paper(reason="verification")
                self.assertFalse(fetcher._deferred_sites)
                context.next_steps = [{}]
                self.assertEqual(fetcher.fetch_page("https://" + site + "/two", {})["status"], "ok")

    def test_actual_login_page_origin_survives_safe_url_redaction(self):
        context = Context()
        fetcher, _ = self.block(context, reason="login", destination="https://publisher.test/login?token=secret")
        self.assertEqual(fetcher._blocked["url"], "")
        fetcher.defer_paper(reason="login", url="https://doi.org/10.1/paper")
        self.assertIn("publisher.test", fetcher._deferred_sites)
        binding_text = fetcher.binding_path.read_text(encoding="utf-8")
        self.assertNotIn("secret", binding_text)
        self.assertNotIn("/login", binding_text)

    def test_bad_page_and_timeout_do_not_disable_the_site(self):
        for reason in ("page_error", "load_timeout"):
            with self.subTest(reason=reason):
                self.path = Path(self.temp.name) / reason
                self.clock = Clock()
                context = Context()
                step = {"snapshot": snapshot(page_error=True)} if reason == "page_error" else {"error": TimeoutError("timeout")}
                context.next_steps = [step]
                fetcher = self.fetcher(context)
                self.assertEqual(fetcher.fetch_page("https://publisher.test/bad", {})["reason"], reason)
                fetcher.defer_paper(reason=reason)
                self.assertFalse(fetcher._deferred_sites)
                context.next_steps = [{}]
                self.assertEqual(fetcher.fetch_page("https://publisher.test/good", {})["status"], "ok")
                self.assertEqual(context.creates, 2)
                self.assertEqual(self.clock.sleeps, [8])

    def test_cnki_and_material_entries_do_not_revisit_cached_restriction(self):
        context = Context()
        fetcher, original = self.block(context, destination="https://kns.cnki.net/kcms2/article/abstract")
        fetcher.defer_paper(reason="verification")
        record = {"title": "Heat stress in broilers", "source_key": "cnki",
                  "source_url": "https://kns.cnki.net/kcms2/article/abstract"}
        with patch("literature_cnki_fulltext.run_cnki", side_effect=AssertionError("must not navigate CNKI")):
            self.assertEqual(fetcher.fetch_cnki(record, {})["reason"], "verification")
            self.assertEqual(fetcher.inspect_materials(record)["reason"], "verification")
        self.assertEqual(fetcher.fetch_material({"url": "https://kns.cnki.net/material.xlsx"}, record)["reason"], "verification")
        self.assertIsNone(fetcher._blocked)
        self.assertEqual(context.creates, 1)
        self.assertEqual(len(original.gotos), 1)
        context.next_steps = [{}]
        self.assertEqual(fetcher.inspect_materials({"source_url": "https://different.test/paper"})["status"], "ok")

    def test_deferred_popup_keeps_existing_open_current_ownership_checks(self):
        context = Context()
        fetcher, parent = self.block(context, destination="https://kns.cnki.net/kcms2/article/abstract")
        child = Page("owned-popup", url="https://kns.cnki.net/download")
        child.opener = lambda: parent
        context.pages.append(child)
        fetcher._binding["cnki_flow"] = {"target_id": parent.target, "pending_popup": {
            "target_id": child.target, "owner_target_id": parent.target,
            "opener_verified": True, "action": "download"}}
        fetcher.defer_paper(reason="verification")
        self.assertTrue(fetcher.open_current()["opened"])
        self.assertEqual(child.fronts, 1)
        child.opener = lambda: context.pages[0]
        self.assertFalse(fetcher.open_current()["opened"])
        self.assertEqual(child.fronts, 1)
        self.assertTrue(all(not page.closed for page in context.pages))

    def test_restart_does_not_restore_batch_restriction_or_adopt_deferred_page(self):
        context = Context()
        fetcher, original = self.block(context)
        fetcher.defer_paper(reason="verification")
        fetcher.close()
        context.next_steps = [{}]
        resumed = self.fetcher(context)
        self.assertFalse(resumed._deferred_sites)
        self.assertTrue(resumed.open_current()["opened"])
        self.assertEqual(resumed.fetch_page("https://publisher.test/another", {})["status"], "ok")
        self.assertEqual(context.creates, 2)
        self.assertEqual(len(original.gotos), 1)
        self.assertFalse(original.closed)

    def test_supplemental_nutrient_title_does_not_enumerate_article_author_links(self):
        if not shutil.which("node"):
            self.skipTest("Node required for offline DOM function fixture")
        program = r"""
          const assert = require('node:assert/strict');
          const functionSource = __FUNCTION_SOURCE__;
          const author = {href:'https://pubmed.ncbi.nlm.nih.gov/?term=Kucuk+O[Author]',
            innerText:'Osman Kucuk',offsetWidth:1,getAttribute:()=>'',querySelector:()=>null};
          const section = {matches:()=>false,querySelectorAll:()=>[author]};
          const heading = {innerText:'Supplemental zinc and vitamin A can alleviate negative effects of heat stress',
            offsetWidth:1,closest:()=>section};
          const document = {querySelector:()=>null, querySelectorAll:selector=>
            selector.startsWith('h1,')?[heading]:selector==='a[href]'?[author]:[]};
          const run = Function('document','getComputedStyle','return ('+functionSource+')();');
          const style = ()=>({display:'block',visibility:'visible'});
          const result = run(document,style);
          assert.equal(result.region_found,false);
          assert.deepEqual(result.links,[]);
          heading.innerText='Supplementary information';
          assert.equal(run(document,style).region_found,true);
        """.replace("__FUNCTION_SOURCE__", json.dumps(mod._MATERIALS_FUNCTION_JS))
        result = subprocess.run([shutil.which("node"), "-e", program], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_known_author_and_main_doi_metadata_are_filtered_but_data_links_remain(self):
        fetcher = self.fetcher(Context())
        record = {"title": "Supplemental zinc study", "doi": "10.1/main"}
        links = [
            {"url": "https://pubmed.ncbi.nlm.nih.gov/?term=Kucuk+O%5BAuthor%5D", "label": "Osman Kucuk"},
            {"url": "https://publisher.test/article#affiliation1", "label": "1"},
            {"url": "https://publisher.test/author/osman-kucuk", "label": "Osman Kucuk"},
            {"url": "https://doi.org/10.1/main", "label": "10.1/main"},
            {"url": "https://orcid.org/0000-0000-0000-0000", "label": "ORCID"},
            {"url": "https://doi.org/10.2/dataset", "label": "Supplementary dataset"},
            {"url": "https://publisher.test/authors/supplement.xlsx", "label": "Supplementary file"},
        ]
        discovery = fetcher._discovery(record, snapshot(citation_title=record["title"], citation_doi=record["doi"],
            materials={"complete": True, "region_found": True, "links": links}), "https://publisher.test/article")
        self.assertEqual(discovery["status"], "checked")
        self.assertEqual([item["label"] for item in discovery["links"]], ["Supplementary dataset", "Supplementary file"])


if __name__ == "__main__":
    unittest.main()
