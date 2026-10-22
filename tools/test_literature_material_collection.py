"""Material coordinator integration checks using synthetic local jobs only."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as fulltext
from literature_material_collection import MaterialCollection
from literature_materials import MaterialsError, MaterialsStore
from test_literature_fulltext_reuse import OLD, NEW, make_job, row, save_pdf, snapshot
from test_literature_materials import csv_blob, descriptor


def discovery(*entries):
    return {"status": "checked", "reason": "Verified synthetic article page", "links": list(entries)}


class Fetcher:
    def __init__(self, store, record, results=None, *, cleanup=True):
        self.store, self.record = store, record
        self.results = list(results or [])
        self.fetched, self.completed, self.inspections = [], 0, 0
        self.cleanup = cleanup

    def fetch_material(self, entry, record, opts):
        self.fetched.append(entry["material_id"])
        return self.results.pop(0)

    def complete_material(self):
        # Acknowledging/closing the browser page may only follow durable bytes
        # and the matching downloaded manifest record, never just RAM state.
        manifest = json.loads(self.store.path.read_text(encoding="utf-8"))
        paper = next(item for item in manifest["papers"] if item["paper_id"] == self.record["paper_id"])
        current = next(item for item in paper["materials"] if item["material_id"] == self.fetched[-1])
        assert current["download_status"] == "downloaded"
        blob = (self.store.job_dir / current["path"]).read_bytes()
        assert hashlib.sha256(blob).hexdigest() == current["sha256"]
        self.completed += 1
        return {"closed": self.cleanup}

    def inspect_materials(self, record, opts):
        self.inspections += 1
        assert opts["record"]["paper_id"] == record["paper_id"]
        result = opts["on_material_discovery"](discovery())
        return result or {"status": "ok"}

    def fetch(self, *_args, **_kwargs):
        raise AssertionError("Inspecting existing materials must not download the main paper")

    def fetch_cnki(self, *_args, **_kwargs):
        raise AssertionError("Inspecting existing materials must not replay the main paper click")


class PendingFetcher(Fetcher):
    def __init__(self, store, record, state):
        super().__init__(store, record)
        self.state = state

    def pending_material_state(self, record):
        assert record["paper_id"] == self.record["paper_id"]
        return self.state

    def complete_material(self):
        manifest = json.loads(self.store.path.read_text(encoding="utf-8"))
        paper = next(item for item in manifest["papers"] if item["paper_id"] == self.record["paper_id"])
        saved = next(item for item in paper["materials"] if item["material_id"] == self.state["material_id"])
        assert saved["download_status"] == "downloaded"
        assert saved["sha256"] == self.state["sha256"]
        assert hashlib.sha256((self.store.job_dir / saved["path"]).read_bytes()).hexdigest() == saved["sha256"]
        self.completed += 1
        self.state = None
        return {"closed": True}


class MaterialCollectionTests(unittest.TestCase):
    def fixture(self, root, job_id=NEW, candidate_id="CURRENT", *, main=False):
        candidate = row(candidate_id)
        job = make_job(root, job_id, [candidate])
        record = fulltext._target_from_candidate(candidate)
        if main:
            record, _ = save_pdf(job, candidate)
        return job, record, MaterialsStore(job, [record])

    def collector(self, store, record, fetcher):
        ready = []

        def ensure_ready():
            ready.append(True)
            return {"status": "ok"}

        return MaterialCollection(store, record, fetcher, ensure_ready), ready

    def test_file_and_manifest_exist_before_browser_is_acknowledged(self):
        with tempfile.TemporaryDirectory() as root:
            _, record, store = self.fixture(root)
            fetcher = Fetcher(store, record, [{"status": "file", "bytes": csv_blob()}])
            collect, ready = self.collector(store, record, fetcher)
            self.assertIsNone(collect.observe(discovery(descriptor())))
            self.assertEqual((len(fetcher.fetched), fetcher.completed, len(ready)), (1, 1, 1))
            saved = store.paper(record)["materials"][0]
            self.assertEqual(saved["download_status"], "downloaded")
            self.assertEqual(saved["read_status"], "readable")

    def test_save_failure_does_not_acknowledge_or_close_download_window(self):
        with tempfile.TemporaryDirectory() as root:
            _, record, store = self.fixture(root)
            fetcher = Fetcher(store, record, [{"status": "file", "bytes": csv_blob()}])
            collect, _ = self.collector(store, record, fetcher)
            with patch.object(store, "save_download", side_effect=MaterialsError("Synthetic local storage failure")):
                result = collect.observe(discovery(descriptor()))
            self.assertEqual(result["status"], "attention")
            self.assertEqual(fetcher.completed, 0)
            self.assertNotEqual(store.paper(record)["materials"][0]["download_status"], "downloaded")

    def test_cleanup_failure_keeps_successfully_saved_original_downloaded(self):
        with tempfile.TemporaryDirectory() as root:
            job, record, store = self.fixture(root)
            fetcher = Fetcher(store, record, [{"status": "file", "bytes": csv_blob()}], cleanup=False)
            collect, _ = self.collector(store, record, fetcher)
            result = collect.observe(discovery(descriptor()))
            self.assertEqual(result["reason"], "material_cleanup")
            self.assertEqual(fetcher.completed, 1)
            saved = store.paper(record)["materials"][0]
            self.assertEqual(saved["download_status"], "downloaded")
            self.assertEqual((job / saved["path"]).read_bytes(), csv_blob())
            self.assertEqual(store.paper(record)["supplement_check"]["status"], "needs_attention")

    def test_saved_unreadable_and_unsupported_originals_are_never_requested_again(self):
        for extension, blob, expected in (("pdf", b"not a valid PDF", "unreadable"),
                                           ("xls", b"original legacy spreadsheet bytes", "unsupported")):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as root:
                _, record, store = self.fixture(root)
                entry = descriptor("S1." + extension)
                first = Fetcher(store, record, [{"status": "file", "bytes": blob}])
                collect, _ = self.collector(store, record, first)
                self.assertIsNone(collect.observe(discovery(entry)))
                self.assertEqual(store.paper(record)["materials"][0]["read_status"], expected)
                # Recreate the store/coordinator, so skipping relies on durable
                # manifest+SHA rather than the first Python object's memory.
                fresh = MaterialsStore(store.job_dir, [record])
                second = Fetcher(fresh, record)
                resumed, ready = self.collector(fresh, record, second)
                self.assertIsNone(resumed.observe(discovery(entry)))
                self.assertEqual(second.fetched, [])
                self.assertEqual(second.completed, 0)
                self.assertEqual(ready, [])

    def test_attention_on_later_material_preserves_first_and_resumes_only_unfinished(self):
        with tempfile.TemporaryDirectory() as root:
            job, record, store = self.fixture(root)
            first_entry = descriptor("S1.csv")
            second_entry = descriptor("S2.csv", label="Supplementary Table S2")
            fetcher = Fetcher(store, record, [{"status": "file", "bytes": csv_blob()},
                {"status": "attention", "reason": "verification", "message": "Synthetic verification required"}])
            collect, _ = self.collector(store, record, fetcher)
            self.assertEqual(collect.observe(discovery(first_entry, second_entry))["status"], "attention")
            saved = store.paper(record)["materials"][0]
            self.assertEqual(saved["download_status"], "downloaded")
            preserved_path, preserved_bytes = saved["path"], (job / saved["path"]).read_bytes()
            self.assertEqual(fetcher.completed, 1)
            fresh = MaterialsStore(job, [record])
            resumed_fetcher = Fetcher(fresh, record, [{"status": "file", "bytes": b"value\n23\n"}])
            resumed, _ = self.collector(fresh, record, resumed_fetcher)
            self.assertIsNone(resumed.observe(discovery(first_entry, second_entry)))
            self.assertEqual(len(resumed_fetcher.fetched), 1)
            self.assertEqual((job / preserved_path).read_bytes(), preserved_bytes)
            self.assertTrue(all(item["download_status"] == "downloaded" for item in fresh.paper(record)["materials"]))

    def test_cross_task_reuse_precedes_browser_connection_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as root:
            old, old_record, old_store = self.fixture(root, OLD, "ORIGINAL")
            old_store.record_discovery(old_record, discovery(descriptor()))
            old_store.save_download(old_record, descriptor(), {"bytes": csv_blob()})
            old_snapshot = snapshot(old)
            job, record, store = self.fixture(root)
            fetcher = Fetcher(store, record)
            collect, ready = self.collector(store, record, fetcher)
            self.assertIsNone(collect.observe(discovery(descriptor())))
            self.assertEqual((fetcher.fetched, fetcher.completed, ready), ([], 0, []))
            saved = store.paper(record)["materials"][0]
            self.assertEqual(saved["reused_from"]["job_id"], OLD)
            self.assertEqual((job / saved["path"]).read_bytes(), csv_blob())
            self.assertEqual(snapshot(old), old_snapshot)

    def test_inspect_existing_keeps_main_pdf_and_never_calls_main_fetch(self):
        with tempfile.TemporaryDirectory() as root:
            job, record, store = self.fixture(root, main=True)
            original_status = (job / "fulltext/status.json").read_bytes()
            main = next(item for item in store.paper(record)["materials"] if item["role"] == "main_pdf")
            original_pdf = (job / main["path"]).read_bytes()
            fetcher = Fetcher(store, record)
            collect, ready = self.collector(store, record, fetcher)
            self.assertIsNone(collect.inspect_existing({"resume": True}))
            self.assertEqual((fetcher.inspections, fetcher.fetched, fetcher.completed, len(ready)), (1, [], 0, 1))
            self.assertEqual((job / main["path"]).read_bytes(), original_pdf)
            self.assertEqual((job / "fulltext/status.json").read_bytes(), original_status)
            self.assertEqual(store.paper(record)["main_pdf_status"], "downloaded")
            self.assertEqual(store.paper(record)["supplement_check"]["status"], "checked")

    def test_matching_durable_pending_material_can_be_acknowledged_without_downloading(self):
        for entrypoint in ("observe", "inspect_existing"):
            with self.subTest(entrypoint=entrypoint), tempfile.TemporaryDirectory() as root:
                _, record, store = self.fixture(root)
                saved = store.save_download(record, descriptor(), {"bytes": csv_blob()})
                state = {"status": "file_received", "material_id": saved["material_id"],
                         "sha256": saved["sha256"], "size": saved["size"]}
                fresh = MaterialsStore(store.job_dir, [record])
                fetcher = PendingFetcher(fresh, record, state)
                collect, _ = self.collector(fresh, record, fetcher)
                result = (collect.observe(discovery(descriptor())) if entrypoint == "observe"
                          else collect.inspect_existing({"resume": True}))
                self.assertIsNone(result)
                self.assertEqual((fetcher.completed, fetcher.fetched), (1, []))
                self.assertEqual(fresh.paper(record)["materials"][0]["download_status"], "downloaded")

    def test_mismatching_pending_sha_or_size_pauses_without_cleaning_or_redownloading(self):
        for field, value in (("sha256", "f" * 64), ("size", 9000)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as root:
                job, record, store = self.fixture(root)
                saved = store.save_download(record, descriptor(), {"bytes": csv_blob()})
                state = {"status": "file_received", "material_id": saved["material_id"],
                         "sha256": saved["sha256"], "size": saved["size"], field: value}
                fetcher = PendingFetcher(store, record, state)
                collect, _ = self.collector(store, record, fetcher)
                result = collect.observe(discovery(descriptor()))
                self.assertEqual(result["reason"], "local_material_verification")
                self.assertEqual((fetcher.completed, fetcher.fetched), (0, []))
                self.assertEqual((job / saved["path"]).read_bytes(), csv_blob())
                self.assertEqual(saved["download_status"], "downloaded")

    def test_pending_manifest_match_still_checks_actual_original_sha_before_cleaning(self):
        with tempfile.TemporaryDirectory() as root:
            job, record, store = self.fixture(root)
            saved = store.save_download(record, descriptor(), {"bytes": csv_blob()})
            state = {"status": "file_received", "material_id": saved["material_id"],
                     "sha256": saved["sha256"], "size": saved["size"]}
            (job / saved["path"]).write_bytes(b"x" * saved["size"])
            fetcher = PendingFetcher(store, record, state)
            collect, _ = self.collector(store, record, fetcher)
            result = collect.inspect_existing({"resume": True})
            self.assertEqual(result["reason"], "local_material_verification")
            self.assertEqual((fetcher.completed, fetcher.inspections, fetcher.fetched), (0, 0, []))
            self.assertIsNotNone(fetcher.state, "keep the exact browser handoff pending for diagnosis")
            self.assertEqual(saved["sha256"], state["sha256"], "never replace expected evidence with corrupted bytes")

    def test_missing_saved_original_does_not_ack_or_discard_browser_staging(self):
        with tempfile.TemporaryDirectory() as root:
            job, record, store = self.fixture(root)
            saved = store.save_download(record, descriptor(), {"bytes": csv_blob()})
            state = {"status": "file_received", "material_id": saved["material_id"],
                     "sha256": saved["sha256"], "size": saved["size"]}
            (job / saved["path"]).unlink()
            fetcher = PendingFetcher(store, record, state)
            collect, _ = self.collector(store, record, fetcher)
            result = collect.inspect_existing({"resume": True})
            self.assertEqual(result["reason"], "local_material_verification")
            self.assertEqual((fetcher.completed, fetcher.inspections, fetcher.fetched), (0, 0, []))
            self.assertIsNotNone(fetcher.state)


if __name__ == "__main__":
    unittest.main()
