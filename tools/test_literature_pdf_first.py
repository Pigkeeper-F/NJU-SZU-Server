"""Offline checks: a verified article PDF precedes unresolved supplements."""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf
from test_literature_fulltext import read_status
from test_literature_materials import descriptor
import test_literature_replenish as replenish_tests


class PdfFirstFetcher(replenish_tests.ReplenishFetcher):
    def __init__(self, records, job, *, main_attention=None):
        super().__init__(records)
        self.job = job
        self.main_attention = main_attention
        self.inspections = []
        self.observed_pdf = "https://publisher.invalid/current-reader.pdf"

    def inspect_materials(self, record, opts):
        first = opts.get("main_pdf_first") is True
        self.inspections.append(first)
        self.calls.append(("inspect_materials", record["paper_id"]))
        if self.main_attention:
            return {"status": "attention", "reason": self.main_attention,
                    "message": "The actual article still requires user action",
                    # Stale links must never override a current attention.
                    "main_pdf_ready": True,
                    "main_pdf_links": [{"url": record["fulltext_links"][0]["url"], "kind": "pdf"}]}
        if first:
            return {"status": "ok", "main_pdf_ready": True,
                    "main_pdf_links": [{"url": self.observed_pdf, "kind": "pdf"}],
                    "material_discovery": {"status": "checked", "links": [descriptor("supplement.csv")]}}
        saved = read_status(self.job)["items"][0]
        assert saved["status"] == "fetched_pdf", "checkpoint main PDF before inspecting supplements"
        assert (self.job / saved["path"]).read_bytes().startswith(b"%PDF")
        materials = json.loads((self.job / "fulltext/materials.json").read_text(encoding="utf-8"))
        assert any(paper.get("main_pdf_status") == "downloaded" for paper in materials["papers"])
        return {"status": "attention", "reason": "login", "message": "Supplement gateway login"}

    def fetch_pdf(self, url, out_path, opts):
        assert self.material_calls == [], "do not download supplements before the missing main PDF"
        assert url == self.observed_pdf, "use the current observed control before an older candidate PDF"
        assert opts.get("prefer_pmc_pdf") is False, "do not leave the current reader for a PMC preflight"
        return super().fetch_pdf(url, out_path, opts)


