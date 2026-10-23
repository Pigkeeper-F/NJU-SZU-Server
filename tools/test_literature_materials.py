"""Original-format material and reader tests, using only synthetic local files."""
from __future__ import annotations

import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import literature_extract as extract
import literature_fulltext as fulltext
import literature_materials as materials
from test_literature_extract import make_pdf, write_job as extraction_job
from test_literature_fulltext_reuse import OLD, NEW, make_job, row, save_pdf, snapshot


def descriptor(filename="supplement.csv", **extra):
    return {"role": "supplement", "label": "Supplementary Table S1", "filename": filename,
            "url": "https://publisher.invalid/" + filename + "?token=secret123", **extra}


def csv_blob():
    return b"Temperature,Response\n0,12.5\n35,0\n"


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, blob in entries.items():
            archive.writestr(name, blob)
    return output.getvalue()


def docx_blob():
    return zipped({"word/document.xml": b'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Supplementary methods</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Temperature</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>35</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'''})


class StoreTests(unittest.TestCase):
    def make_store(self, root, job_id=NEW, record=None):
        record = record or row("CURRENT")
        job = make_job(root, job_id, [record])
        target = fulltext._target_from_candidate(record)
        return job, target, materials.MaterialsStore(job, [target])

    def test_old_main_bootstrap_keeps_status_and_original_files_with_uninspected_supplements(self):
        with tempfile.TemporaryDirectory() as root:
            record = row("CURRENT")
            job = make_job(root, NEW, [record])
            target, _ = save_pdf(job, record)
            original = snapshot(job)
            store = materials.MaterialsStore(job, [target])
            self.assertEqual(snapshot(job), original, "constructor only prepares an in-memory bootstrap")
            paper = store.paper(target)
            self.assertEqual(paper["main_pdf_status"], "downloaded")
            self.assertEqual(paper["supplement_check"]["status"], "uninspected")
            self.assertEqual(paper["materials"][0]["read_status"], "not_checked")
            self.assertFalse(store.paper_ready(target))
            store.flush()
            for name, blob in original.items():
                self.assertEqual((job / name).read_bytes(), blob)

    def test_discovery_download_and_reading_are_separate_and_no_raw_url_is_persisted(self):
        with tempfile.TemporaryDirectory() as root:
            job, target, store = self.make_store(root)
            entries = store.record_discovery(target, {"status": "checked", "supplements": [descriptor()]})
            self.assertEqual(len(store.pending_supplements(target)), 1)
            saved = store.save_download(target, entries[0], {"bytes": csv_blob()})
            self.assertEqual(saved["download_status"], "downloaded")
            self.assertEqual(saved["read_status"], "readable")
            self.assertEqual((job / saved["path"]).read_bytes(), csv_blob())
            self.assertEqual(saved["sha256"], hashlib.sha256(csv_blob()).hexdigest())
            self.assertEqual(store.pending_supplements(target), [])
            text = store.path.read_text(encoding="utf-8")
            self.assertNotIn("secret123", text)
            self.assertNotIn("https://", text)
            read = materials.read_material(job, saved)
            self.assertIn("0", read["text"])
            self.assertEqual(read["locations"][2]["position"], {"kind": "cell", "row": 2, "column": 1, "encoding": "utf-8-sig"})

    def test_original_unknown_formats_are_saved_but_not_claimed_readable(self):
        for extension in ("xls", "doc", "caj", "unknown", "png"):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as root:
                job, target, store = self.make_store(root)
                blob = b"Original bytes of an unsupported format"
                saved = store.save_download(target, descriptor("original." + extension), {"bytes": blob})
                self.assertEqual(saved["download_status"], "downloaded")
                self.assertEqual(saved["read_status"], "unsupported")
                self.assertEqual((job / saved["path"]).read_bytes(), blob)

    def test_actual_download_filename_overrides_generic_endpoint_format(self):
        with tempfile.TemporaryDirectory() as root:
            _, target, store = self.make_store(root)
            saved = store.save_download(target, descriptor("download.bin", format="bin"),
                                        {"bytes": csv_blob(), "suggested_filename": "actual-table.csv"})
            self.assertEqual(saved["filename"], "actual-table.csv")
            self.assertEqual(saved["format"], "csv")
            self.assertEqual(saved["read_status"], "readable")

    def test_new_bytes_never_overwrite_the_old_original_material(self):
        with tempfile.TemporaryDirectory() as root:
            job, target, store = self.make_store(root)
            saved = store.save_download(target, descriptor(), {"bytes": csv_blob()})
            original_path = saved["path"]
            updated = store.save_download(target, descriptor(), {"bytes": b"new,version\n1,2\n"})
            self.assertNotEqual(original_path, updated["path"])
            self.assertEqual((job / original_path).read_bytes(), csv_blob())
            self.assertEqual((job / updated["path"]).read_bytes(), b"new,version\n1,2\n")

    def test_later_unknown_page_does_not_erase_completed_supplement_inspection(self):
        for prior in ("checked", "none_declared"):
            with self.subTest(prior=prior), tempfile.TemporaryDirectory() as root:
                _, target, store = self.make_store(root)
                store.record_discovery(target, {"status": prior, "reason": "Verified article page"})
                store.record_discovery(target, {"status": "unknown", "reason": "PDF viewer has no links"})
                self.assertEqual(store.paper(target)["supplement_check"]["status"], prior)

    def test_problem_state_and_message_are_sanitized_without_claiming_download_success(self):
        with tempfile.TemporaryDirectory() as root:
            _, target, store = self.make_store(root)
            saved = store.mark_problem(target, descriptor(), "needs_attention", "Login required at https://publisher.invalid/?token=secret123")
            self.assertEqual(saved["download_status"], "needs_attention")
            self.assertEqual(saved["read_status"], "not_checked")
            self.assertIn("Login", saved["download_reason"])
            self.assertNotIn("secret123", store.path.read_text(encoding="utf-8"))

    def test_ready_requires_main_file_checked_supplements_and_exact_valid_files(self):
        with tempfile.TemporaryDirectory() as root:
            record = row("CURRENT")
            job = make_job(root, NEW, [record])
            target, _ = save_pdf(job, record)
            store = materials.MaterialsStore(job, [target])
            store.record_discovery(target, {"status": "checked", "supplements": [descriptor()]})
            self.assertFalse(store.paper_ready(target))
            saved = store.save_download(target, descriptor(), {"bytes": csv_blob()})
            self.assertTrue(store.paper_ready(target))
            (job / saved["path"]).unlink()
            self.assertFalse(store.paper_ready(target))

    def test_completeness_requires_inspection_and_all_supplements(self):
        with tempfile.TemporaryDirectory() as root:
            job, target, store = self.make_store(root)
            self.assertEqual(store.completeness(target)["status"], "unverified")
            store.record_discovery(target, {"status": "none_declared", "links": []})
            self.assertEqual(store.completeness(target)["status"], "complete")
            store.record_discovery(target, {"status": "checked", "links": [descriptor()]})
            report = store.completeness(target)
            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["pending"], 1)
            self.assertEqual(report["missing"][0]["download_status"], "pending")

    def test_material_id_dots_cannot_change_the_storage_directory(self):
        with tempfile.TemporaryDirectory() as root:
            job, target, store = self.make_store(root)
            saved = store.save_download(target, descriptor(material_id=".."), {"bytes": csv_blob()})
            self.assertTrue(saved["material_id"].startswith("material-"))
            self.assertNotIn("..", Path(saved["path"]).parts)
            self.assertTrue((job / saved["path"]).is_file())

    def test_downloaded_sha_mismatch_blocks_reuse_instead_of_redownloading(self):
        with tempfile.TemporaryDirectory() as root:
            job, target, store = self.make_store(root)
            saved = store.save_download(target, descriptor(), {"bytes": csv_blob()})
            (job / saved["path"]).write_bytes(b"tampered")
            with self.assertRaises(materials.MaterialsError):
                store.find_reusable(target, descriptor())

    def test_cross_task_strict_same_paper_reuses_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as root:
            old, old_target, old_store = self.make_store(root, OLD, row("ORIGINAL"))
            old_store.save_download(old_target, descriptor(), {"bytes": csv_blob()})
            original = snapshot(old)
            new, target, store = self.make_store(root)
            saved = store.find_reusable(target, descriptor())
            self.assertIsNotNone(saved)
            self.assertEqual(saved["download_status"], "downloaded")
            self.assertEqual(saved["reused_from"]["job_id"], OLD)
            self.assertEqual(saved["reused_from"]["paper_id"], "ORIGINAL")
            self.assertEqual((new / saved["path"]).read_bytes(), csv_blob())
            self.assertEqual(snapshot(old), original)

    def test_doi_conflict_and_running_or_deleted_source_cannot_supply_material(self):
        for variation in ("doi", "running", "deleted", "probable"):
            with self.subTest(variation=variation), tempfile.TemporaryDirectory() as root:
                old, old_target, old_store = self.make_store(root, OLD, row("ORIGINAL"))
                old_store.save_download(old_target, descriptor(), {"bytes": csv_blob()})
                new_record = row("CURRENT", doi="10.1234/different") if variation == "doi" else row("CURRENT")
                _, target, store = self.make_store(root, record=new_record)
                if variation == "probable":
                    target["reuse_disabled"] = True
                if variation in {"running", "deleted"}:
                    meta = {"id": OLD, "status": "running" if variation == "running" else "completed", "deletedAt": "2026-10-20" if variation == "deleted" else None}
                    (old / "job.json").write_text(json.dumps(meta), encoding="utf-8")
                self.assertIsNone(store.find_reusable(target, descriptor()))


