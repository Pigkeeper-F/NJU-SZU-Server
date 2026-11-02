"""Offline regression for per-paper request state and pending PDF identity."""
from pathlib import Path
import tempfile
import unittest

import literature_fulltext_browser as mod
from test_literature_fulltext_browser import Clock, Context, snapshot


PDF009 = "https://publisher.test/doi/pdf/10.1080/00071660120048384"


def inert_page(page, url):
    page.url = url
    page.snapshot = snapshot(ready_state="complete", text="", article_text="", article_html="",
                             citation_title="", citation_doi="", page_title="", headings=[], sections=[],
                             links=[], container="", container_verified=False, reader_ready=False)


class RequestStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.context = Context()
        self.fetcher = mod.FulltextBrowserFetcher({}, self.temp.name, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        self.fetcher.ensure_ready()

    def tearDown(self):
        self.fetcher.close()
        self.temp.cleanup()

    def test_009_then_003_and_004_inspection_cannot_reuse_previous_request_hash(self):
        browser = self.fetcher
        inert_page(browser._page, PDF009)
        browser._request_url = PDF009
        browser._binding.update(pdf_click_pending=True, pending_url_hash=mod._url_hash(PDF009))
        browser._attention("page_not_ready", PDF009)
        browser.defer_paper(reason="page_not_ready", url=PDF009, paper_id="PMID-009")
        self.assertEqual(browser._request_url, "")
        for paper_id, pmid in (("PMID-003", "20709975"), ("PMID-004", "11297279")):
            source = "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/"
            browser.ensure_ready()
            inert_page(browser._page, "https://pdf.publisher.test/inert/" + paper_id)
            discovery = browser.capture_material_discovery({"paper_id": paper_id, "source_url": source})
            self.assertEqual(discovery["status"], "needs_attention")
            self.assertEqual(discovery["source_url"], source)
            self.assertEqual(browser._binding["pending_url_hash"], mod._url_hash(source))
            self.assertNotEqual(browser._binding["pending_url_hash"], mod._url_hash(PDF009))
            self.assertNotIn("pdf_click_pending", browser._binding)
            browser.defer_paper(reason="page_not_ready", url=source, paper_id=paper_id)
            self.assertEqual(browser._request_url, "")
        browser._request_url = "https://unrelated.test/stale"
        browser.resume_deferred("PMID-003")
        self.assertEqual(browser._request_url, "")
        self.assertEqual(browser._binding["pending_url_hash"], mod._url_hash("https://pubmed.ncbi.nlm.nih.gov/20709975/"))
        self.assertEqual(browser._binding["deferred_papers"]["PMID-009"]["binding"]["pending_url_hash"], mod._url_hash(PDF009))
        self.assertTrue(all(not page.gotos for page in self.context.pages))

    def test_inspection_does_not_replace_pending_actual_pdf_hash_or_click_again(self):
        browser = self.fetcher
        actual_pdf = "https://publisher.test/article/003/download.pdf"
        source = "https://pubmed.ncbi.nlm.nih.gov/20709975/"
        record = {"paper_id": "PMID-003", "source_url": source}
        inert_page(browser._page, "https://pdf.publisher.test/inert/003")
        browser._request_url = PDF009
        browser._binding.update(pdf_click_pending=True, pending_url_hash=mod._url_hash(actual_pdf))
        discovery = browser.capture_material_discovery(record)
        self.assertEqual(discovery["reason"], "page_not_ready")
        self.assertEqual(browser._request_url, source)
        self.assertEqual(browser._binding["pending_url_hash"], mod._url_hash(actual_pdf))
        browser.defer_paper(reason="page_not_ready", url=source, paper_id="PMID-003")
        browser.resume_deferred("PMID-003")
        out = Path(self.temp.name) / "must-not-be-created.pdf"
        result = browser.fetch_pdf(actual_pdf, out, {"record": record})
        self.assertEqual((result["status"], result["reason"]), ("attention", "page_not_ready"))
        self.assertEqual(browser._binding["pending_url_hash"], mod._url_hash(actual_pdf))
        self.assertTrue(browser._binding["pdf_click_pending"])
        self.assertFalse(out.exists())
        self.assertEqual(self.context.creates, 1)
        self.assertTrue(all(not page.gotos for page in self.context.pages))
        self.assertTrue(all(not page.closed for page in self.context.pages))

    def test_defer_early_return_and_missing_resume_clear_transient_request(self):
        browser = self.fetcher
        browser._binding = {}
        browser._page = None
        browser._request_url = PDF009
        browser.defer_paper(reason="page_not_ready", paper_id="PMID-003")
        self.assertEqual(browser._request_url, "")
        browser._request_url = PDF009
        self.assertEqual(browser.resume_deferred("PMID-004"), {"restored": False})
        self.assertEqual(browser._request_url, "")
        self.assertTrue(all(not page.gotos for page in self.context.pages))

    def test_attention_without_prior_request_uses_current_requested_url(self):
        self.assertEqual(self.fetcher._request_url, "")
        source = "https://pubmed.ncbi.nlm.nih.gov/11297279/"
        self.fetcher._attention("verification", source)
        self.assertEqual(self.fetcher._binding["pending_url_hash"], mod._url_hash(source))
        self.assertEqual(self.fetcher._binding["attention_reason"], "verification")


if __name__ == "__main__":
    unittest.main()
