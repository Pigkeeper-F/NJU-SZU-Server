"""Exact task-page cleanup after saved files/non-auth skips; no external I/O."""
import tempfile
import unittest
from pathlib import Path

from literature_fulltext_browser import FulltextBrowserFetcher
from test_literature_fulltext_browser import Clock, Context, snapshot


class WindowCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.context, self.clock = Context(), Clock()
        self.fetcher = FulltextBrowserFetcher({}, Path(self.temp.name), runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)

    def tearDown(self):
        self.fetcher.close()
        self.temp.cleanup()

    def retained(self, paper_id="ONE", reason="supplements_incomplete"):
        self.fetcher.fetch_page("https://publisher.test/article", {})
        page = self.context.pages[-1]
        self.fetcher.defer_paper(reason=reason, paper_id=paper_id)
        return page

    def test_saved_pdf_with_supplement_gap_closes_exact_page_only_and_is_idempotent(self):
        page = self.retained()
        self.assertEqual(self.fetcher.close_deferred("ONE"), {"closed": True})
        self.assertTrue(page.closed)
        self.assertTrue(all(not p.closed for p in self.context.pages[:2]))
        self.assertEqual(self.fetcher.close_deferred("ONE"), {"closed": True})
        self.assertEqual((self.context.creates, len(page.gotos)), (1, 1))
        self.assertIn("ONE", self.fetcher._binding["deferred_papers"])

    def test_auth_and_shared_page_never_close(self):
        page = self.retained(reason="access_required")
        original = self.fetcher._binding["deferred_papers"]["ONE"]
        self.fetcher._binding["deferred_papers"]["TWO"] = {**original, "shared_from": "ONE"}
        self.assertFalse(self.fetcher.close_deferred("ONE")["closed"])
        self.assertFalse(self.fetcher.close_deferred("TWO")["closed"])
        self.assertFalse(page.closed)

    def test_live_login_verification_permission_and_downloading_pages_remain_open(self):
        page = self.retained()
        for key in ("login", "verification", "access_required", "download_pending"):
            with self.subTest(key=key):
                page.snapshot = snapshot(**{key: True})
                self.assertFalse(self.fetcher.close_deferred("ONE")["closed"])
                self.assertFalse(page.closed)
        page.snapshot = snapshot()
        binding = self.fetcher._binding["deferred_papers"]["ONE"]["binding"]
        binding["material_flow"] = {"step": "download_clicked"}
        self.assertFalse(self.fetcher.close_deferred("ONE")["closed"])
        self.assertFalse(page.closed)

    def test_already_closed_page_does_not_open_or_navigate(self):
        page = self.retained()
        page.closed = True
        self.assertTrue(self.fetcher.close_deferred("ONE")["closed"])
        self.assertEqual((self.context.creates, len(page.gotos)), (1, 1))

    def test_persisted_auth_is_protected_without_in_memory_block(self):
        self.fetcher.fetch_page("https://publisher.test/article", {})
        page = self.context.pages[-1]
        self.fetcher._binding["attention_reason"] = "login"
        self.fetcher._blocked = None
        self.assertFalse(self.fetcher.complete_paper()["closed"])
        self.assertFalse(page.closed)

    def test_recorded_non_auth_failure_can_close_but_live_verification_cannot(self):
        self.fetcher.fetch_page("https://publisher.test/article", {})
        page = self.context.pages[-1]
        self.fetcher._binding["attention_reason"] = "page_error"
        self.fetcher._blocked = {"reason": "page_error"}
        page.snapshot = snapshot(verification=True)
        self.assertFalse(self.fetcher.complete_paper(skipped=True)["closed"])
        page.snapshot = snapshot(page_error=True)
        self.assertTrue(self.fetcher.complete_paper(skipped=True)["closed"])
        self.assertTrue(page.closed)


if __name__ == "__main__":
    unittest.main()
