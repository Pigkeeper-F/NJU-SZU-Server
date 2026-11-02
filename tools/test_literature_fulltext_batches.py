"""Batch download guards and cumulative ledgers; local fake PDFs only."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as fulltext
import test_literature_fulltext as f
from test_literature_screening_integration import POLICY, reviews, row


class FulltextBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        self.ids = [f"R{i:02d}" for i in range(1, 13)]
        f.write_candidates(self.job, [row(key) for key in self.ids])
        self.config = {"screeningPolicy": POLICY, "fulltext": {"maxPapers": 0, "perPaperTimeoutSec": 120}}

    def call(self, ids, **kwargs):
        fetcher = kwargs.pop("fetcher", f.FakeFetcher())
        code, events = f.run_stage(self.job, self.config, fetcher=fetcher, only=ids,
                                  screening_batch=True, resume=True, **kwargs)
        return code, events, fetcher

    def test_batch_downloads_before_other_records_are_screened_and_keeps_global_pending(self):
        reviews(self.job, {key: "include" for key in self.ids[:10]})
        code, events, fetcher = self.call(self.ids[:10])
        self.assertEqual(code, 0)
        self.assertTrue(events[-1]["batch_complete"])
        self.assertFalse(events[-1]["scope_complete"])
        self.assertEqual(events[-1]["count"], 10)
        self.assertEqual(len([x for x in fetcher.calls if x[0] == "fetch_pdf"]), 10)
        state = f.status_map(f.read_status(self.job))
        self.assertEqual(len(state), 12)
        for key in self.ids[10:]:
            self.assertEqual(state[key]["status"], "pending")
            self.assertEqual(state[key]["screening_decision"], "unscreened")
            self.assertFalse(state[key]["extraction_allowed"])
        prior = {key: (self.job / state[key]["path"]).read_bytes() for key in self.ids[:10]}
        reviews(self.job, {key: "include" for key in self.ids})
        _, second, fetcher = self.call(self.ids[10:])
        self.assertTrue(second[-1]["scope_complete"])
        self.assertEqual(second[-1]["count"], 12)
        self.assertEqual(len([x for x in fetcher.calls if x[0] == "fetch_pdf"]), 2)
        for key, data in prior.items():
            self.assertEqual((self.job / state[key]["path"]).read_bytes(), data)
        _, replay, fetcher = self.call(self.ids[:10])
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(replay[-1]["count"], 12)

    def test_unselected_unscreened_does_not_authorize_selected_unscreened(self):
        reviews(self.job, {self.ids[0]: "include"})
        code, events, fetcher = self.call(self.ids[:2])
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["reason"], "screening_required")
        self.assertEqual(fetcher.calls, [])
        self.assertFalse((self.job / "fulltext/status.json").exists())

    def test_excluded_batch_needs_no_fetch_and_does_not_finish_unselected_scope(self):
        reviews(self.job, {key: "exclude" for key in self.ids[:10]})
        _, events, fetcher = self.call(self.ids[:10])
        self.assertEqual(events[-1]["type"], "result")
        self.assertTrue(events[-1]["batch_complete"])
        self.assertFalse(events[-1]["scope_complete"])
        self.assertEqual(events[-1]["count"], 0)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(len(f.read_status(self.job)["items"]), 12)

    def test_pending_qualification_downloads_and_stays_nonextractable(self):
        reviews(self.job, {self.ids[0]: "pending"})
        _, events, _ = self.call(self.ids[:1])
        self.assertTrue(events[-1]["batch_complete"])
        self.assertFalse(f.status_map(f.read_status(self.job))[self.ids[0]]["extraction_allowed"])

    def test_invalid_or_stale_selection_stops_before_fetcher_creation(self):
        reviews(self.job, {key: "include" for key in self.ids[:10]})
        for ids in ([], ["unknown"], [self.ids[0], "unknown"], [self.ids[0], self.ids[0]], ["../bad"]):
            with self.subTest(ids=ids), patch.object(fulltext, "make_fetcher", side_effect=AssertionError("No browser")):
                _, events, fetcher = self.call(ids)
                self.assertNotEqual(events[-1]["type"], "result")
                self.assertEqual(fetcher.calls, [])
        self.config["screeningPolicy"] = {**POLICY, "text": POLICY["text"] + " changed"}
        _, events, fetcher = self.call(self.ids[:10])
        self.assertEqual(events[-1]["reason"], "screening_required")
        self.assertEqual(fetcher.calls, [])

    def test_quota_is_cumulative_and_exclusions_do_not_consume_it(self):
        self.config["fulltext"]["maxPapers"] = 1
        reviews(self.job, {self.ids[0]: "exclude", self.ids[1]: "include", self.ids[2]: "include"})
        _, events, fetcher = self.call(self.ids[:3])
        self.assertTrue(events[-1]["quota_reached"])
        self.assertEqual(events[-1]["count"], 1)
        self.assertEqual([x[1] for x in fetcher.calls if x[0] == "fetch_pdf"], ["https://example.invalid/R02.pdf"])
        _, second, fetcher = self.call([self.ids[2]])
        self.assertTrue(second[-1]["quota_reached"])
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(f.status_map(f.read_status(self.job))[self.ids[2]]["status"], "pending")

    def test_access_barrier_stops_batch_and_next_ids_remain_pending(self):
        reviews(self.job, {key: "include" for key in self.ids[:10]})
        fetcher = f.FakeFetcher(pdf={"https://example.invalid/R02.pdf": {"status": "attention", "reason": "login"}})
        _, events, fetcher = self.call(self.ids[:10], fetcher=fetcher)
        self.assertEqual(events[-1]["type"], "attention")
        self.assertEqual(events[-1]["reason"], "login")
        self.assertEqual(len([x for x in fetcher.calls if x[0] == "fetch_pdf"]), 2)
        state = f.status_map(f.read_status(self.job))
        self.assertEqual(state["R01"]["status"], "fetched_pdf")
        self.assertEqual(state["R03"]["status"], "pending")
        _, resumed, fetcher = self.call(self.ids[:10])
        self.assertEqual(resumed[-1]["type"], "result")
        self.assertEqual(len([x for x in fetcher.calls if x[0] == "fetch_pdf"]), 9)

    def test_batch_cannot_convert_a_saved_access_barrier_to_skip(self):
        reviews(self.job, {self.ids[0]: "include"})
        blocked = f.FakeFetcher(pdf={"https://example.invalid/R01.pdf": {"status": "attention", "reason": "login"}})
        self.call(self.ids[:1], fetcher=blocked)
        before = (self.job / "fulltext/status.json").read_bytes()
        _, events, fetcher = self.call(self.ids[:1], skip_unavailable=True)
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(fetcher.calls, [])
        self.assertEqual((self.job / "fulltext/status.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
