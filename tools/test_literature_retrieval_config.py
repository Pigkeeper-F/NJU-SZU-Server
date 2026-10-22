"""Cross-language discovery budget and partial-page restart guards."""
from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path

common = importlib.import_module("literature-common")
SOURCES = ["google-scholar", "cnki", "wanfang", "web-of-science", "scopus", "pubmed"]


class RetrievalConfigTest(unittest.TestCase):
    def test_formal_budget_matches_frozen_node_formula(self) -> None:
        for source_count in (1, 2, 3, 6):
            for target in (1, 10, 11, 25, 100, 1000):
                config = {"sources": SOURCES[:source_count], "searchMode": "formal", "perSourceLimit": target}
                expected = min(86400, 180 * source_count * ((target + 9) // 10))
                self.assertEqual(common.resolve_limits(config)["discover"], expected)
                self.assertEqual(common.resolve_limits({**config, "limits": {"discover": 60}})["discover"], 60)
        self.assertEqual(common.resolve_limits({"sources": SOURCES, "searchMode": "formal"})["discover"], 10800)

    def test_end_budget_and_explicit_runtime_protection(self) -> None:
        for source_count in (1, 3, 6):
            for stale_target in (None, 1, 25, 1000, 10000, True):
                config = {"sources": SOURCES[:source_count], "searchMode": "formal", "stopMode": "end", "perSourceLimit": stale_target}
                self.assertEqual(common.resolve_limits(config)["discover"], 86400)
                self.assertEqual(common.resolve_limits({**config, "limits": {"discover": 60}})["discover"], 60)
        self.assertEqual(common.resolve_limits({"sources": SOURCES, "searchMode": "test", "stopMode": "count"})["discover"], 1080)

    def test_legacy_test_and_invalid_saved_limits(self) -> None:
        self.assertEqual(common.resolve_limits(None), common.DEFAULT_LIMITS)
        for count in (1, 3, 6):
            config = {"sources": SOURCES[:count]}
            self.assertEqual(common.resolve_limits(config)["discover"], count * 180)
            self.assertEqual(common.resolve_limits({**config, "searchMode": "test", "perSourceLimit": 1000})["discover"], count * 180)
        self.assertEqual(common.resolve_limits({"sources": [], "limits": {"discover": -1}})["discover"], 180)
        self.assertEqual(common.resolve_limits({"sources": SOURCES * 3})["discover"], 1080)
        self.assertEqual(common.resolve_limits({"sources": SOURCES, "searchMode": "formal", "perSourceLimit": True})["discover"], 10800)

    def test_partial_pages_do_not_complete_discovery_after_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="literature-paged-resume-") as temporary:
            job = Path(temporary)
            file = common.job_paths(job)["candidates_json"]
            report = {"version": 2, "batches": [{"batch_index": 1}], "records": [{"candidate_id": "GSC-001"}], "discovery_complete": False}
            common.atomic_write_json(file, report)
            self.assertEqual(common.detect_completed_stages(job)["discover"], "pending")
            report["discovery_complete"] = True
            common.atomic_write_json(file, report)
            self.assertEqual(common.detect_completed_stages(job)["discover"], "done")
            del report["discovery_complete"]
            common.atomic_write_json(file, report)
            self.assertEqual(common.detect_completed_stages(job)["discover"], "done", "Old complete batches remain compatible")


if __name__ == "__main__":
    unittest.main()