class ReaderTests(unittest.TestCase):
    def read(self, filename, blob, **limits):
        with tempfile.TemporaryDirectory() as root:
            record = fulltext._target_from_candidate(row("CURRENT"))
            store = materials.MaterialsStore(Path(root), [record])
            saved = store.save_download(record, descriptor(filename), {"bytes": blob})
            return materials.read_material(Path(root), saved, **limits)

    def test_xlsx_reads_zero_formula_and_sheet_cell_positions(self):
        from openpyxl import Workbook
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Trial data"
        sheet.append(["Temperature", "Response"])
        sheet.append([0, 12.5])
        sheet.append([35, "=B2*2"])
        stream = io.BytesIO()
        workbook.save(stream)
        workbook.close()
        read = self.read("S1.xlsx", stream.getvalue())
        self.assertEqual(read["read_status"], "partial", "formula values were not recalculated")
        self.assertIn("0", read["text"])
        self.assertIn("=B2*2", read["text"])
        self.assertTrue(any(location["position"].get("sheet") == "Trial data" and location["position"].get("cell") == "A2" for location in read["locations"]))

    def test_docx_reads_paragraph_and_table_cells_without_executing_office(self):
        read = self.read("methods.docx", docx_blob())
        self.assertEqual(read["read_status"], "readable")
        self.assertIn("Supplementary methods", read["text"])
        self.assertIn("35", read["text"])
        self.assertTrue(any(location["position"].get("kind") == "paragraph" for location in read["locations"]))
        self.assertTrue(any(location["position"].get("kind") == "table_cell" and location["position"].get("column") == 2 for location in read["locations"]))

    def test_pdf_reads_text_with_page_positions(self):
        read = self.read("S1.pdf", make_pdf("Temperature 35 Response 12.5"))
        self.assertEqual(read["read_status"], "readable")
        self.assertIn("12.5", read["text"])
        self.assertEqual(read["locations"][0]["position"], {"kind": "page", "page": 1})

    def test_blank_scanned_pdf_does_not_claim_readable(self):
        from pypdf import PdfWriter
        stream = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(stream)
        read = self.read("scan.pdf", stream.getvalue())
        self.assertEqual(read["read_status"], "unreadable")
        self.assertIn("OCR", read["read_reason"])

    def test_csv_tsv_json_xml_html_have_positioned_readable_content(self):
        variants = [("table.csv", csv_blob(), "cell"), ("table.tsv", b"x\ty\n0\t12.5\n", "cell"),
            ("data.json", b'{"values":[0,12.5]}', "json_value"), ("data.xml", b"<data><temperature>35</temperature></data>", "xml_element"),
            ("page.html", b"<html><script>do not execute</script><p>Temperature 35</p></html>", "line")]
        for name, blob, position in variants:
            with self.subTest(name=name):
                read = self.read(name, blob)
                self.assertEqual(read["read_status"], "readable")
                self.assertEqual(read["locations"][0]["position"]["kind"], position)
                self.assertNotIn("do not execute", read["text"])

    def test_reader_limits_are_partial_and_preserve_location_offsets(self):
        read = self.read("long.txt", b"First line of scientific data\nSecond line\n", max_chars=10)
        self.assertEqual(read["read_status"], "partial")
        self.assertEqual(len(read["text"]), 10)
        self.assertEqual(read["locations"][0]["end"], 10)
        rows = self.read("many.csv", csv_blob(), max_rows=1)
        self.assertEqual(rows["read_status"], "partial")
        self.assertIn("1", rows["read_reason"])

    def test_zip_is_kept_original_and_safe_members_read_in_memory(self):
        blob = zipped({"../escape.csv": csv_blob(), "data/table.csv": csv_blob(), "unknown.xls": b"original unsupported"})
        read = self.read("all.zip", blob)
        self.assertEqual(read["read_status"], "partial")
        self.assertIn("12.5", read["text"])
        self.assertTrue(any(location["position"].get("archive_member") == "data/table.csv" for location in read["locations"]))
        self.assertIn("不安全", read["read_reason"])

    def test_zip_member_limits_are_visible_and_nested_archives_are_not_expanded(self):
        blob = zipped({"first.csv": csv_blob(), "second.csv": csv_blob()})
        with patch.object(materials, "MAX_ZIP_MEMBERS", 1):
            read = self.read("many.zip", blob)
        self.assertEqual(read["read_status"], "partial")
        self.assertIn("1", read["read_reason"])
        read = self.read("nested.zip", zipped({"inner.zip": zipped({"data.csv": csv_blob()})}))
        self.assertEqual(read["read_status"], "partial")
        self.assertIn("嵌套", read["read_reason"])

    def test_xml_external_entity_and_tampered_paths_are_never_read(self):
        read = self.read("unsafe.xml", b'<!DOCTYPE doc [<!ENTITY ext SYSTEM "file:///never-read">]><doc>&ext;</doc>')
        self.assertEqual(read["read_status"], "unreadable")
        with tempfile.TemporaryDirectory() as root:
            result = materials.read_material(Path(root), {"download_status": "downloaded", "path": "../outside.csv", "filename": "outside.csv", "format": "csv", "size": 0, "sha256": "a" * 64})
            self.assertEqual(result["read_status"], "unreadable")


