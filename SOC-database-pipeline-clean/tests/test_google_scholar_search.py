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


if __name__ == "__main__":
    unittest.main()
