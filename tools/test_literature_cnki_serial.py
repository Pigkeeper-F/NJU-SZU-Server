"""Offline regressions for ending a saved CNKI paper before the next one."""
from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

import literature_cnki_fulltext as cnki
import literature_fulltext as fulltext
from test_literature_fulltext import candidate, fake_pdf_bytes, run_stage, write_candidates


class SerialFetcher:
    def __init__(self, owner, *, closes=True, blocked=None):
        self._binding = {"target_id": "previous-detail", "cnki_flow": {
            "paper_hash": cnki._hash("\n".join(str(owner.get(key) or "") for key in
                ("source_key", "source_candidate_id", "paper_id", "id"))),
            "title_hash": cnki._hash(cnki._norm(owner["title"])),
            "step": "download_clicked", "file_verified": True,
            "pending_popup": {"target_id": "previous-download", "owner_target_id": "previous-detail",
                              "opener_verified": True, "action": "download", "adopted": False},
            "cleanup_target_id": "previous-lookup"}}
        self._blocked = blocked
        self.closes = closes
        self.calls = []

    def complete_paper(self):
        self.calls.append("close_previous")
        if self.closes:
            self._binding = {}
            self._blocked = None
        return {"closed": self.closes}

    def ensure_ready(self):
        self.calls.append("ensure_ready")
        return {"status": "ok"}

    def fetch_cnki(self, record, opts):
        self.calls.append("fetch_" + record["paper_id"])
        if self._binding:
            raise AssertionError("next paper must not receive the previous binding")
        return {"status": "attention", "reason": "page_not_ready", "message": "synthetic end of test"}

    def close(self):
        self.calls.append("disconnect")


class CnkiSerialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        rows = [candidate(cid, title="Synthetic " + cid, source_key="cnki",
                          result_url="https://kns.cnki.net/kcms2/article/abstract")
                for cid in ("CNKI-104", "CNKI-003")]
        write_candidates(self.job, rows)
        self.config = {"version": 2, "sources": ["cnki"], "fulltext": {"maxPapers": 0}}
        self.targets = fulltext.load_targets(self.job, self.config)
        self.owner, self.current = self.targets
        blob = fake_pdf_bytes()
        relative = "fulltext/files/CNKI-104.pdf"
        path = self.job / relative
        path.parent.mkdir(parents=True)
        path.write_bytes(blob)
        self.saved = fulltext._item_skeleton(self.owner)
        self.saved.update(status="fetched_pdf", kind="pdf", path=relative, size=len(blob),
                          content_sha256=hashlib.sha256(blob).hexdigest())
        self.items = [self.saved, fulltext._item_skeleton(self.current)]

    def finish(self, fetcher):
        return fulltext._finish_previous_cnki_paper(fetcher, self.job, self.current, self.targets, self.items)

    def test_verified_saved_previous_is_closed_and_unbound_before_next(self):
        fetcher = SerialFetcher(self.owner, blocked={"reason": "page_error"})
        self.assertIsNone(self.finish(fetcher))
        self.assertEqual(fetcher.calls, ["close_previous"])
        self.assertEqual(fetcher._binding, {})
        self.assertIsNone(fetcher._blocked)

    def test_same_paper_resume_preserves_download_and_witness(self):
        fetcher = SerialFetcher(self.current)
        original = copy.deepcopy(fetcher._binding)
        self.assertIsNone(self.finish(fetcher))
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(fetcher._binding, original)

    def test_unfinished_download_is_not_discarded(self):
        fetcher = SerialFetcher(self.owner)
        fetcher._binding["cnki_flow"].pop("file_verified")
        self.assertIsNone(self.finish(fetcher))
        self.assertEqual(fetcher.calls, [])
        self.assertIn("pending_popup", fetcher._binding["cnki_flow"])

    def test_auth_or_rate_barrier_keeps_original_window(self):
        for reason in ("verification", "login", "access_required", "rate_limited", "access_blocked"):
            with self.subTest(reason=reason):
                fetcher = SerialFetcher(self.owner, blocked={"reason": reason})
                original = copy.deepcopy(fetcher._binding)
                result = self.finish(fetcher)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(fetcher.calls, [])
                self.assertEqual(fetcher._binding, original)

    def test_binding_auth_reason_is_preserved_without_in_memory_block(self):
        fetcher = SerialFetcher(self.owner)
        fetcher._binding["attention_reason"] = "verification"
        self.assertEqual(self.finish(fetcher)["reason"], "verification")
        self.assertEqual(fetcher.calls, [])

    def test_file_verified_does_not_replace_durable_pdf_evidence(self):
        for problem in ("missing", "hash_mismatch", "status_pending"):
            with self.subTest(problem=problem):
                fetcher = SerialFetcher(self.owner)
                original = copy.deepcopy(self.saved)
                path = self.job / self.saved["path"]
                data = path.read_bytes()
                if problem == "missing":
                    path.unlink()
                elif problem == "hash_mismatch":
                    self.saved["content_sha256"] = "0" * 64
                else:
                    self.saved["status"] = "pending"
                self.assertEqual(self.finish(fetcher)["reason"], "local_fulltext_verification")
                self.assertEqual(fetcher.calls, [])
                self.saved.clear()
                self.saved.update(original)
                path.write_bytes(data)

    def test_unknown_previous_or_ambiguous_owner_cannot_be_closed(self):
        for targets in ([self.current], [self.owner, self.owner, self.current]):
            fetcher = SerialFetcher(self.owner)
            result = fulltext._finish_previous_cnki_paper(fetcher, self.job, self.current, targets, self.items)
            self.assertEqual(result["reason"], "local_fulltext_verification")
            self.assertEqual(fetcher.calls, [])

    def test_cleanup_refusal_is_explicit_barrier(self):
        fetcher = SerialFetcher(self.owner, closes=False)
        result = self.finish(fetcher)
        self.assertEqual(result["reason"], "material_cleanup")
        self.assertEqual(result["paper_id"], self.owner["paper_id"])
        self.assertIn("cnki_flow", fetcher._binding)

    def test_fetcher_without_binding_remains_compatible(self):
        self.assertIsNone(self.finish(object()))

    def test_driver_resumes_next_only_after_saved_previous_closes(self):
        fulltext._write_status(self.job, self.items)
        fetcher = SerialFetcher(self.owner, blocked={"reason": "page_error"})
        code, events = run_stage(self.job, self.config, fetcher=fetcher, resume=True)
        self.assertEqual(code, 0)
        self.assertLess(fetcher.calls.index("close_previous"), fetcher.calls.index("fetch_CNKI-003"))
        self.assertNotIn("fetch_CNKI-104", fetcher.calls)
        self.assertEqual(events[-1]["reason"], "page_not_ready")

    def test_driver_does_not_open_next_if_previous_cleanup_refuses(self):
        fulltext._write_status(self.job, self.items)
        fetcher = SerialFetcher(self.owner, closes=False)
        code, events = run_stage(self.job, self.config, fetcher=fetcher, resume=True)
        self.assertEqual(code, 0)
        self.assertEqual(fetcher.calls, ["close_previous", "disconnect"])
        self.assertEqual(events[-1]["type"], "attention")
        self.assertEqual(events[-1]["reason"], "material_cleanup")


if __name__ == "__main__":
    unittest.main()
