"""Explicit researcher absence rule; synthetic local PDFs, no browser/network."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest

import literature_fulltext as fulltext
from literature_material_collection import MaterialCollection
from literature_materials import MaterialsStore
from test_literature_fulltext_reuse import NEW, TITLE, make_job, real_pdf, row, save_pdf


class SupplementAbsencePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.candidate = row("POLICY-001")
        self.job = make_job(self.tmp.name, NEW, [self.candidate])
        self.record, self.item = save_pdf(self.job, self.candidate,
            blob=real_pdf(TITLE + ". Methods Results Discussion References. " + "Dietary supplemental zinc and supplementary dose of lycopene improved broiler growth. " * 30), proof=True)
        self.store = MaterialsStore(self.job, [self.record])

    def tearDown(self):
        self.tmp.cleanup()

    def enable(self):
        self.store.document["supplement_policy"] = {"absence_rule": "no_mention_in_verified_fulltext",
            "instruction": "正文没提就是没有，仅本任务启用"}
        self.store.flush()

    def test_opt_in_only_no_nutritional_false_positive_and_no_browser_needed(self):
        original = (self.job / self.item["path"]).read_bytes()
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record))
        self.enable()
        class NoBrowser:
            def ensure_ready(self):
                raise AssertionError("Negative readable body rule must not open a publisher page")
        collector = MaterialCollection(self.store, self.record, NoBrowser(), NoBrowser().ensure_ready)
        self.assertIsNone(collector.inspect_existing({}))
        paper = self.store.paper(self.record)
        self.assertEqual(paper["supplement_check"]["status"], "none_found")
        self.assertNotEqual(paper["supplement_check"]["status"], "none_declared")
        self.assertEqual(paper["supplement_check"]["evidence"]["mentions"], 0)
        self.assertEqual(self.store.completeness(self.record)["status"], "complete")
        self.assertEqual((self.job / self.item["path"]).read_bytes(), original)

    def test_specific_attachment_mentions_keep_unknown_or_missing(self):
        for phrase in ("Supplementary material", "Supplemental data", "Supporting information", "Table S1", "Figure S2",
                       "supple-\nmentary material", "online appendix", "electronic appendices", "TableS1", "FigureS1"):
            with self.subTest(phrase=phrase):
                record, item = save_pdf(self.job, self.candidate,
                    blob=real_pdf(TITLE + ". " + phrase + ". Methods and Results. " + "Actual body data. " * 70), proof=True)
                store = MaterialsStore(self.job, [record])
                store.document["supplement_policy"] = {"absence_rule": "no_mention_in_verified_fulltext"}
                self.assertFalse(store.apply_fulltext_absence_rule(record))
                self.assertNotEqual(store.paper(record)["supplement_check"]["status"], "none_found")

    def test_partial_missing_text_auth_or_current_real_link_never_becomes_absence(self):
        self.enable()
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record, access_attention=True))
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record, observed={"status": "checked", "links": [
            {"url": "https://publisher.invalid/supplement.xlsx", "label": "Supplementary data"}]}))
        status = json.loads((self.job / "fulltext/status.json").read_text(encoding="utf-8"))
        status["items"][0]["completeness"]["status"] = "partial"
        (self.job / "fulltext/status.json").write_text(json.dumps(status), encoding="utf-8")
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record))
        from pypdf import PdfWriter
        writer, output = PdfWriter(), io.BytesIO()
        writer.add_blank_page(width=100, height=100)
        writer.add_metadata({"/Padding": "x" * 60000})
        writer.write(output)
        record, _ = save_pdf(self.job, self.candidate, blob=output.getvalue(), proof=True)
        unreadable = MaterialsStore(self.job, [record])
        self.assertFalse(unreadable.apply_fulltext_absence_rule(record))

    def test_old_entries_need_explicit_ids_and_are_kept_out_of_counts_not_deleted(self):
        self.enable()
        self.store.record_discovery(self.record, {"status": "unknown", "links": [
            {"label": "Old navigation", "filename": "old-page", "url": "https://publisher.invalid/old-page"},
            {"label": "Other article", "filename": "other-article", "url": "https://publisher.invalid/other-article"}]})
        materials = [material for material in self.store.paper(self.record)["materials"] if material["role"] == "supplement"]
        ids = [material["material_id"] for material in materials]
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record))
        self.store.document["supplement_policy"]["historical_exclusions"] = {self.record["paper_id"]: {
            "material_ids": ids, "reason": "一条已确证导航，一条仅按研究者本轮规则排除；均保留历史，不声称全部为导航"}}
        self.assertTrue(self.store.apply_fulltext_absence_rule(self.record))
        self.assertEqual(len(self.store.paper(self.record)["materials"]), 3)
        self.assertTrue(all(material["excluded_from_supplement_counts"] for material in materials))
        self.assertTrue(all("不声称全部为导航" in material["exclusion_reason"] for material in materials))
        self.assertEqual(self.store.pending_supplements(self.record), [])
        self.assertEqual(self.store.completeness(self.record)["pending"], 0)
        self.assertTrue(self.store.paper_ready(self.record))
        self.store.record_discovery(self.record, {"status": "checked", "links": [
            {"material_id": ids[0], "label": "Old navigation", "filename": "real.xlsx", "url": "https://publisher.invalid/real.xlsx"}]})
        self.assertFalse(materials[0]["excluded_from_supplement_counts"])
        self.assertEqual(self.store.completeness(self.record)["pending"], 1)
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record))

    def test_existing_downloaded_supplement_is_never_excluded(self):
        self.enable()
        descriptor = {"label": "Actual data", "filename": "data.csv", "url": "https://publisher.invalid/data.csv"}
        material = self.store.save_download(self.record, descriptor, {"bytes": b"value\n12.5\n"})
        self.store.document["supplement_policy"]["historical_exclusions"] = {self.record["paper_id"]: {"material_ids": [material["material_id"]]}}
        before = copy.deepcopy(material)
        self.assertFalse(self.store.apply_fulltext_absence_rule(self.record))
        self.assertEqual(material, before)


if __name__ == "__main__":
    unittest.main()
