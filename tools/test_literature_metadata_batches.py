"""Subset metadata checkpoints; entirely local mocked article transport."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_metadata as metadata
from test_literature_metadata import row, FixtureFetcher, ROOT


class MetadataBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        self.rows = [row(cid) for cid in ("R1", "R2", "R3")]
        self.write()

    def write(self):
        (self.job / "candidates.json").write_text(json.dumps({"records": self.rows}), encoding="utf-8")

    def run_batch(self, fetcher, **kwargs):
        return metadata.run({}, self.job, fetcher=fetcher, on_event=lambda *a, **k: None, **kwargs)

    def test_subsets_touch_only_selected_originals_and_preserve_global_pending(self):
        before = (self.job / "candidates.json").read_bytes()
        fetcher = FixtureFetcher()
        result = self.run_batch(fetcher, only=["R2"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["selected_candidate_ids"], ["R2"])
        self.assertEqual(result["counts"]["verified"], 1)
        self.assertEqual(result["global_counts"]["pending"], 2)
        state = metadata.read_status(self.job)
        self.assertEqual(set(state["items"]), {"R2"})
        original = state["items"]["R2"]
        self.run_batch(fetcher, only=["R3", "R1"])
        self.assertEqual(len(fetcher.calls), 3)
        self.assertEqual(metadata.read_status(self.job)["items"]["R2"], original)
        self.assertEqual(self.run_batch(fetcher)["attempted"], 0)
        self.assertEqual((self.job / "candidates.json").read_bytes(), before)

    def test_invalid_selection_fails_before_fetch_or_checkpoint_writes(self):
        for ids in ([], ["R1", "R1"], ["foreign"], ["../R1"], "R1", [False]):
            with self.subTest(ids=ids):
                fetcher = FixtureFetcher()
                with self.assertRaises(ValueError):
                    self.run_batch(fetcher, only=ids)
                self.assertEqual(fetcher.calls, [])
                self.assertFalse((self.job / "metadata").exists())

    def test_an_access_stop_cannot_be_cleared_by_switching_to_a_cached_subset(self):
        self.run_batch(FixtureFetcher(), only=["R1"])
        limited = FixtureFetcher([{"status": "attention", "reason": "rate_limited"}])
        self.assertEqual(self.run_batch(limited, only=["R2"])["stop_reason"], "rate_limited")
        other = FixtureFetcher()
        blocked = self.run_batch(other, only=["R1"])
        self.assertEqual(blocked["stop_reason"], "rate_limited")
        self.assertEqual(other.calls, [])
        self.assertEqual(metadata.read_status(self.job)["last_stop_reason"], "rate_limited")
        self.assertTrue(self.run_batch(other, only=["R2"], retry_attention=True)["complete"])

    def test_budget_keeps_unvisited_batch_and_outside_records_distinct(self):
        clock = [0]
        fetcher = FixtureFetcher(clock=clock)
        first = self.run_batch(fetcher, only=["R1", "R2"], total_budget_sec=4, clock=lambda: clock[0])
        self.assertEqual(first["pending_count"], 1)
        self.assertEqual(first["global_counts"]["pending"], 2)
        self.assertNotIn("R3", metadata.read_status(self.job)["items"])
        second = self.run_batch(fetcher, only=["R1", "R2"], total_budget_sec=6, clock=lambda: clock[0])
        self.assertTrue(second["complete"])
        self.assertEqual(second["global_counts"]["pending"], 1)

    def test_changed_original_hash_invalidates_cached_subset_evidence(self):
        self.run_batch(FixtureFetcher(), only=["R1", "R2"])
        previous = metadata.read_status(self.job)["items"]["R2"]
        self.rows[0]["year"] = 2023
        self.write()
        fetcher = FixtureFetcher()
        self.run_batch(fetcher, only=["R1"])
        self.assertEqual(len(fetcher.calls), 1)
        self.assertEqual(metadata.read_status(self.job)["items"]["R2"], previous)

    def test_cli_passes_json_id_subset_without_rewriting_config(self):
        config = self.job / "run_config.json"
        config.write_text("{}", encoding="utf-8")
        with patch.object(metadata, "run", return_value={"ok": True}) as runner:
            self.assertEqual(metadata.main(["--config", str(config), "--output-dir", str(self.job), "--only", '["R2"]']), 0)
        self.assertEqual(runner.call_args.kwargs["only"], ["R2"])


if __name__ == "__main__":
    unittest.main()
