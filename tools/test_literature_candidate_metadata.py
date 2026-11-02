"""Offline metadata fidelity and premature-deduplication regressions."""
from copy import deepcopy
from contextlib import redirect_stdout
from pathlib import Path
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literature_search import filtered_source_results, normalize_candidates, run, _record_keys, _page_fingerprint
from literature_scholar_discovery import _merge_results


class CandidateMetadataTests(unittest.TestCase):
    def normalize(self, rows):
        return normalize_candidates(rows, "confirmed expression", "saved-time", source_key="scopus")

    def test_same_title_with_conflicting_doi_or_source_id_survives_each_early_stage(self):
        rows = [
            {"title": "Identical title", "doi": "10.1000/a", "eid": "2-s2.0-1"},
            {"title": "Identical title", "doi": "10.1000/b", "eid": "2-s2.0-2"},
            {"title": "Identical title", "doi": "10.1000/a", "eid": "2-s2.0-3"},
            {"title": "Identical title"},
        ]
        page = filtered_source_results({"status": "ok", "results": rows}, {"limit": 10},
                                       "scopus", "q", full_page=True)
        self.assertEqual(len(self.normalize(page["results"])), 4)
        self.assertEqual(len(set().union(*(_record_keys(row) for row in page["results"]))), 4)

    def test_only_identical_observation_is_collapsed_without_losing_richer_metadata(self):
        first = {"title": "A report", "doi": "10.1000/a", "snippet": "A search excerpt"}
        richer = {**first, "abstract": "Complete source abstract", "evidence_level": "source_abstract"}
        rows = self.normalize([first, deepcopy(first), richer])
        self.assertEqual(len(rows), 2)
        self.assertEqual([row["candidate_id"] for row in rows], ["SCOPUS-001", "SCOPUS-002"])
        self.assertEqual(rows[1]["abstract"], richer["abstract"])

    def test_full_abstract_keywords_ids_and_provenance_survive_filter_and_normalization(self):
        abstract = "研究摘要原始内容。" * 600
        title, authors = "Long complete title " * 40, "; ".join("Author " + str(i) for i in range(100))
        raw = {"title": title, "authors": authors, "year": 2022, "doi": "https://doi.org/10.1000/ABC",
               "abstract": abstract, "snippet": "This is a search excerpt…", "abstract_source": "database_detail_page",
               "evidence_level": "source_abstract", "author_keywords": "Heat stress;Milk yield",
               "index_keywords": ["Temperature", "Methane"], "keywords": ["Methane"],
               "source_identifiers": {"scopus": "2-s2.0-123", "web-of-science": "WOS:ABC"},
               "eid": "2-s2.0-123", "ut": "WOS:ABC", "accession_number": "AN-123",
               "document_type": "Article", "language": "English", "publication_date": "2022-03-03",
               "source_url": "https://example.org/record", "abstract_url": "https://example.org/abstract",
               "cookies": "private session", "token": "private token", "browser_debug": {"secret": "private"}}
        page = filtered_source_results({"status": "ok", "results": [raw]}, {"limit": 10},
                                       "scopus", "q", full_page=True)
        row = self.normalize(page["results"])[0]
        self.assertEqual(row["abstract"], abstract)
        self.assertEqual(row["title"], title.strip())
        self.assertEqual(row["authors"], authors)
        self.assertEqual(row["snippet"], raw["snippet"])
        self.assertEqual(row["evidence_level"], "source_abstract")
        self.assertEqual(row["abstract_source"], "database_detail_page")
        self.assertEqual(row["author_keywords"], ["Heat stress", "Milk yield"])
        self.assertEqual(row["index_keywords"], ["Temperature", "Methane"])
        self.assertEqual(set(row["keywords"]), {"Heat stress", "Milk yield", "Temperature", "Methane"})
        for field in ("source_identifiers", "eid", "ut", "accession_number", "document_type", "language", "publication_date", "source_url", "abstract_url"):
            self.assertEqual(row[field], raw[field])
        self.assertEqual(row["doi"], "10.1000/abc")
        self.assertFalse({"cookies", "token", "browser_debug"} & row.keys())
        self.assertFalse({"cookies", "token", "browser_debug"} & page["results"][0].keys())

    def test_search_excerpt_is_never_promoted_even_when_wrong_evidence_label_is_supplied(self):
        for label in (None, "source_abstract", "imported_abstract", "verified_abstract", "fulltext_pdf"):
            with self.subTest(label=label):
                snippet = "Long search excerpt " * 500
                row = self.normalize([{"title": "Snippet only", "snippet": snippet, "evidence_level": label}])[0]
                self.assertNotIn("abstract", row)
                self.assertEqual(row["snippet"], snippet.strip())
                self.assertEqual(row["evidence_level"], "search_result_snippet")

    def test_explicit_abstract_without_provenance_does_not_claim_verification(self):
        row = self.normalize([{"title": "Unverified abstract", "abstract": "Text reported by adapter"}])[0]
        self.assertEqual(row["evidence_level"], "abstract_unverified")
        self.assertEqual(row["abstract"], "Text reported by adapter")

    def test_scholar_merge_defends_even_legacy_bare_title_keys_and_preserves_batch_hits(self):
        entry = {"results": []}
        base = {"title": "Same report title", "doi": "10.1000/a", "source_key": "google-scholar"}
        batch = {"id": "b1", "topic_id": "topic", "label": "label", "query": "q1", "year_from": 2000, "year_to": 2026, "sort": "relevance"}
        legacy_keys = lambda row: {"title:" + row["title"]}
        _merge_results(entry, batch, [base, {**base, "doi": "10.1000/b"},
                                    {**base, "abstract": "More complete metadata"}], legacy_keys)
        self.assertEqual(len(entry["results"]), 3)
        batch2 = {**batch, "id": "b2", "query": "q2"}
        _merge_results(entry, batch2, [{**base, "_query": "q2", "_retrieved_at": "later"}], legacy_keys)
        self.assertEqual(len(entry["results"]), 3)
        self.assertEqual([hit["id"] for hit in entry["results"][0]["hit_batches"]], ["b1", "b2"])
        self.assertEqual([hit["id"] for hit in entry["results"][1]["hit_batches"]], ["b1"])

    def test_page_signature_ignores_tracking_but_distinguishes_conflicting_reports(self):
        one = {"title": "Same title", "doi": "10.1000/a", "year": 2020, "authors": "Jane Doe", "result_url": "https://example.org?a=1"}
        tracked = {**one, "result_url": "https://example.org?a=2"}
        other = {**one, "doi": "10.1000/b"}
        self.assertEqual(_page_fingerprint([one]), _page_fingerprint([tracked]))
        self.assertNotEqual(_page_fingerprint([one]), _page_fingerprint([other]))
        self.assertFalse(_record_keys(one) & _record_keys(other))

    def test_formal_two_page_checkpoint_keeps_conflicting_reports_and_complete_abstract(self):
        calls = []
        abstract = "Complete original abstract. " * 250
        def browser(*args, **kwargs):
            index = kwargs["page_index"]
            calls.append(index)
            return {"status": "ok", "page_index": index, "has_next": index == 0,
                    "results": [{"title": "Same reported title", "doi": "10.1000/" + str(index),
                                 "eid": "2-s2.0-" + str(index), "abstract": abstract,
                                 "evidence_level": "source_abstract", "author_keywords": ["Heat stress"],
                                 "year": 2022}], "url": "https://example.org/results"}
        config = {"topic": "offline fidelity test", "query": "offline q", "sources": ["scopus"],
                  "searchMode": "formal", "stopMode": "end", "perSourceLimit": None, "limit": 10}
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as temporary:
            root = Path(temporary)
            with patch("literature_search.injected_source_runner", browser), redirect_stdout(io.StringIO()):
                self.assertEqual(run(config, root), 0)
            output = json.loads((root / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(calls, [0, 1])
            self.assertEqual(len(output["records"]), 2)
            self.assertEqual({r["doi"] for r in output["records"]}, {"10.1000/0", "10.1000/1"})
            for row in output["records"]:
                self.assertEqual(row["abstract"], abstract.strip())
                self.assertEqual(row["author_keywords"], ["Heat stress"])
                self.assertEqual(row["evidence_level"], "source_abstract")


if __name__ == "__main__":
    unittest.main()
