"""Unresolved similar titles remain separate downstream paper targets.

All work is in temporary fixture directories; no database or actual job access.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import literature_extract as extract
from literature_target_groups import expanded_target_groups


def probable_group() -> dict:
    older = {"candidate_id": "GSC-003", "title": "Impact of heat stress on poultry production", "year": 2013,
             "authors": ["Lara", "Rostagno"], "doi": "10.3390/ani3020356", "source_key": "google-scholar"}
    newer = {"candidate_id": "GSC-004", "title": "Impact of heat stress on broiler chicken production", "year": 2024,
             "authors": ["Apalowo", "Ekunseitan", "Fasina"], "doi": "10.1000/distinct-paper", "source_key": "google-scholar"}
    return {"canonical_id": "GSC-003", "title": older["title"], "year": 2013, "doi": older["doi"],
            "candidate_ids": ["GSC-003", "GSC-004"], "records": [older, newer], "needs_review": True,
            "merge_confidence": "probable", "merge_reason": "title_jaccard", "max_score": 0.75}


class TargetGroupTests(unittest.TestCase):
    def test_similar_titles_different_authors_and_years_are_both_kept(self):
        original = probable_group()
        before = copy.deepcopy(original)
        groups = expanded_target_groups([original])
        self.assertEqual([group["canonical_id"] for group in groups], ["GSC-003", "GSC-004"])
        self.assertEqual([group["year"] for group in groups], [2013, 2024])
        self.assertEqual(groups[1]["doi"], original["records"][1]["doi"])
        self.assertEqual(groups[1]["title"], original["records"][1]["title"])
        self.assertEqual(groups[1]["records"][0]["authors"], ["Apalowo", "Ekunseitan", "Fasina"])
        self.assertTrue(all(group["needs_review"] and group["merge_confidence"] == "probable" for group in groups),
                        "expansion never promotes an uncertain group into exact/reusable identity")
        self.assertEqual(original, before)
        groups[1]["records"][0]["authors"].append("fixture mutation")
        self.assertEqual(original, before, "returned targets do not alias the frozen records")

    def test_exact_group_preserves_canonical_structure(self):
        original = probable_group()
        original.update(needs_review=False, merge_confidence="exact")
        groups = expanded_target_groups([original])
        self.assertEqual(groups, [original])
        self.assertIsNot(groups[0], original)
        self.assertEqual(len(groups[0]["records"]), 2)
        self.assertNotIn("target_group_expanded", groups[0])

    def test_either_review_marker_requires_separate_targets(self):
        for patch in [{"needs_review": False}, {"merge_confidence": "exact"}]:
            original = probable_group(); original.update(patch)
            self.assertEqual(len(expanded_target_groups([original])), 2)

    def test_malformed_probable_group_does_not_silently_lose_a_member(self):
        for records in [[], [{}], [{"candidate_id": "GSC-003"}, {"candidate_id": "GSC-003"}],
                        [{"candidate_id": "../invalid"}]]:
            original = probable_group(); original["records"] = records
            with self.assertRaises(ValueError):
                expanded_target_groups([original])


class ExtractScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="literature-probable-targets-")
        self.addCleanup(self.tmp.cleanup)
        self.job = Path(self.tmp.name)
        (self.job / "dedupe").mkdir()
        (self.job / "fulltext" / "files").mkdir(parents=True)
        self.group = probable_group()
        (self.job / "dedupe" / "dedupe.json").write_text(json.dumps({"groups": [self.group]}), encoding="utf-8")
        (self.job / "confirmations.json").write_text(json.dumps({"records": [{"kind": "fieldDefinitions", "at": "fixture",
            "fields": [{"key": "value", "label": "Reported value", "meaning": "Measured outcome", "unit": "original unit"}]}]}), encoding="utf-8")
        self.dedupe_bytes = (self.job / "dedupe" / "dedupe.json").read_bytes()

    def item(self, record, state="fetched_html"):
        paper_id = record["candidate_id"]
        intro = "Heat stress affects broiler health and production across different farming environments. " * 12
        methods = "Researchers recorded the original environmental conditions and measured performance outcomes. " * 12
        text = "Introduction\n" + intro + "\nMethods\n" + methods
        relative = "fulltext/files/" + paper_id + ".txt"
        (self.job / relative).write_text(text, encoding="utf-8")
        return {"paper_id": paper_id, "title": record["title"], "doi": record["doi"], "status": state, "kind": "html",
                "path": relative, "source_url": "https://example.org/article", "evidence_version": "fulltext-evidence-v1",
                "content_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "html_evidence": {"origin": "dom_article_region", "container_verified": True,
                                  "citation_title": record["title"], "citation_doi": record["doi"],
                                  "sections": [{"heading": "Introduction", "text": intro}, {"heading": "Methods", "text": methods}]}}

    def write_status(self, items):
        file = self.job / "fulltext" / "status.json"
        file.write_text(json.dumps({"items": items}), encoding="utf-8")
        return file.read_bytes()

    def test_old_canonical_only_fulltext_list_stops_before_writing_bundles(self):
        before = self.write_status([self.item(self.group["records"][0])])
        with self.assertRaisesRegex(extract.StageError, "有待核对的相似文献未进入全文清单，请返回全文获取继续处理；原结果保留.*GSC-004"):
            extract.build_bundles({}, self.job)
        self.assertFalse((self.job / "extraction").exists())
        self.assertEqual((self.job / "fulltext" / "status.json").read_bytes(), before)
        self.assertEqual((self.job / "dedupe" / "dedupe.json").read_bytes(), self.dedupe_bytes)

    def test_separate_ready_papers_generate_separate_bundles(self):
        self.write_status([self.item(record) for record in self.group["records"]])
        report = extract.build_bundles({}, self.job)
        self.assertEqual(report["created"], ["GSC-003", "GSC-004"])
        for record in self.group["records"]:
            bundle = json.loads((self.job / "extraction" / "inputs" / (record["candidate_id"] + ".json")).read_text("utf-8"))
            self.assertEqual(bundle["title"], record["title"])
            self.assertEqual(bundle["doi"], record["doi"])
        self.assertEqual((self.job / "dedupe" / "dedupe.json").read_bytes(), self.dedupe_bytes)

    def test_pending_second_paper_is_explicitly_reported_not_forgotten(self):
        self.write_status([self.item(self.group["records"][0]), self.item(self.group["records"][1], "pending")])
        report = extract.build_bundles({}, self.job)
        self.assertEqual(report["created"], ["GSC-003"])
        self.assertEqual(report["skipped"][0]["paper_id"], "GSC-004")
        self.assertIn("pending", report["skipped"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
