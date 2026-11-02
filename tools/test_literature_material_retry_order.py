"""Explicit material retry order and preservation; offline fixtures only."""
import json
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf
from test_literature_defer_access import DeferredFetcher
from test_literature_fulltext import read_status, run_stage
from test_literature_fulltext_reuse import snapshot
import test_literature_replenish as replenish_tests


class MaterialRetryOrderTests(unittest.TestCase):
    def fixture(self, root, **kwargs):
        return replenish_tests.ReplenishmentTests().fixture(root, **kwargs)

    def run_retry(self, job, config, fetcher, **kwargs):
        with patch.object(lf, "_europe_pmc_pdf_urls", side_effect=AssertionError("No external network")), patch.object(lf, "_pmc_xml_item", side_effect=AssertionError("No body re-download")):
            return run_stage(job, config, fetcher=fetcher, resume=True,
                             replenish_materials=True, defer_access=True, **kwargs)

    def mark_skipped(self, job, store, targets, indices):
        items = read_status(job)["items"]
        for index in indices:
            marker = {"reason": "pdf_unavailable", "message": "Earlier explicit missing file", "skipped_at": "2026-10-25T00:00:00Z", "policy": "skip_non_access"}
            items[index]["material_skipped"] = dict(marker)
            store.paper(targets[index])["material_skipped"] = dict(marker)
        store.flush()
        lf._write_status(job, items)
        return items

    def test_009_first_union_of_deferred_and_skipped_preserves_frozen_order_and_original_pdfs(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, count=9, pdf_count=7, html_count=0, checked="none_declared")
            store.record_discovery(targets[0], {"status": "unknown", "links": []})
            items = self.mark_skipped(job, store, targets, [0, 7])
            items[8]["material_deferred"] = {"reason": "page_not_ready", "message": "Still generating"}
            store.paper(targets[8])["material_deferred"] = dict(items[8]["material_deferred"])
            store.flush(); lf._write_status(job, items)
            before = snapshot(job)
            fetcher = DeferredFetcher(records)
            code, events = self.run_retry(job, config, fetcher, first_paper_id="PMID-009", retry_deferred=True, retry_skipped=True)
            self.assertEqual((code, events[-1]["type"]), (0, "result"))
            self.assertEqual(fetcher.resumed, ["PMID-009"])
            starts = [event["message"] for event in events if event.get("message", "").startswith("获取全文 ")]
            self.assertIn(records[8]["title"], starts[0])
            self.assertEqual([url for kind, url in fetcher.calls if kind == "fetch_pdf"], [records[8]["fulltext_links"][0]["url"], records[7]["fulltext_links"][0]["url"]])
            self.assertEqual(read_status(job)["counts"]["fetched_pdf"], 9)
            self.assertEqual([item["paper_id"] for item in read_status(job)["items"]], [record["candidate_id"] for record in records])
            for name, blob in before.items():
                if name in {"run_config.json", "candidates.json", "candidates.csv", "dedupe/dedupe.json", "dedupe/dedupe.csv", "materials-basis.json"} or name.replace("\\", "/").startswith("fulltext/files/"):
                    self.assertEqual((job / name).read_bytes(), blob, name)
            history = json.loads((job / "fulltext/material-retries.json").read_text(encoding="utf-8"))["items"]
            self.assertEqual([item["paper_id"] for item in history], ["PMID-001", "PMID-008"])
            self.assertTrue(all(item["authorization"] == "explicit_retry_skipped" for item in history))
            self.assertEqual(history[0]["previous_skip"]["skipped_at"], "2026-10-25T00:00:00Z")
            self.assertFalse(any((job / name).exists() for name in ("extraction", "validation", "export")))

    def test_default_and_deferred_retry_do_not_reopen_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, count=1, html_count=0)
            self.mark_skipped(job, store, targets, [0])
            for retry_deferred in (False, True):
                fetcher = DeferredFetcher(records)
                code, _ = self.run_retry(job, config, fetcher, retry_deferred=retry_deferred)
                self.assertEqual(code, 0)
                self.assertEqual(fetcher.calls, [])
                self.assertIn("material_skipped", read_status(job)["items"][0])
            self.assertFalse((job / "fulltext/material-retries.json").exists())

    def test_saved_main_and_attachment_reused_during_explicit_retry(self):
        from literature_materials import MaterialsStore
        from test_literature_materials import csv_blob, descriptor
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, count=1, pdf_count=1, html_count=0, checked="checked")
            attachment = descriptor("data.csv", label="Supplementary data")
            store.record_discovery(targets[0], {"status": "checked", "links": [attachment]})
            store.save_download(targets[0], attachment, {"bytes": csv_blob()})
            self.mark_skipped(job, store, targets, [0])
            before = snapshot(job)
            fetcher = DeferredFetcher(records, inspections={"PMID-001": {"status": "ok", "material_discovery": {"status": "checked", "links": [attachment]}}})
            code, events = self.run_retry(job, config, fetcher, retry_skipped=True, first_paper_id="PMID-001")
            self.assertEqual((code, events[-1]["type"]), (0, "result"))
            self.assertFalse(any(kind == "fetch_pdf" for kind, _ in fetcher.calls))
            self.assertEqual(fetcher.material_calls, [])
            for name, blob in before.items():
                if name.replace("\\", "/").startswith("fulltext/files/") or name.replace("\\", "/").startswith("fulltext/supplements/"):
                    self.assertEqual((job / name).read_bytes(), blob)
            self.assertTrue(MaterialsStore(job, targets).paper_ready(targets[0]))

    def test_invalid_scope_unknown_first_or_unselected_first_do_not_fetch_or_clear_skip(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, count=2, pdf_count=1, html_count=0, checked="none_declared")
            self.mark_skipped(job, store, targets, [1])
            attempts = [
                {"resume": True, "first_paper_id": "PMID-002"},
                {"resume": True, "replenish_materials": True, "retry_skipped": True},
                {"resume": True, "replenish_materials": True, "defer_access": True, "retry_skipped": True, "first_paper_id": "PMID-999"},
                {"resume": True, "replenish_materials": True, "defer_access": True, "retry_skipped": True, "first_paper_id": "PMID-001"},
                {"resume": True, "replenish_materials": True, "defer_access": True, "retry_skipped": "yes"},
            ]
            for options in attempts:
                fetcher = DeferredFetcher(records)
                code, events = run_stage(job, config, fetcher=fetcher, **options)
                self.assertEqual((code, events[-1]["type"]), (1, "error"), options)
                self.assertEqual(fetcher.calls, [])
                self.assertIn("material_skipped", read_status(job)["items"][1])
            self.assertFalse((job / "fulltext/material-retries.json").exists())


if __name__ == "__main__":
    unittest.main()
