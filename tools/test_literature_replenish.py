"""Material-only snapshot continuation; offline fixtures, never real jobs."""
from __future__ import annotations

import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf
from literature_fulltext_browser import FulltextBrowserFetcher
from literature_materials import MaterialsStore
from test_literature_fulltext import FakeFetcher, article_page, candidate, read_status, run_stage, status_map, write_candidates
from test_literature_fulltext_reuse import NEW, OLD, real_pdf, snapshot
from test_literature_materials import csv_blob, docx_blob, descriptor


def write_marker(job, config):
    (job / "run_config.json").write_text(json.dumps(config), encoding="utf-8")
    candidates = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
    (job / "candidates.csv").write_text("candidate_id\n" + "\n".join(r["candidate_id"] for r in candidates["records"]), encoding="utf-8")
    (job / "dedupe").mkdir(exist_ok=True)
    groups = [{"canonical_id": r["candidate_id"], "records": [r]} for r in candidates["records"]]
    (job / "dedupe/dedupe.json").write_text(json.dumps({"groups": groups}), encoding="utf-8")
    (job / "dedupe/dedupe.csv").write_text("canonical_id\n" + "\n".join(r["candidate_id"] for r in candidates["records"]), encoding="utf-8")
    fields = {"configSnapshotSha256": "run_config.json", "candidateSnapshotSha256": "candidates.json",
              "candidateCsvSnapshotSha256": "candidates.csv", "dedupeSnapshotSha256": "dedupe/dedupe.json",
              "dedupeCsvSnapshotSha256": "dedupe/dedupe.csv"}
    hashes = {key: hashlib.sha256((job / name).read_bytes()).hexdigest() for key, name in fields.items()}
    marker = {"version": 1, "kind": "material-replenishment", "parentJobId": OLD,
              "candidateCount": len(candidates["records"]), "createdAt": "2026-10-25T00:00:00Z", **hashes,
              "snapshotSha256": hashlib.sha256(json.dumps(hashes, separators=(",", ":")).encode()).hexdigest()}
    (job / "materials-basis.json").write_text(json.dumps(marker), encoding="utf-8")


class ReplenishFetcher(FakeFetcher):
    def __init__(self, records, *, inspections=None, pdf=None, attachments=None):
        super().__init__(pdf=pdf)
        self.records = {r["candidate_id"]: r for r in records}
        self.inspections = inspections or {}
        self.attachments = attachments or {}
        self.material_calls = []
        self.completed = 0

    def inspect_materials(self, record, opts):
        self.calls.append(("inspect_materials", record["paper_id"]))
        return copy.deepcopy(self.inspections.get(record["paper_id"]) or {
            "status": "ok", "material_discovery": {"status": "none_declared", "links": []}})

    def fetch_pdf(self, url, out_path, opts):
        self.pdf_results.setdefault(url, {"status": "saved", "bytes": real_pdf(opts["record"]["title"])})
        return super().fetch_pdf(url, out_path, opts)

    def fetch_page(self, url, opts):
        if opts.get("cached_main"):
            raise AssertionError("An existing body must not be fetched or saved again")
        self.calls.append(("fetch_page", url))
        result = article_page(opts["record"]["title"])
        result["material_discovery"] = {"status": "none_declared", "links": []}
        return result

    def fetch_material(self, material, record, opts):
        self.material_calls.append((record["paper_id"], material["filename"]))
        result = self.attachments.get(material["filename"], {"status": "file", "bytes": csv_blob()})
        return copy.deepcopy(result)

    def complete_material(self):
        return {"closed": True}

    def complete_paper(self):
        self.completed += 1


