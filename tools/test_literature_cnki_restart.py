"""Explicit single-paper CNKI restart and exact-owned-page cleanup fixtures.

Temporary synthetic jobs only. No actual browser, CDP, databases or downloads.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as fulltext
from literature_fulltext_browser import FulltextBrowserFetcher
from test_literature_cnki_pipeline import CURRENT, CnkiFetcher, make_job, snapshot_files
from test_literature_fulltext import fake_pdf_bytes, read_status, run_stage, status_map
from test_literature_fulltext_browser import Clock, Context


class RecordingFetcher(CnkiFetcher):
    def fetch_cnki(self, record, opts):
        # Exclude the fetcher object from the copied protocol options.
        self.calls.append(("fetch_cnki", copy.deepcopy(record),
                           copy.deepcopy({key: value for key, value in opts.items() if key != "fetcher"})))
        return copy.deepcopy(self.result)


class CnkiRestartTests(unittest.TestCase):
    def assert_unchanged(self, job, original, hashes, *, selected=True):
        current = status_map(read_status(job))
        self.assertEqual(len(current), 49)
        for paper_id, item in original.items():
            if not selected or paper_id != CURRENT:
                self.assertEqual(current[paper_id], item)
        self.assertEqual(snapshot_files(job, hashes), hashes)

    def test_explicit_restart_reaches_exactly_one_target_with_flag_and_preserves_48(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            config, original, hashes = make_job(job)
            fetcher = RecordingFetcher({"status": "pdf_page", "bytes": fake_pdf_bytes(),
                                        "url": "https://kns.cnki.net/kcms2/article/read"})
            code, events = run_stage(job, config, fetcher=fetcher, resume=True, only=[CURRENT],
                                     limit=1, retry_unavailable=True, restart_cnki=True)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "result")
            calls = [call for call in fetcher.calls if call[0] == "fetch_cnki"]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1]["paper_id"], CURRENT)
            self.assertIs(calls[0][2]["cnki_restart"], True)
            self.assertEqual(fetcher.completed, 1)
            self.assertEqual(fetcher.closed, 1)
            self.assertEqual(status_map(read_status(job))[CURRENT]["status"], "fetched_pdf")
            self.assert_unchanged(job, original, hashes)

    def test_normal_resume_does_not_receive_restart_authorization(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            config, original, hashes = make_job(job)
            fetcher = RecordingFetcher({"status": "attention", "reason": "page_error",
                                        "message": "Old pending popup needs explicit restart"})
            code, events = run_stage(job, config, fetcher=fetcher, resume=True, only=[CURRENT],
                                     limit=1, retry_unavailable=True)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "attention")
            calls = [call for call in fetcher.calls if call[0] == "fetch_cnki"]
            self.assertEqual(len(calls), 1)
            self.assertIs(calls[0][2]["cnki_restart"], False)
            self.assertEqual(fetcher.completed, 0)
            self.assert_unchanged(job, original, hashes)

    def test_restart_requires_explicit_single_cnki_resume_and_mutates_nothing_on_rejection(self):
        defaults = {"resume": True, "only": [CURRENT], "limit": 1,
                    "retry_unavailable": True, "restart_cnki": True}
        cases = [
            {"resume": False}, {"retry_unavailable": False}, {"limit": None},
            {"limit": 2}, {"limit": 0}, {"only": None}, {"only": []},
            {"only": [CURRENT, "CNKI-008"]}, {"only": [CURRENT, CURRENT]},
            {"only": ["MISSING-ID"]}, {"only": ["PMID-001"]},
        ]
        for variation in cases:
            with self.subTest(variation=variation), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                config, original, hashes = make_job(job)
                before = (job / "fulltext/status.json").read_bytes()
                fetcher = RecordingFetcher({"status": "pdf_page", "bytes": fake_pdf_bytes()})
                code, events = run_stage(job, config, fetcher=fetcher, **(defaults | variation))
                self.assertEqual(code, 1)
                self.assertEqual(events[-1]["type"], "error")
                self.assertEqual(fetcher.calls, [])
                self.assertEqual(fetcher.closed, 0)
                self.assertEqual((job / "fulltext/status.json").read_bytes(), before)
                self.assert_unchanged(job, original, hashes, selected=False)

    def test_existing_fulltext_or_missing_prior_status_cannot_restart(self):
        for prior_status in ("fetched_pdf", "fetched_html", None):
            with self.subTest(prior_status=prior_status), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                config, _, hashes = make_job(job)
                document = read_status(job)
                if prior_status is None:
                    document["items"] = [item for item in document["items"] if item["paper_id"] != CURRENT]
                else:
                    item = next(item for item in document["items"] if item["paper_id"] == CURRENT)
                    item["status"] = prior_status
                fulltext.atomic_write_json(job / "fulltext/status.json", document)
                before = (job / "fulltext/status.json").read_bytes()
                fetcher = RecordingFetcher({"status": "pdf_page", "bytes": fake_pdf_bytes()})
                code, events = run_stage(job, config, fetcher=fetcher, resume=True, only=[CURRENT],
                                         limit=1, retry_unavailable=True, restart_cnki=True)
                self.assertEqual(code, 1)
                self.assertEqual(events[-1]["type"], "error")
                self.assertEqual(fetcher.calls, [])
                self.assertEqual((job / "fulltext/status.json").read_bytes(), before)
                self.assertEqual(snapshot_files(job, hashes), hashes)

    def test_cli_rejects_restart_with_read_only_modes_before_any_browser_or_review(self):
        for mode in ("--review-only", "--open-current"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                _, _, hashes = make_job(job)
                before = (job / "fulltext/status.json").read_bytes()
                events = []
                with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("no browser")), \
                     patch.object(fulltext, "review_saved_fulltext", side_effect=AssertionError("no review")), \
                     patch.object(fulltext, "emit", lambda kind, **values: events.append({"type": kind, **values})):
                    code = fulltext.main(["--config", str(job / "run_config.json"),
                                          "--output-dir", str(job), "--restart-cnki", mode])
                self.assertEqual(code, 1)
                self.assertEqual(events[-1]["type"], "error")
                self.assertIn("不能", events[-1]["message"])
                self.assertEqual((job / "fulltext/status.json").read_bytes(), before)
                self.assertEqual(snapshot_files(job, hashes), hashes)


class CnkiCleanupTests(unittest.TestCase):
    def setup_owned_pages(self, job, *, cleanup=True):
        context, clock, progress = Context(), Clock(), []
        fetcher = FulltextBrowserFetcher({}, job, runtime_factory=context.runtime,
                                        clock=clock.time, sleep=clock.sleep, on_progress=progress.append)
        self.assertEqual(fetcher.ensure_ready()["status"], "ok")
        current = fetcher._page
        old = context.new_page()
        unrelated_owned = context.new_page()
        if cleanup:
            fetcher._binding["cnki_flow"] = {"step": "download_clicked", "cleanup_target_id": old.target}
            fetcher._write_binding()
        # Represent caller already committing a valid full-text artifact/status.
        folder = job / "fulltext/files"
        folder.mkdir(parents=True)
        (folder / "CNKI-007.pdf").write_bytes(fake_pdf_bytes())
        fulltext.atomic_write_json(job / "fulltext/status.json", {"items": [
            {"paper_id": CURRENT, "status": "fetched_pdf", "path": "fulltext/files/CNKI-007.pdf"}]})
        hashes = snapshot_files(job, ["fulltext/status.json", "fulltext/files/CNKI-007.pdf"])
        return fetcher, context, current, old, unrelated_owned, progress, hashes

    def test_cleanup_closes_only_exact_recorded_task_pages_after_save(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, current, old, unrelated_owned, progress, hashes = self.setup_owned_pages(job)
            result = fetcher.complete_paper()
            self.assertTrue(result["closed"])
            self.assertTrue(current.closed)
            self.assertTrue(old.closed)
            self.assertFalse(unrelated_owned.closed)
            self.assertTrue(all(not page.closed for page in context.pages[:2]))
            self.assertTrue(all(not page.gotos for page in context.pages))
            self.assertEqual(snapshot_files(job, hashes), hashes)
            binding = json.loads(fetcher.binding_path.read_text(encoding="utf-8"))
            self.assertNotIn("target_id", binding)
            self.assertNotIn("cnki_flow", binding)
            fetcher.close()

    def test_unknown_cleanup_id_never_closes_another_page(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, current, old, unrelated_owned, _, hashes = self.setup_owned_pages(job)
            fetcher._binding["cnki_flow"]["cleanup_target_id"] = "missing-exact-owned-target"
            fetcher._write_binding()
            self.assertTrue(fetcher.complete_paper()["closed"])
            self.assertTrue(current.closed)
            self.assertFalse(old.closed)
            self.assertFalse(unrelated_owned.closed)
            self.assertTrue(all(not page.closed for page in context.pages[:2]))
            self.assertEqual(snapshot_files(job, hashes), hashes)
            fetcher.close()

    def test_cleanup_failure_keeps_saved_artifact_and_cleanup_record_for_manual_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, current, old, unrelated_owned, progress, hashes = self.setup_owned_pages(job)
            with patch.object(old, "close", side_effect=RuntimeError("sensitive exception text")):
                result = fetcher.complete_paper()
            self.assertFalse(result["closed"])
            self.assertTrue(current.closed)
            self.assertFalse(old.closed)
            self.assertFalse(unrelated_owned.closed)
            self.assertTrue(all(not page.closed for page in context.pages[:2]))
            self.assertEqual(snapshot_files(job, hashes), hashes)
            binding = json.loads(fetcher.binding_path.read_text(encoding="utf-8"))
            self.assertEqual(binding["cnki_flow"]["cleanup_target_id"], old.target)
            self.assertEqual(binding["target_id"], current.target)
            self.assertTrue(any("文件已保存" in message and "手动关闭" in message for message in progress))
            self.assertFalse(any("sensitive exception text" in message for message in progress))
            fetcher.close()

    def test_blocked_operation_closes_no_pages_even_with_cleanup_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            fetcher, context, _, _, _, _, hashes = self.setup_owned_pages(job)
            fetcher._blocked = {"status": "attention", "reason": "verification"}
            self.assertFalse(fetcher.complete_paper()["closed"])
            self.assertTrue(all(not page.closed for page in context.pages))
            self.assertEqual(snapshot_files(job, hashes), hashes)
            fetcher.close()


if __name__ == "__main__":
    unittest.main()
