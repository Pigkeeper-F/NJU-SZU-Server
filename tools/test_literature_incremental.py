"""Offline regression cases for lossless imports, report identity and indexes."""
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_dedupe as dedupe
import literature_import as importer
import literature_fulltext_reuse as reuse


def row(n, **values):
    return {"candidate_id": f"R{n}", "title": f"Distinct animal report number {n}",
            "doi": f"10.1234/report{n}", "source_key": "scopus", "authors": "A Smith", "year": 2024, **values}


class ImportAccumulationTests(unittest.TestCase):
    def test_ris_preserves_long_abstract_continuations_keywords_and_accession(self):
        abstract = "完整摘要内容 " * 1800
        parsed = importer.parse_ris(f"TY  - JOUR\nTI  - Heat response\nAB  - {abstract}\n continued conclusion\nKW  - heat stress\nKW  - growth\nAN  - WOS:123456\nER  -\n", "web-of-science")
        self.assertIn("continued conclusion", parsed[0]["abstract"])
        self.assertGreater(len(parsed[0]["abstract"]), 5000)
        self.assertEqual(parsed[0]["keywords"], ["heat stress", "growth"])
        self.assertEqual(parsed[0]["source_identifiers"]["web-of-science"], "wos:123456")
        with tempfile.TemporaryDirectory() as temp:
            importer.append_imported(Path(temp), parsed, "web-of-science")
            saved = json.loads((Path(temp) / "candidates.json").read_text(encoding="utf-8"))["records"][0]
            self.assertEqual(saved["abstract"], parsed[0]["abstract"])
            with (Path(temp) / "candidates.csv").open(encoding="utf-8-sig", newline="") as stream:
                self.assertEqual(next(csv.DictReader(stream))["abstract"], parsed[0]["abstract"])

    def test_native_csv_and_tsv_headings_and_one_line_bibtex(self):
        parsed = importer.parse_csv('Article Title\tPublication Year\tUT (Unique WOS ID)\tAuthor Keywords\tKeywords Plus\tAbstract\nHeat effects\t2022\tWOS:001\theat; growth\tANIMALS\tComplete abstract\n', "web-of-science")
        self.assertEqual(parsed[0]["ut"], "WOS:001")
        self.assertEqual(parsed[0]["year"], 2022)
        self.assertEqual(parsed[0]["index_keywords"], ["ANIMALS"])
        parsed = importer.parse_bibtex('@article{a,title={Heat {and cold} effects},year=2024,abstract={First paragraph. {Nested value.}},keywords={growth; stress},eid={2-s2.0-123}}', "scopus")
        self.assertEqual(parsed[0]["title"], "Heat {and cold} effects")
        self.assertIn("Nested value", parsed[0]["abstract"])
        self.assertEqual(parsed[0]["source_identifiers"]["scopus"], "2-s2.0-123")

    def test_batches_accumulate_and_repeat_keeps_ids_and_rule_decisions(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            importer.append_imported(job, [row(1)], "scopus", "first query", batch_metadata={"line": "production"})
            path = job / "candidates.json"
            doc = json.loads(path.read_text(encoding="utf-8"))
            first_id = doc["records"][0]["candidate_id"]
            doc["records"][0]["screening_status"] = "excluded"
            doc["records"][0]["screening_decisions"] = {"production@v1": {"decision": "excluded"}}
            path.write_text(json.dumps(doc), encoding="utf-8")
            importer.append_imported(job, [row(1), row(2)], "scopus", "second query", batch_metadata={"line": "emission"})
            again = importer.append_imported(job, [row(1), row(2)], "scopus", "second query", batch_metadata={"line": "emission"})
            doc = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(again["added"], 0)
            self.assertEqual(len(doc["records"]), 2)
            self.assertEqual(len(doc["batches"]), 2)
            saved = doc["records"][0]
            self.assertEqual(saved["candidate_id"], first_id)
            self.assertEqual(saved["screening_status"], "excluded")
            self.assertEqual(saved["screening_decisions"], {"production@v1": {"decision": "excluded"}})
            self.assertEqual(len(saved["import_batch_ids"]), 2)

    def test_same_title_conflicting_identifiers_are_not_lost_during_import(self):
        with tempfile.TemporaryDirectory() as temp:
            importer.append_imported(Path(temp), [row(1, title="Same title"), row(2, title="Same title")], "scopus")
            data = json.loads((Path(temp) / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(len(data["records"]), 2)
            self.assertEqual(len({r["candidate_id"] for r in data["records"]}), 2)

    def test_empty_or_concurrent_import_never_replaces_existing_records(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            importer.append_imported(job, [row(1)], "scopus")
            before = (job / "candidates.json").read_bytes()
            with self.assertRaises(ValueError):
                importer.append_imported(job, [], "scopus")
            (job / ".literature-import.lock").write_text("another import", encoding="utf-8")
            with self.assertRaises(ValueError):
                importer.append_imported(job, [row(2)], "scopus")
            self.assertEqual((job / "candidates.json").read_bytes(), before)


class IndexedDedupeTests(unittest.TestCase):
    def test_conflicting_report_doi_or_native_id_never_auto_merges(self):
        groups = dedupe.group_records([row(1, title="Identical paper title"), row(2, title="Identical paper title")])
        self.assertEqual(len(groups), 2)
        groups = dedupe.group_records([row(1, doi="", eid="2-s2.0-1"), row(1, doi="", eid="2-s2.0-2", candidate_id="R2")])
        self.assertEqual(len(groups), 2)

    def test_unknown_identity_cannot_bridge_conflicting_known_dois_into_exact_group(self):
        records = [row(1, title="Identical paper title"), row(2, title="Identical paper title", doi=""), row(3, title="Identical paper title")]
        group = dedupe.group_records(records)[0]
        self.assertTrue(group["needs_review"])
        self.assertTrue(all(r.get("screening_status") != "auto_excluded_duplicate" for r in group["records"]))

    def test_cached_prefix_avoids_old_pair_checks_and_keeps_canonical_id(self):
        records = [row(1, batch_index=1), row(2, batch_index=2)]
        first = {}
        dedupe.group_records(records, cache_out=first)
        second = {}
        with patch.object(dedupe, "_match", side_effect=AssertionError("unchanged records must reuse index")):
            dedupe.group_records(records, cache=first, cache_out=second)
        self.assertEqual(second["statistics"]["new_pair_checks"], 0)
        records.append(row(1, candidate_id="NEW-IMPORT", batch_index=0))
        third = {}
        groups = dedupe.group_records(records, cache=second, cache_out=third)
        self.assertEqual(next(g for g in groups if len(g["records"]) == 2)["canonical_id"], "R1")
        self.assertEqual(third["statistics"]["reused_prefix_records"], 2)
        self.assertEqual(third["statistics"]["new_pair_checks"], 1)

    def test_record_edit_invalidates_old_index(self):
        records, cache = [row(1), row(2)], {}
        dedupe.group_records(records, cache_out=cache)
        records[1]["doi"] = records[0]["doi"]
        updated = {}
        self.assertEqual(len(dedupe.group_records(records, cache=cache, cache_out=updated)), 1)
        self.assertEqual(updated["statistics"]["reused_prefix_records"], 0)

    def test_thousand_distinct_known_dois_do_not_trigger_all_pairs(self):
        cache = {}
        groups = dedupe.group_records([row(n) for n in range(1000)], cache_out=cache)
        self.assertEqual(len(groups), 1000)
        self.assertEqual(cache["statistics"]["new_pair_checks"], 0)


if __name__ == "__main__":
    unittest.main()