class ReplenishmentTests(unittest.TestCase):
    def fixture(self, root, *, count=1, html_count=1, checked="checked", pdf_count=0):
        job = Path(root) / NEW
        job.mkdir()
        records = [candidate("PMID-%03d" % (i + 1), title="Heat stress in broiler chickens study number %d" % i,
            source_key="pubmed", doi="10.1234/study.%d" % i, result_url="https://publisher.invalid/article/%d" % i,
            links=[{"url": "https://publisher.invalid/article/%d.pdf" % i, "label": "PDF"}]) for i in range(count)]
        write_candidates(job, records)
        config = {"version": 2, "fulltext": {"maxPapers": 1}}
        write_marker(job, config)
        targets = lf.load_targets(job, config)
        items = []
        for index, target in enumerate(targets):
            item = lf._item_skeleton(target)
            if index < pdf_count:
                path = job / "fulltext/files" / (target["paper_id"] + ".pdf")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(real_pdf(target["title"]))
                item = lf._settle_pdf(item, path, path.relative_to(job).as_posix(), records[index]["fulltext_links"][0]["url"], path.stat().st_size, target)
            elif index < pdf_count + html_count:
                page = article_page(target["title"])
                item = lf._settle_html(item, job, page["text"], target["source_url"], "fulltext", "Synthetic identified body", page["html_evidence"])
            else:
                item.update(status="unavailable", reason="Old unavailable result")
            item["acquisition_skip"] = {"policy": "skip_unavailable", "reason": "access_required"}
            items.append(item)
        lf._write_status(job, items)
        store = MaterialsStore(job, targets)
        for target in targets:
            store.record_discovery(target, {"status": checked, "links": []})
        store.flush()
        return job, config, records, targets, store

    def run_replenish(self, job, config, fetcher, **kwargs):
        with patch.object(lf, "_europe_pmc_pdf_urls", side_effect=AssertionError("No external network")), patch.object(lf, "_pmc_xml_item", side_effect=AssertionError("Do not redownload a saved body")):
            return run_stage(job, config, fetcher=fetcher, resume=True, replenish_materials=True, **kwargs)

    def test_original_ten_snapshot_retries_old_gaps_and_upgrades_three_html_without_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=10, html_count=3)
            before = snapshot(job)
            fetcher = ReplenishFetcher(records)
            code, events = self.run_replenish(job, config, fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(read_status(job)["counts"]["fetched_pdf"], 10)
            self.assertEqual(events[-1]["counts"]["pdf_missing"], 0)
            self.assertEqual(sum(kind == "fetch_pdf" for kind, _ in fetcher.calls), 10)
            for name, blob in before.items():
                if name.replace("\\", "/") not in {"fulltext/status.json", "fulltext/materials.json"}:
                    self.assertEqual((job / name).read_bytes(), blob, name)
            self.assertFalse(any((job / name).exists() for name in ("extraction", "validation", "export")))

    def test_old_abstract_cache_is_retained_while_missing_original_is_retried(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, _ = self.fixture(root, html_count=0)
            target = targets[0]
            item = lf._settle_html(lf._item_skeleton(target), job, "Only an old abstract", target["source_url"], "abstract", "Old abstract", {})
            item["acquisition_skip"] = {"policy": "skip_unavailable", "reason": "access_required"}
            lf._write_status(job, [item])
            old_path = job / item["path"]
            original = old_path.read_bytes()
            fetcher = ReplenishFetcher(records)
            _, events = self.run_replenish(job, config, fetcher)
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")
            self.assertEqual(old_path.read_bytes(), original)

    def test_saved_pdf_and_original_attachments_do_not_download_on_resume(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, html_count=0, pdf_count=1)
            attachment = descriptor("already.csv")
            store.record_discovery(targets[0], {"status": "checked", "links": [attachment]})
            saved = store.save_download(targets[0], attachment, {"bytes": csv_blob()})
            store.flush()
            originals = {p: (job / p).read_bytes() for p in [saved["path"], read_status(job)["items"][0]["path"]]}
            fetcher = ReplenishFetcher(records)
            code, events = self.run_replenish(job, config, fetcher)
            self.assertEqual((code, fetcher.calls, fetcher.material_calls), (0, [], []))
            self.assertEqual(events[-1]["counts"]["pdf_missing"], 0)
            for name, blob in originals.items():
                self.assertEqual((job / name).read_bytes(), blob)

    def test_pdf_already_saved_only_missing_original_format_attachments_are_requested(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, html_count=0, pdf_count=1, checked="unknown")
            old = descriptor("old.csv", label="old supplementary table")
            store.record_discovery(targets[0], {"status": "unknown", "links": [old]})
            store.save_download(targets[0], old, {"bytes": csv_blob()})
            entries = [old, descriptor("new.docx", label="methods"), descriptor("new.pdf", label="figure"), descriptor("new.xlsx", label="dataset")]
            import openpyxl
            book = openpyxl.Workbook(); book.active.append(["temperature", 35]); output = io.BytesIO(); book.save(output)
            inspect = {records[0]["candidate_id"]: {"status": "ok", "material_discovery": {"status": "checked", "links": entries}}}
            attachments = {"new.docx": {"status": "file", "bytes": docx_blob()}, "new.pdf": {"status": "file", "bytes": real_pdf()},
                           "new.xlsx": {"status": "file", "bytes": output.getvalue()}}
            fetcher = ReplenishFetcher(records, inspections=inspect, attachments=attachments)
            self.run_replenish(job, config, fetcher)
            self.assertFalse(any(kind == "fetch_pdf" for kind, _ in fetcher.calls))
            self.assertEqual({name for _, name in fetcher.material_calls}, {"new.docx", "new.pdf", "new.xlsx"})
            fresh = MaterialsStore(job, targets)
            self.assertTrue(all(m["download_status"] == "downloaded" for m in fresh.paper(targets[0])["materials"]))
            second = ReplenishFetcher(records, inspections=inspect, attachments=attachments)
            self.run_replenish(job, config, second)
            self.assertEqual((second.calls, second.material_calls), ([], []))

    def test_checked_html_is_still_missing_pdf_and_stays_so_if_no_pdf_is_available(self):
        for check in ("checked", "unknown"):
            with self.subTest(check=check), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = self.fixture(root, checked=check)
                url = records[0]["fulltext_links"][0]["url"]
                original = (job / read_status(job)["items"][0]["path"]).read_bytes()
                fetcher = ReplenishFetcher(records, pdf={url: {"status": "not_found"}})
                code, events = self.run_replenish(job, config, fetcher)
                self.assertEqual(code, 0)
                self.assertIn(("fetch_pdf", url), fetcher.calls)
                self.assertEqual(read_status(job)["items"][0]["status"], "fetched_html")
                self.assertEqual(events[-1]["counts"]["pdf_missing"], 1)
                self.assertEqual(events[-1]["counts"]["material_incomplete"], 1)
                self.assertEqual((job / read_status(job)["items"][0]["path"]).read_bytes(), original)

    def test_login_on_missing_pdf_preserves_html_then_resumes_same_materials(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root)
            url = records[0]["fulltext_links"][0]["url"]
            original_path = read_status(job)["items"][0]["path"]
            original = (job / original_path).read_bytes()
            first = ReplenishFetcher(records, pdf={url: {"status": "attention", "reason": "login", "message": "Synthetic login"}})
            _, events = self.run_replenish(job, config, first)
            self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", "login"))
            self.assertEqual(first.completed, 0)
            self.assertEqual((job / original_path).read_bytes(), original)
            second = ReplenishFetcher(records)
            _, events = self.run_replenish(job, config, second)
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")
            self.assertEqual((job / original_path).read_bytes(), original)

    def test_supplement_verification_pauses_and_preserves_saved_pdf(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, html_count=0, pdf_count=1, checked="unknown")
            entry = descriptor("supplement.csv")
            inspect = {records[0]["candidate_id"]: {"status": "ok", "material_discovery": {"status": "checked", "links": [entry]}}}
            first = ReplenishFetcher(records, inspections=inspect, attachments={"supplement.csv": {
                "status": "attention", "reason": "verification", "message": "Synthetic verification"}})
            _, events = self.run_replenish(job, config, first)
            self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", "verification"))
            second = ReplenishFetcher(records, inspections=inspect)
            _, events = self.run_replenish(job, config, second)
            self.assertEqual(events[-1]["type"], "result")
            self.assertFalse(any(kind == "fetch_pdf" for kind, _ in first.calls + second.calls))
            self.assertEqual(second.material_calls, [(targets[0]["paper_id"], "supplement.csv")])

    def test_corrupted_existing_body_or_attachment_pauses_before_browser(self):
        for corrupt_attachment in (False, True):
            with self.subTest(attachment=corrupt_attachment), tempfile.TemporaryDirectory() as root:
                job, config, records, targets, store = self.fixture(root)
                if corrupt_attachment:
                    saved = store.save_download(targets[0], descriptor(), {"bytes": csv_blob()})
                    store.flush(); path = job / saved["path"]
                else:
                    path = job / read_status(job)["items"][0]["path"]
                path.write_bytes(b"corrupt")
                fetcher = ReplenishFetcher(records)
                _, events = self.run_replenish(job, config, fetcher)
                self.assertEqual((events[-1]["type"], events[-1]["reason"]), ("attention", "local_material_verification"))
                self.assertEqual(fetcher.calls, [])
                self.assertEqual(path.read_bytes(), b"corrupt")

    def test_marker_input_changes_and_unsafe_modes_are_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root)
            (job / "candidates.csv").write_text("changed", encoding="utf-8")
            before = snapshot(job)
            fetcher = ReplenishFetcher(records)
            code, events = self.run_replenish(job, config, fetcher)
            self.assertEqual(code, 1)
            self.assertEqual(events[-1]["type"], "error")
            self.assertEqual(snapshot(job), before)
            self.assertEqual(fetcher.calls, [])
        for extra in ({"only": "PMID-001"}, {"limit": 1}, {"skip_unavailable": True}, {"retry_unavailable": True}, {"restart_cnki": True}):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as root:
                job, config, records, _, _ = self.fixture(root)
                fetcher = ReplenishFetcher(records)
                code, _ = self.run_replenish(job, config, fetcher, **extra)
                self.assertEqual((code, fetcher.calls), (1, []))

    def test_new_pdf_links_observed_by_material_inspection_are_used_without_body_fetch(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root)
            first = records[0]["fulltext_links"][0]["url"]
            found = "https://publisher.invalid/new.pdf"
            inspect = {records[0]["candidate_id"]: {"status": "ok", "material_discovery": {"status": "none_declared", "links": []},
                "main_pdf_links": [{"url": found, "kind": "pdf"}]}}
            fetcher = ReplenishFetcher(records, inspections=inspect, pdf={first: {"status": "not_found"}})
            self.run_replenish(job, config, fetcher)
            self.assertIn(("fetch_pdf", found), fetcher.calls)
            self.assertEqual(read_status(job)["items"][0]["status"], "fetched_pdf")

    def test_browser_inspection_only_returns_identified_main_pdf_links(self):
        record = {"paper_id": "ONE", "source_url": "https://publisher.invalid/article", "title": "The exact broiler heat stress article", "doi": "10.1234/one"}
        browser = FulltextBrowserFetcher.__new__(FulltextBrowserFetcher)
        browser._blocked = None
        browser._deferred_attention = lambda _url: None
        browser.capture_material_discovery = lambda _record: {"status": "unknown", "links": []}
        for match in (True, False):
            response = {"status": "ok", "html_evidence": {"citation_title": record["title"],
                "citation_doi": record["doi"] if match else "10.1234/other", "links": [
                    {"url": "https://publisher.invalid/main.pdf", "kind": "pdf", "text": "PDF"},
                    {"url": "https://publisher.invalid/supplement.pdf", "kind": "pdf", "text": "Supplementary information"}]},
                "material_discovery": {"status": "none_declared", "links": []}}
            options = []
            browser.fetch_page = lambda _url, opts: options.append(opts) or response
            result = browser.inspect_materials(record, {"replenish_materials": True})
            self.assertTrue(all(value.get("materials_only") for value in options))
            self.assertEqual([value["url"] for value in result["main_pdf_links"]], ["https://publisher.invalid/main.pdf"] if match else [])

    def test_browser_inspection_keeps_login_pause_even_with_old_checked_discovery(self):
        browser = FulltextBrowserFetcher.__new__(FulltextBrowserFetcher)
        browser._blocked = None
        browser._deferred_attention = lambda _url: None
        browser.capture_material_discovery = lambda _record: {"status": "checked", "links": []}
        browser.fetch_page = lambda _url, _opts: {"status": "attention", "reason": "login", "message": "Synthetic login"}
        result = browser.inspect_materials({"source_url": "https://publisher.invalid/article"}, {"replenish_materials": True})
        self.assertEqual((result["status"], result["reason"]), ("attention", "login"))


if __name__ == "__main__":
    unittest.main()