class PdfFirstTests(unittest.TestCase):
    def test_observed_download_entries_precede_epdf_reader_with_stable_order(self):
        helper = replenish_tests.ReplenishmentTests()
        reader = "https://publisher.invalid/doi/epdf/10.1234/study.0?needAccess=true"
        download = "https://publisher.invalid/doi/pdf/10.1234/study.0"
        other_download = "https://publisher.invalid/files/article.pdf"
        for html_count in (0, 1):
            with self.subTest(html_count=html_count), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = helper.fixture(root, html_count=html_count, checked="unknown")
                class DownloadFirstFetcher(replenish_tests.ReplenishFetcher):
                    def inspect_materials(self, record, opts):
                        return {"status": "ok", "main_pdf_ready": bool(opts.get("main_pdf_first")),
                                "main_pdf_links": [{"url": url, "kind": "pdf"} for url in (reader, download, other_download)],
                                "material_discovery": {"status": "none_declared", "links": []}}

                fetcher = DownloadFirstFetcher(records, pdf={download: {"status": "not_found"}})
                code, events = helper.run_replenish(job, config, fetcher)
                self.assertEqual(code, 0)
                self.assertEqual([url for kind, url in fetcher.calls if kind == "fetch_pdf"], [download, other_download])
                self.assertFalse(any(kind == "fetch_page" for kind, _ in fetcher.calls))
                self.assertEqual(events[-1]["type"], "result")
                self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")

    def test_ready_reader_without_cached_html_downloads_before_any_gateway(self):
        helper = replenish_tests.ReplenishmentTests()
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = helper.fixture(root, html_count=0, checked="unknown")
            fetcher = PdfFirstFetcher(records, job)
            # Exercise the production fetcher-only PMC branches with offline
            # stubs. run_replenish fails if Europe PMC PDF/XML is contacted.
            with patch.object(lf, "FulltextBrowserFetcher", replenish_tests.ReplenishFetcher), patch.object(
                    lf, "_pmc_pdf_from_record", return_value="https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/pdf/old.pdf"):
                code, events = helper.run_replenish(job, config, fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.inspections, [True, False])
            self.assertEqual([url for kind, url in fetcher.calls if kind == "fetch_pdf"], [fetcher.observed_pdf])
            self.assertFalse(any(kind == "fetch_page" for kind, _ in fetcher.calls), "do not navigate to PubMed/DOI first")
            self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")
            self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", "login"))
            self.assertEqual(fetcher.completed, 0)

    def test_missing_html_and_current_auth_still_require_user_action(self):
        helper = replenish_tests.ReplenishmentTests()
        for reason in ("login", "verification", "page_not_ready"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = helper.fixture(root, html_count=0, checked="unknown")
                fetcher = PdfFirstFetcher(records, job, main_attention=reason)
                code, events = helper.run_replenish(job, config, fetcher)
                self.assertEqual(code, 0)
                self.assertEqual(fetcher.inspections, [True])
                self.assertFalse(any(kind in {"fetch_page", "fetch_pdf"} for kind, _ in fetcher.calls))
                self.assertEqual(read_status(job)["items"][0]["status"], "needs_attention")
                self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", reason))
                self.assertEqual(list((job / "fulltext/files").glob("*.pdf")), [])

    def test_without_ready_reader_or_html_the_original_gateway_route_is_kept(self):
        helper = replenish_tests.ReplenishmentTests()
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = helper.fixture(root, html_count=0, checked="unknown")
            fetcher = replenish_tests.ReplenishFetcher(records)
            xml_calls, pdf_calls = [], []
            original_fetch = fetcher.fetch_pdf

            def fetch_pdf(url, out_path, opts):
                pdf_calls.append((url, opts.get("prefer_pmc_pdf", True)))
                return original_fetch(url, out_path, opts)

            fetcher.fetch_pdf = fetch_pdf
            with patch.object(lf, "FulltextBrowserFetcher", replenish_tests.ReplenishFetcher), patch.object(
                    lf, "_europe_pmc_pdf_urls", return_value=[]) as europe, patch.object(
                    lf, "_pmc_xml_item", side_effect=lambda *args: xml_calls.append(True)), patch.object(
                    lf, "_pmc_pdf_from_record", return_value=None):
                # Here no current entry exists: ordinary PMC/XML/HTML lookup
                # remains available instead of treating a stale URL as ready.
                code, events = replenish_tests.run_stage(job, config, fetcher=fetcher, resume=True, replenish_materials=True)
            self.assertEqual(code, 0)
            self.assertEqual(europe.call_count, 1)
            self.assertEqual(xml_calls, [True])
            self.assertIn(("fetch_page", records[0]["result_url"]), fetcher.calls)
            self.assertEqual(pdf_calls, [(records[0]["fulltext_links"][0]["url"], True)])
            self.assertEqual(events[-1]["type"], "result")

    def test_observed_pdf_precedes_old_candidate_and_pmc_only_for_ready_preflight(self):
        helper = replenish_tests.ReplenishmentTests()
        observed = "https://publisher.invalid/current-reader.pdf"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/pdf/main.pdf"
        for ready_preflight in (True, False):
            with self.subTest(ready_preflight=ready_preflight), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = helper.fixture(root, checked="unknown")
                class PriorityFetcher(replenish_tests.ReplenishFetcher):
                    def __init__(self):
                        super().__init__(records)
                        self.pdf_options = []

                    def inspect_materials(self, record, opts):
                        return {"status": "ok", "main_pdf_ready": bool(ready_preflight and opts.get("main_pdf_first")),
                                "main_pdf_links": [{"url": observed, "kind": "pdf"}] if ready_preflight else [],
                                "material_discovery": {"status": "none_declared", "links": []}}

                    def fetch_pdf(self, url, out_path, opts):
                        self.pdf_options.append((url, opts.get("prefer_pmc_pdf", True)))
                        return super().fetch_pdf(url, out_path, opts)

                fetcher = PriorityFetcher()
                with patch.object(lf, "_pmc_pdf_from_record", return_value=pmc):
                    _, events = helper.run_replenish(job, config, fetcher)
                self.assertNotEqual(records[0]["fulltext_links"][0]["url"], observed)
                self.assertEqual(fetcher.pdf_options, [(observed, False)] if ready_preflight else [(pmc, True)])
                self.assertEqual(events[-1]["type"], "result")
                self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")

    def test_pdf_is_checkpointed_before_supplement_login_without_losing_html(self):
        helper = replenish_tests.ReplenishmentTests()
        for defer_access in (False, True):
            with self.subTest(defer_access=defer_access), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = helper.fixture(root, checked="unknown")
                original = read_status(job)["items"][0]
                old_body = (job / original["path"]).read_bytes()
                fetcher = PdfFirstFetcher(records, job)
                code, events = helper.run_replenish(job, config, fetcher, defer_access=defer_access)
                self.assertEqual(code, 0)
                self.assertEqual(fetcher.inspections, [True, False])
                self.assertEqual(sum(kind == "fetch_pdf" for kind, _ in fetcher.calls), 1)
                self.assertEqual(fetcher.material_calls, [])
                self.assertEqual(fetcher.completed, 0, "keep the actual login page for the user")
                saved = read_status(job)["items"][0]
                self.assertEqual(saved["status"], "fetched_pdf")
                self.assertTrue((job / saved["path"]).is_file())
                self.assertEqual((job / original["path"]).read_bytes(), old_body)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertEqual(events[-1]["reason"], "deferred_materials" if defer_access else "login")
                if defer_access:
                    self.assertEqual(saved["material_deferred"]["reason"], "login")
                self.assertFalse(any((job / name).exists() for name in ("extraction", "validation", "export")))

    def test_current_article_attention_never_uses_stale_pdf_link(self):
        helper = replenish_tests.ReplenishmentTests()
        for reason in ("login", "verification", "page_not_ready"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = helper.fixture(root, checked="unknown")
                original = copy.deepcopy(read_status(job)["items"][0])
                old_body = (job / original["path"]).read_bytes()
                fetcher = PdfFirstFetcher(records, job, main_attention=reason)
                _, events = helper.run_replenish(job, config, fetcher)
                self.assertEqual(fetcher.inspections, [True])
                self.assertFalse(any(kind == "fetch_pdf" for kind, _ in fetcher.calls))
                self.assertEqual(fetcher.material_calls, [])
                self.assertEqual(fetcher.completed, 0)
                saved = read_status(job)["items"][0]
                self.assertEqual(saved["status"], "fetched_html")
                self.assertEqual((job / saved["path"]).read_bytes(), old_body)
                self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", reason))
                self.assertEqual(list((job / "fulltext/files").glob("*.pdf")), [])


if __name__ == "__main__":
    unittest.main()