class ExtractionTests(unittest.TestCase):
    def test_legacy_bundle_explicitly_marks_supplements_uninspected(self):
        with tempfile.TemporaryDirectory() as root:
            job = extraction_job(Path(root))
            config = json.loads((job / "run_config.json").read_text(encoding="utf-8"))
            extract.build_bundles(config, job)
            bundle = json.loads((job / "extraction/inputs/GSC-001.json").read_text(encoding="utf-8"))
            self.assertEqual(bundle["materials"], [])
            self.assertFalse(bundle["materials_check"]["manifest_present"])
            self.assertEqual(bundle["materials_check"]["supplement_check"]["status"], "uninspected")

    def test_supplement_cells_enter_bundle_and_changed_manifest_requires_explicit_rebuild(self):
        with tempfile.TemporaryDirectory() as root:
            job = extraction_job(Path(root))
            record = {"paper_id": "GSC-001", "title": "A", "doi": "10.1/a", "year": 2024, "authors": "Author A"}
            store = materials.MaterialsStore(job, [record])
            store.record_discovery(record, {"status": "checked", "supplements": [descriptor()]})
            store.save_download(record, descriptor(), {"bytes": csv_blob()})
            before_manifest = store.path.read_bytes()
            config = json.loads((job / "run_config.json").read_text(encoding="utf-8"))
            extract.build_bundles(config, job)
            bundle = json.loads((job / "extraction/inputs/GSC-001.json").read_text(encoding="utf-8"))
            supplement = next(entry for entry in bundle["materials"] if entry["role"] == "supplement")
            self.assertIn("12.5", supplement["content"]["text"])
            self.assertEqual(supplement["content"]["locations"][0]["position"]["kind"], "cell")
            self.assertEqual(store.path.read_bytes(), before_manifest, "extract reads the manifest without rewriting it")
            store.record_discovery(record, {"status": "checked", "supplements": [descriptor("second.csv", label="Table S2")]})
            with self.assertRaisesRegex(extract.StageError, "材料清单已更新"):
                extract.build_bundles(config, job)
            extract.build_bundles(config, job, force=True)


if __name__ == "__main__":
    unittest.main()
