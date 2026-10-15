from __future__ import annotations

import csv
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literature_search import normalize_candidates, safe_csv_cell, write_results, run


class LiteratureSearchTest(unittest.TestCase):
    def test_csv_formula_is_not_executable(self) -> None:
        self.assertEqual(safe_csv_cell('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")")
        self.assertEqual(safe_csv_cell('ordinary title'), 'ordinary title')

    def test_normalize_keeps_candidates_unreviewed_and_deduplicates_title(self) -> None:
        records = normalize_candidates([
            {"title": " Climate effects on aquaculture ", "snippet": "a result snippet", "result_url": "https://example.org/a",
             "fulltext_links": [{"label": "PDF", "url": "https://example.org/a.pdf"}]},
            {"title": "Climate effects on aquaculture", "result_url": "https://example.org/duplicate"},
            {"title": "Other paper", "result_url": "javascript:alert(1)"},
        ], "climate aquaculture", "2026-10-15T00:00:00+00:00")
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["screening_status"], "pending_review")
        self.assertEqual(records[0]["evidence_level"], "search_result_snippet")
        self.assertEqual(records[0]["fulltext_links"][0]["url"], "https://example.org/a.pdf")
        self.assertEqual(records[1]["result_url"], "")

    def test_writes_json_and_excel_friendly_csv_without_fulltext_claim(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            result = write_results(output, "中国 畜禽 气候变化", {
                "url": "https://scholar.google.com/scholar?q=test",
                "results": [{"title": "示例论文", "byline": "作者", "snippet": "检索片段"}],
            })
            self.assertEqual(result["count"], 1)
            report = json.loads((output / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(report["scope"], "first_page_candidates_only")
            self.assertEqual(report["records"][0]["screening_status"], "pending_review")
            with (output / "candidates.csv").open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(rows[0]["title"], "示例论文")
            self.assertEqual(rows[0]["evidence_level"], "search_result_snippet")

    def test_run_forwards_confirmed_publication_years_to_scholar(self) -> None:
        received = []
        scholar = types.SimpleNamespace(run=lambda *args: (received.append(args) or {"status": "no_results", "url": "https://scholar.google.com/scholar", "results": []}))
        browser = types.SimpleNamespace(launch=lambda: {"status": "already_running"})
        config = {"topic": "中国水产养殖", "query": "China aquaculture climate change", "sources": ["google-scholar"],
                  "publicationYearFrom": 2015, "publicationYearTo": 2023, "limit": 10}
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {"browser": browser, "google_scholar_search": scholar}):
            self.assertEqual(run(config, Path(temp)), 0)
            self.assertEqual(received, [(config["query"], False, 10, 2015, 2023)])
            report = json.loads((Path(temp) / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(report["run_config"]["publicationYearFrom"], 2015)


if __name__ == "__main__":
    unittest.main()
