"""Show an exact retained download popup without adopting or downloading it."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext_browser as browser
from test_literature_fulltext_browser import Clock, Context, Page


class PendingPage(Page):
    def __init__(self, target, *, opener=None, url="about:blank"):
        super().__init__(target, url=url)
        self._opener = opener

    def opener(self):
        return None if self._opener is not None and self._opener.closed else self._opener


class PendingWindowTests(unittest.TestCase):
    def make_fixture(self, job, *, url="https://unverified.invalid/download-window", adopted=False,
                     pending=True):
        context, clock = Context(), Clock()
        parent = PendingPage("owned-parent", url="https://kns.cnki.net/kcms2/article/abstract?fixture=parent")
        child = PendingPage("owned-download", opener=parent, url=url)
        lookalike = PendingPage("owned-unrelated-lookalike", opener=context.pages[0], url=url)
        context.pages.extend([parent, child, lookalike])
        bound = child.target if adopted else parent.target
        binding = {"version": 1, "target_id": bound}
        if pending:
            binding["cnki_flow"] = {"paper_hash": "a" * 64, "title_hash": "b" * 64,
                "step": "download_clicked", "target_id": bound,
                "pending_popup": {"target_id": child.target, "owner_target_id": parent.target,
                    "opener_verified": True, "action": "download", "adopted": adopted}}
        (job / "fulltext").mkdir()
        (job / "fulltext/status.json").write_text(json.dumps({"items": [
            {"paper_id": "CNKI-007", "status": "needs_attention", "path": ""}]}), encoding="utf-8")
        (job / "run_config.json").write_bytes(b'{"version":2,"sources":["cnki"]}\n')
        (job / "fulltext-browser.json").write_text(json.dumps(binding), encoding="utf-8")
        fetcher = browser.FulltextBrowserFetcher({}, job, runtime_factory=context.runtime,
            clock=clock.time, sleep=clock.sleep)
        return fetcher, context, parent, child, lookalike

    def files(self, job):
        return {str(path.relative_to(job)): path.read_bytes() for path in job.rglob("*") if path.is_file()}

    def assert_read_only(self, fetcher, context, job, original):
        self.assertEqual(self.files(job), original)
        self.assertEqual(context.creates, 0)
        self.assertIsNone(fetcher._page, "foregrounding must not adopt the child")
        self.assertTrue(all(not page.gotos for page in context.pages))
        self.assertFalse((job / "fulltext/files").exists())
        status = json.loads((job / "fulltext/status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["items"][0]["status"], "needs_attention")
        self.assertEqual(status["items"][0]["path"], "")

    def test_pending_exact_child_is_foregrounded_even_before_origin_validation(self):
        urls = ["https://kns.cnki.net/normal-window", "blob:https://kns.cnki.net/fixture",
                "https://unverified.invalid/retained-window"]
        for url in urls:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                fetcher, context, parent, child, lookalike = self.make_fixture(job, url=url)
                before = self.files(job)
                result = fetcher.open_current()
                self.assertTrue(result["opened"])
                self.assertIn("尚未确认全文下载完成", result["message"])
                self.assertNotIn(url, result["message"])
                self.assertEqual(child.fronts, 1)
                self.assertEqual(parent.fronts, 0)
                self.assertEqual(lookalike.fronts, 0)
                self.assertEqual(sum(page.fronts for page in context.pages), 1)
                self.assertTrue(all(not page.closed for page in context.pages))
                self.assert_read_only(fetcher, context, job, before)
                fetcher.close()

    def test_adopted_exact_child_with_closed_original_opener_can_be_shown(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, parent, child, _ = self.make_fixture(job, adopted=True)
            parent.closed = True
            before = self.files(job)
            self.assertTrue(fetcher.open_current()["opened"])
            self.assertEqual(child.fronts, 1)
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()

    def test_wrong_live_opener_is_rejected_without_showing_parent_or_lookalike(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, _, child, _ = self.make_fixture(job)
            child._opener = context.pages[0]
            before = self.files(job)
            result = fetcher.open_current()
            self.assertFalse(result["opened"])
            self.assertIn("打开关系", result["message"])
            self.assertTrue(all(page.fronts == 0 for page in context.pages))
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()

    def test_missing_or_closed_pending_child_does_not_fall_back_to_parent(self):
        for missing in (True, False):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                fetcher, context, _, child, _ = self.make_fixture(job)
                if missing:
                    context.pages.remove(child)
                else:
                    child.closed = True
                before = self.files(job)
                result = fetcher.open_current()
                self.assertFalse(result["opened"])
                self.assertIn("未改为打开父页面", result["message"])
                self.assertTrue(all(page.fronts == 0 for page in context.pages))
                self.assert_read_only(fetcher, context, job, before)
                fetcher.close()

    def test_unadopted_child_without_verifiable_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, parent, _, _ = self.make_fixture(job)
            parent.closed = True
            before = self.files(job)
            self.assertFalse(fetcher.open_current()["opened"])
            self.assertTrue(all(page.fronts == 0 for page in context.pages))
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()

    def test_inconsistent_or_malformed_pending_record_is_rejected(self):
        def invalid_witness(fetcher, changes):
            fetcher._binding["cnki_flow"]["pending_popup"].update(changes)
        corruptions = [
            lambda f: invalid_witness(f, {"opener_verified": False}),
            lambda f: invalid_witness(f, {"target_id": ""}),
            lambda f: invalid_witness(f, {"target_id": "x" * 201}),
            lambda f: invalid_witness(f, {"action": "unknown"}),
            lambda f: invalid_witness(f, {"target_id": "owned-parent"}),
            lambda f: f._binding.update(target_id="unrelated-target"),
            lambda f: f._binding["cnki_flow"].update(target_id="different-target"),
            lambda f: f._binding["cnki_flow"].update(pending_popup=None),
        ]
        for index, corrupt in enumerate(corruptions):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                fetcher, context, _, _, _ = self.make_fixture(job)
                corrupt(fetcher)
                fetcher._write_binding()
                before = self.files(job)
                self.assertFalse(fetcher.open_current()["opened"])
                self.assertTrue(all(page.fronts == 0 for page in context.pages))
                self.assert_read_only(fetcher, context, job, before)
                fetcher.close()

    def test_unverifiable_missing_owner_is_not_assumed_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, parent, child, _ = self.make_fixture(job, adopted=True)
            parent.closed = True
            child._opener = None
            # A live page cannot be identified; it might be the recorded owner.
            original_id = browser.literature_browser._target_id
            def target_id(ctx, page):
                if page is context.pages[0]:
                    raise OSError("private target error")
                return original_id(ctx, page)
            before = self.files(job)
            with patch.object(browser.literature_browser, "_target_id", side_effect=target_id):
                result = fetcher.open_current()
            self.assertFalse(result["opened"])
            self.assertNotIn("private", result["message"])
            self.assertTrue(all(page.fronts == 0 for page in context.pages))
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()

    def test_no_pending_witness_keeps_existing_bound_page_behavior(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, parent, child, _ = self.make_fixture(job, pending=False)
            before = self.files(job)
            self.assertTrue(fetcher.open_current()["opened"])
            self.assertEqual(parent.fronts, 1)
            self.assertEqual(child.fronts, 0)
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()

    def test_fronting_failure_is_sanitized_and_leaves_all_data_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, _, child, _ = self.make_fixture(job)
            before = self.files(job)
            with patch.object(child, "bring_to_front", side_effect=RuntimeError("secret URL or token")):
                result = fetcher.open_current()
            self.assertFalse(result["opened"])
            self.assertNotIn("secret", result["message"])
            self.assert_read_only(fetcher, context, job, before)
            fetcher.close()


if __name__ == "__main__":
    unittest.main()
