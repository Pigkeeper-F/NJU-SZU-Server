"""Offline CNKI metadata-tab lifecycle; no site, credentials or model access."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_metadata as metadata
import literature_fulltext_browser as browser
from test_literature_cnki_fulltext import Clock, Context, ui
from test_literature_metadata import ABSTRACT, snapshot


ROOT = Path(__file__).resolve().parents[1]


def record(index=1):
    return {"candidate_id": f"CNKI-{index}", "source_key": "cnki",
            "title": f"环境温度对肉鸡生长性能的影响试验{index}",
            "doi": f"10.1234/cleanup{index}", "authors": ["Author A"], "year": 2024,
            "result_url": "https://kns.cnki.net/kcms2/article/abstract?filename=fixture"}


class InteractiveMetadata(metadata.MetadataBrowserFetcher):
    """Real source-click flow with two owned tabs per article, fake DOM only."""
    def __init__(self, job, clock, context):
        self.context, self.current_record = context, None
        self.browser = browser.FulltextBrowserFetcher({}, job / "metadata/browser",
            runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)
        self.seen = []
        self.observed = None

    def fetch_record(self, current, url, timeout_sec=30):
        self.current_record = current
        self.seen.append(current["candidate_id"])
        self.context.initial_ui = ui(title=current["title"], query=current["title"])

        def setup(parent):
            def open_detail(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.snap.update(citation_title=current["title"], citation_doi=current["doi"])
                child.ui["titles"] = [current["title"]]
                owner.emit("popup", child)
            parent.on_title = open_detail
        self.context.next_setup = setup
        # An unfixed worker can reuse the prior detail as the next search page.
        # Its newly rendered title control must represent the current record,
        # just as real DOM navigation would; do not manufacture a title mismatch.
        active = self.browser._page
        if active is not None and not active.is_closed():
            setup(active)
            self.context.next_setup = None
        return super().fetch_record(current, url, timeout_sec)

    def _read_metadata(self, page, deadline, **kwargs):
        if isinstance(self.observed, BaseException):
            raise self.observed
        if self.observed is not None:
            return copy.deepcopy(self.observed)
        return {"status": "ok", "url": page.url,
                "snapshot": snapshot(self.current_record)}


class MetadataCleanupTests(unittest.TestCase):
    def setUp(self):
        temp_root = ROOT / ".tmp-literature-tests"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        self.clock, self.context = Clock(), None
        self.context = Context(self.clock)
        self.fetcher = InteractiveMetadata(self.job, self.clock, self.context)
        self.addCleanup(self.fetcher.close)

    def write(self, records):
        (self.job / "candidates.json").write_text(json.dumps({"records": records}), encoding="utf-8")

    def run_metadata(self, **kwargs):
        return metadata.run({}, self.job, fetcher=self.fetcher,
                            on_event=lambda *args, **kw: None, **kwargs)

    def terminal(self, current=None):
        current = current or record()
        result = self.fetcher.fetch_record(current, current["result_url"])
        self.assertEqual(result["status"], "ok", result)
        item = metadata.verify_snapshot(current, result["snapshot"], result["url"])
        self.assertEqual(item["status"], "verified", item)
        return current, item

    def test_multiple_articles_save_before_closing_search_parent_and_detail(self):
        self.write([record(1), record(2), record(3)])
        closed = []
        original = self.fetcher.complete_record

        def after_saved(current, item):
            persisted = json.loads((self.job / "metadata/status.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["items"][current["candidate_id"]]["status"], "verified")
            self.assertEqual(persisted["items"][current["candidate_id"]]["evidence"]["abstract"], ABSTRACT)
            result = original(current, item)
            self.assertTrue(result.get("closed"), result)
            closed.append(current["candidate_id"])
            self.assertTrue(all(page.closed for page in self.context.pages[1:]))
            self.assertFalse(self.context.pages[0].closed)
            self.assertNotIn("target_id", self.fetcher.browser._binding)
            self.assertNotIn("cnki_flow", self.fetcher.browser._binding)
            return result

        self.fetcher.complete_record = after_saved
        result = self.run_metadata()
        self.assertTrue(result["complete"], result)
        self.assertEqual(closed, ["CNKI-1", "CNKI-2", "CNKI-3"])
        self.assertEqual(self.context.creates, 6)
        self.assertEqual(sum(not page.closed for page in self.context.pages), 1)

    def test_attention_retains_original_search_and_detail(self):
        for reason in ("verification", "login", "page_not_ready", "page_error"):
            with self.subTest(reason=reason):
                self.fetcher.observed = {"status": "attention", "reason": reason}
                current = record(len(self.fetcher.seen) + 1)
                result = self.fetcher.fetch_record(current, current["result_url"])
                self.assertEqual(result["status"], "attention")
                before = sum(page.closed for page in self.context.pages)
                outcome = self.fetcher.complete_record(current, {"status": "attention", "reason": reason})
                self.assertFalse(outcome.get("closed"), outcome)
                self.assertEqual(sum(page.closed for page in self.context.pages), before)
                self.assertFalse(self.context.pages[0].closed)

    def test_download_state_cannot_be_closed_as_metadata_complete(self):
        current, item = self.terminal()
        flow = self.fetcher.browser._binding["cnki_flow"]
        flow.update(step="download_clicked", download_click_count=1)
        flow["pending_popup"]["action"] = "download"
        original = copy.deepcopy(self.fetcher.browser._binding)
        result = self.fetcher.complete_record(current, item)
        self.assertFalse(result.get("closed"), result)
        self.assertEqual(self.fetcher.browser._binding, original)
        self.assertTrue(all(not page.closed for page in self.context.pages))

    def test_different_record_cannot_close_the_active_article(self):
        _, item = self.terminal()
        result = self.fetcher.complete_record(record(2), item)
        self.assertFalse(result.get("closed"), result)
        self.assertTrue(all(not page.closed for page in self.context.pages))

    def test_save_failure_does_not_close_unpersisted_article(self):
        self.write([record()])
        with patch.object(metadata.common, "atomic_write_json", side_effect=OSError("fixture disk failure")):
            with self.assertRaises(OSError):
                self.run_metadata()
        self.assertEqual(self.fetcher.seen, ["CNKI-1"])
        self.assertTrue(all(not page.closed for page in self.context.pages))

    def test_interrupted_read_keeps_unfinished_pages(self):
        self.write([record()])
        self.fetcher.observed = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.run_metadata()
        self.assertTrue(all(not page.closed for page in self.context.pages))

    def test_cleanup_failure_stops_before_opening_next_record(self):
        self.write([record(1), record(2)])
        original = self.fetcher.complete_record

        def fail_close(current, item):
            def failed(**kwargs):
                raise OSError("fixture close failure")
            self.fetcher.browser._page.close = failed
            return original(current, item)

        self.fetcher.complete_record = fail_close
        result = self.run_metadata()
        self.assertFalse(result["complete"], result)
        self.assertEqual(result["stop_reason"], "page_error")
        self.assertEqual(self.fetcher.seen, ["CNKI-1"])
        persisted = json.loads((self.job / "metadata/status.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["items"]["CNKI-1"]["status"], "verified")
        self.assertTrue(persisted["items"]["CNKI-1"]["cleanup_pending"])
        self.assertFalse(self.context.pages[0].closed)

    def test_resume_retries_only_cleanup_before_reading_the_next_article(self):
        self.write([record(1), record(2)])
        original_complete = self.fetcher.complete_record
        old_close = []

        def fail_close(current, item):
            page = self.fetcher.browser._page
            old_close.append((page, page.close))
            def failed(**kwargs):
                raise OSError("fixture close failure")
            page.close = failed
            return original_complete(current, item)

        self.fetcher.complete_record = fail_close
        self.assertFalse(self.run_metadata()["complete"])
        self.assertEqual(self.fetcher.seen, ["CNKI-1"])
        for page, close in old_close:
            page.close = close
        self.fetcher.complete_record = original_complete
        result = self.run_metadata()
        self.assertTrue(result["complete"], result)
        self.assertEqual(self.fetcher.seen, ["CNKI-1", "CNKI-2"], "completed abstract must not be fetched again")
        persisted = json.loads((self.job / "metadata/status.json").read_text(encoding="utf-8"))
        self.assertNotIn("cleanup_pending", persisted["items"]["CNKI-1"])
        self.assertTrue(all(page.closed for page in self.context.pages[1:]))
        self.assertFalse(self.context.pages[0].closed)


if __name__ == "__main__":
    unittest.main()
