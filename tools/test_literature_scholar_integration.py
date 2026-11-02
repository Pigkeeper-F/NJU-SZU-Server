"""Bounded, offline integration checks; never requests Scholar or user jobs."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import literature_search as search


def config(trial=2):
    plan = {"version": 1, "topics": [{"id": "broiler-heat", "label": "肉鸡热应激",
                                     "query": 'broiler "heat stress"'}],
            "yearSpan": 5, "sort": "relevance"}
    if trial:
        plan["trialMaxPages"] = trial
    return {"topic": "Scholar独立预试", "query": 'broiler "heat stress"',
            "sources": ["google-scholar"], "publicationYearFrom": 2020,
            "publicationYearTo": 2024, "limit": 10, "searchMode": "formal",
            "stopMode": "end", "perSourceLimit": None,
            "batch": {"size": 10, "maxBatches": 1}, "scholarPlan": plan}


def page(number, *, end=False):
    return {"status": "ok", "page_index": number, "has_next": not end,
            "url": "https://scholar.google.com/scholar", "transport": "browser",
            "applied_filters": ["query", "publicationYearFrom", "publicationYearTo"],
            "results": [{"title": f"Broiler heat paper {number}-{i}", "year": 2021,
                         "result_url": f"https://example.org/p/{number}/{i}"} for i in range(10)]}


class ScholarIntegrationTests(unittest.TestCase):
    def test_v2_whole_period_and_supplement_flow_through_search_owner(self):
        c = config(trial=0)
        c.update(publicationYearFrom=2000, publicationYearTo=2026)
        c["scholarPlan"].update(version=2, yearSpan=0, topics=[
            {"id": "primary", "query": "title primary"},
            {"id": "supplement", "query": "outside title supplement"}])
        calls = []
        def fetch(*args, **kwargs):
            calls.append((args[1], args[4], args[5], kwargs["page_index"]))
            result = page(0, end=True)
            for row in result["results"]:
                row["title"] = args[1] + " " + row["title"]
                row["result_url"] += "/" + str(len(calls))
            return result
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp, patch.object(search, "_run_source", fetch), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(search.run(c, Path(tmp)), 0)
            report = json.loads((Path(tmp) / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(calls, [("title primary", 2000, 2026, 0),
                                     ("outside title supplement", 2000, 2026, 0)])
            self.assertEqual(report["count"], 20)
            self.assertTrue(report["discovery_complete"])
            state = json.loads((Path(tmp) / "discovery-state.json").read_text(encoding="utf-8"))
            schedule = state["sources"]["google-scholar"]["scholar_schedule"]
            self.assertEqual(schedule["version"], 2)
            self.assertEqual(len(schedule["batches"]), 2)

    def test_plan_changes_fingerprint_without_changing_legacy(self):
        c = config()
        legacy = {k: v for k, v in c.items() if k != "scholarPlan"}
        self.assertNotEqual(search.config_fingerprint(c), search.config_fingerprint(legacy))
        self.assertEqual(search.config_fingerprint(legacy), search.config_fingerprint({**legacy, "scholarPlan": None}))

    def test_trial_rejects_other_sources_and_nonformal(self):
        with self.assertRaises(ValueError):
            search.validate_config({**config(), "sources": ["google-scholar", "scopus"]})
        with self.assertRaises(ValueError):
            search.validate_config({**config(), "searchMode": "test", "stopMode": "count", "perSourceLimit": 10})

    def test_trial_is_two_pages_total_not_a_complete_search(self):
        calls = []
        def fetch(*args, **kwargs):
            calls.append(kwargs["page_index"])
            self.assertEqual((args[0], args[4], args[5]), ("google-scholar", 2020, 2024))
            if len(calls) > 2:
                self.fail("trial exceeded its frozen page budget")
            return page(kwargs["page_index"])
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp, patch.object(search, "_run_source", fetch), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(search.run(config(), Path(tmp)), 0)
            report = json.loads((Path(tmp) / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(calls, [0, 1])
            self.assertEqual(report["count"], 20)
            self.assertFalse(report["discovery_complete"])
            self.assertTrue(report["source_status"]["google-scholar"]["trial_complete"])
            self.assertEqual(report["source_status"]["google-scholar"]["stop_reason"], "trial_budget_reached")
            self.assertEqual(len(report["records"][0]["hit_batches"]), 1)
            self.assertEqual(report["records"][0]["hit_batches"][0]["year_from"], 2020)

    def test_pause_reload_resumes_only_unfinished_page_and_same_budget(self):
        calls, paused = [], False
        def fetch(*args, **kwargs):
            nonlocal paused
            n = kwargs["page_index"]
            calls.append(n)
            if len(calls) > 4:
                self.fail("resume exceeded trial budget instead of stopping")
            if n == 1 and not paused:
                paused = True
                return {"status": "attention", "reason": "verification", "results": [], "message": "请验证"}
            result = page(n)
            if n == 1:
                result["recovery"] = {"mode": "resume_current", "message": "从已保存断点继续第2页",
                                      "target_page": 2, "position_verified": True,
                                      "continuity_verified": False, "private_session": "must-not-save"}
            return result
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp, patch.object(search, "_run_source", fetch), contextlib.redirect_stdout(io.StringIO()) as events:
            out = Path(tmp)
            self.assertEqual(search.run(config(), out), 0)
            first = json.loads((out / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(first["count"], 10)
            self.assertEqual(search.run(config(), out, resume=True), 0)
            final = json.loads((out / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual(calls, [0, 1, 1])
            self.assertEqual(final["count"], 20)
            self.assertFalse(final["discovery_complete"])
            state = json.loads((out / "discovery-state.json").read_text(encoding="utf-8"))
            entry = state["sources"]["google-scholar"]
            self.assertEqual(entry["recovery"]["message"], "从已保存断点继续第2页")
            self.assertTrue(entry["pages"][-1]["recovery"]["position_verified"])
            self.assertNotIn("private_session", entry["recovery"])
            self.assertIn("从已保存断点继续第2页", events.getvalue())


if __name__ == "__main__":
    unittest.main()
