from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".codex" / "skills" / "soc-paper-fetch" / "scripts"))

import google_scholar_search


class GoogleScholarSearchTest(unittest.TestCase):
    def test_build_search_url_targets_google_scholar(self) -> None:
        url = google_scholar_search.build_search_url("soil organic carbon manure")

        self.assertTrue(url.startswith("https://scholar.google.com/scholar?"))
        self.assertIn("q=soil+organic+carbon+manure", url)

    def test_resume_uses_existing_scholar_page(self) -> None:
        class Page:
            def __init__(self, url: str) -> None:
                self.url = url

        class Context:
            def __init__(self) -> None:
                self.pages = [Page("https://example.org"), Page("https://scholar.google.com/scholar?q=test")]

        context = Context()
        self.assertIs(google_scholar_search.pick_search_page(context, True), context.pages[1])

    def test_build_search_url_applies_publication_years(self) -> None:
        url = google_scholar_search.build_search_url("climate aquaculture", 2000, 2026)
        self.assertIn("as_ylo=2000", url)
        self.assertIn("as_yhi=2026", url)


if __name__ == "__main__":
    unittest.main()
