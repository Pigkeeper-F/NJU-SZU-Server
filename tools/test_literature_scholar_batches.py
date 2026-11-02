"""Offline tests for the explicit Scholar partition ledger; never query Scholar."""
from __future__ import annotations

from copy import deepcopy
import json
import unittest

from literature_scholar_batches import (
    build_schedule, next_batch, normalize_plan, refine_on_limit, summarize,
)


def plan(**changes):
    raw = {
        "version": 1,
        "topics": [{"id": "broiler", "label": "肉鸡", "query": 'broiler "heat stress"',
                    "refinementQueries": ['broiler "ambient temperature"', 'broiler "cold stress"']}],
        "yearSpan": 5,
        "sort": "relevance",
    }
    raw.update(changes)
    return raw


class ScholarBatchPlanTests(unittest.TestCase):
    def test_v1_frozen_fingerprint_and_batch_ids_do_not_migrate(self):
        raw = plan(topics=[{"id": "frozen", "label": "Frozen legacy", "query": "legacy query"}])
        schedule = build_schedule(normalize_plan(raw, 2000, 2026))
        self.assertEqual(schedule["version"], 1)
        self.assertEqual(schedule["fingerprint"],
                         "e9d257620aa784f779c3d3eb7c9a5e15a21cf9f5a0c28fc9f1758d5655071768")
        self.assertEqual([b["id"] for b in schedule["batches"]], [
            "gsc-c73d85f6be6cf86c64c3f309", "gsc-a7c293a90f430cec363a2c40",
            "gsc-12ca0d6a674f654c780b5683", "gsc-4fc2c01ff44de183b5fc1673",
            "gsc-6a6499cb90030af169cdfc25", "gsc-543e46eb25c00b841835c2d1"])
        self.assertEqual(next_batch(json.loads(json.dumps(schedule))), schedule["batches"][0])

    def test_v2_whole_period_preserves_primary_then_supplement_as_independent_topics(self):
        topics = [{"id": "primary", "query": 'allintitle: methane aquaculture',
                   "refinementQueries": ['allintitle: methane fishpond', 'allintitle: methane "shrimp pond"']},
                  {"id": "supplement", "query": 'methane aquaculture temperature'}]
        raw = plan(version=2, yearSpan=0, topics=topics)
        before = deepcopy(raw)
        schedule = build_schedule(normalize_plan(raw, 2000, 2026))
        self.assertEqual(raw, before)
        self.assertEqual(schedule["version"], 2)
        self.assertEqual([(b["topic_id"], b["year_from"], b["year_to"])
                          for b in schedule["batches"]],
                         [("primary", 2000, 2026), ("supplement", 2000, 2026)])
        self.assertEqual(summarize(schedule)["pending_batches"], 2)
        schedule["batches"][0]["status"] = "ok"
        self.assertEqual(next_batch(schedule)["topic_id"], "supplement")
        self.assertFalse(summarize(schedule)["discovery_complete"])
        future = build_schedule(normalize_plan(raw, 2000, 2027))
        self.assertEqual(future["batches"][0]["year_to"], 2027)
        self.assertNotEqual(future["fingerprint"], schedule["fingerprint"])

    def test_v2_limit_partitions_whole_period_then_prelisted_queries_only(self):
        schedule = build_schedule(normalize_plan(plan(version=2, yearSpan=0), 2000, 2026))
        parent = next_batch(schedule)
        refined = refine_on_limit(schedule, parent["id"])
        self.assertEqual(len(refined["batches"]), 28)
        self.assertEqual([(b["year_from"], b["year_to"]) for b in refined["batches"][1:]],
                         [(y, y) for y in range(2000, 2027)])
        yearly = next_batch(refined)
        second = refine_on_limit(refined, yearly["id"])
        child = next_batch(second)
        self.assertEqual((child["depth"], child["refinement_stage"], child["year_from"]), (2, "query", 2000))
        terminal = refine_on_limit(second, child["id"])
        self.assertEqual(len(terminal["batches"]), len(second["batches"]))
        self.assertEqual(summarize(terminal)["coverage_limited_batches"], 1)
        self.assertFalse(summarize(terminal)["discovery_complete"])
        self.assertEqual(summarize(json.loads(json.dumps(terminal))), summarize(terminal))

    def test_v2_invalid_year_span_or_checkpoint_migration_is_rejected(self):
        for changes in ({"version": 2, "yearSpan": 5}, {"version": 2, "yearSpan": False},
                        {"version": 2, "yearSpan": 0.0}, {"version": 1, "yearSpan": 0},
                        {"version": 3, "yearSpan": 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                normalize_plan(plan(**changes), 2000, 2026)
        schedule = build_schedule(normalize_plan(plan(version=2, yearSpan=0), 2000, 2026))
        schedule["version"] = 1
        with self.assertRaises(ValueError):
            summarize(schedule)
        schedule = build_schedule(normalize_plan(plan(version=2, yearSpan=0), 2000, 2026))
        schedule["batches"][0]["year_to"] = 2004
        with self.assertRaises(ValueError):
            summarize(schedule)

    def test_2000_to_2026_has_six_bounded_windows(self):
        raw = plan()
        before = deepcopy(raw)
        normalized = normalize_plan(raw, 2000, 2026)
        schedule = build_schedule(normalized)
        self.assertEqual(raw, before)
        self.assertEqual([(b["year_from"], b["year_to"]) for b in schedule["batches"]],
                         [(2000, 2004), (2005, 2009), (2010, 2014),
                          (2015, 2019), (2020, 2024), (2025, 2026)])
        self.assertEqual(len({b["id"] for b in schedule["batches"]}), 6)
        self.assertTrue(all(b["query"] == 'broiler "heat stress"' for b in schedule["batches"]))
        self.assertIsNone(normalized["trialMaxPages"])

    def test_topic_order_and_stable_identity_preserve_the_explicit_queries(self):
        raw = plan(topics=[{"id": "cow", "label": "牛", "query": 'cattle "relative humidity"'},
                           {"id": "manure", "label": "养殖粪污", "query": '"livestock manure" temperature'}])
        a = build_schedule(normalize_plan(raw, 2020, 2026))
        b = build_schedule(normalize_plan(deepcopy(raw), 2020, 2026))
        self.assertEqual(a, b)
        self.assertEqual([x["topic_id"] for x in a["batches"]], ["cow", "cow", "manure", "manure"])
        different = deepcopy(raw)
        different["topics"][0]["query"] = 'cattle "heat stress"'
        c = build_schedule(normalize_plan(different, 2020, 2026))
        self.assertNotEqual(a["fingerprint"], c["fingerprint"])
        self.assertNotEqual(a["batches"][0]["id"], c["batches"][0]["id"])

    def test_trial_page_budget_is_metadata_and_not_a_candidate_or_batch_cap(self):
        schedule = build_schedule(normalize_plan(plan(trialMaxPages=2), 2000, 2026))
        self.assertEqual(schedule["plan"]["trialMaxPages"], 2)
        self.assertEqual(len(schedule["batches"]), 6)
        self.assertTrue(all(b["next_page"] == 0 for b in schedule["batches"]))
        self.assertEqual(summarize(schedule)["pending_batches"], 6)

    def test_explicit_null_budget_is_full_plan(self):
        self.assertIsNone(normalize_plan(plan(trialMaxPages=None), 2020, 2024)["trialMaxPages"])

    def test_rejects_malformed_or_silently_changed_scope(self):
        cases = [plan(version=True), plan(version=1.0), plan(version=2), plan(yearSpan=1),
                 plan(yearSpan=5.0), plan(sort="date"),
                 plan(trialMaxPages=True), plan(trialMaxPages=0), plan(trialMaxPages=-1),
                 plan(topics=[]), plan(topics=[{"id": "x", "query": " "}]),
                 plan(topics=[{"id": "x", "query": "q"}, {"id": "x", "query": "q2"}]),
                 plan(topics=[{"id": "../x", "query": "q"}]), plan(unknown="do not silently drop")]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                normalize_plan(raw, 2020, 2024)
        for low, high in [(None, 2024), (2024, None), (True, 2024), (2026, 2020), (1799, 2024)]:
            with self.subTest(years=(low, high)), self.assertRaises(ValueError):
                normalize_plan(plan(), low, high)

    def test_resume_returns_same_leaf_with_its_saved_page_and_materials_intact(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2024))
        batch = next_batch(schedule)
        batch.update(status="attention", next_page=12, count=119, retrieved_count=119,
                     pages=[{"page_index": 11, "fingerprint": "saved-anchor"}],
                     results=[{"title": "saved paper"}])
        restored = json.loads(json.dumps(schedule))
        same = next_batch(restored)
        self.assertEqual(same["id"], batch["id"])
        self.assertEqual((same["next_page"], same["count"]), (12, 119))
        self.assertEqual(same["pages"], [{"page_index": 11, "fingerprint": "saved-anchor"}])
        self.assertEqual(same["results"], [{"title": "saved paper"}])
        self.assertFalse(summarize(restored)["discovery_complete"])

    def test_source_limit_splits_all_years_and_preserves_parent_pages(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2024))
        parent = next_batch(schedule)
        parent.update(status="attention", next_page=99, count=990,
                      pages=[{"page_index": 98, "fingerprint": "kept"}])
        before = deepcopy(schedule)
        refined = refine_on_limit(schedule, parent["id"])
        self.assertEqual(schedule, before, "refinement returns a new ledger")
        kept = next(b for b in refined["batches"] if b["id"] == parent["id"])
        self.assertEqual(kept["status"], "split")
        self.assertEqual((kept["next_page"], kept["count"], kept["pages"]),
                         (99, 990, [{"page_index": 98, "fingerprint": "kept"}]))
        children = [b for b in refined["batches"] if b["parent_id"] == parent["id"]]
        self.assertEqual([(b["year_from"], b["year_to"]) for b in children],
                         [(2020, 2020), (2021, 2021), (2022, 2022), (2023, 2023), (2024, 2024)])
        self.assertTrue(all(b["depth"] == 1 and b["query"] == parent["query"] for b in children))
        self.assertEqual(len(kept["children"]), 5)
        self.assertEqual(next_batch(refined)["id"], children[0]["id"])
        self.assertEqual(summarize(refined)["split_batches"], 1)
        self.assertFalse(summarize(refined)["discovery_complete"])
        self.assertEqual(refine_on_limit(refined, parent["id"]), refined, "parent split is idempotent")

    def test_single_year_can_only_use_predeclared_refinement_queries_once(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2024))
        original_id = next_batch(schedule)["id"]
        years = refine_on_limit(schedule, original_id)
        year_batch = next_batch(years)
        refined = refine_on_limit(years, year_batch["id"])
        children = [b for b in refined["batches"] if b["parent_id"] == year_batch["id"]]
        self.assertEqual([b["query"] for b in children],
                         ['broiler "ambient temperature"', 'broiler "cold stress"'])
        self.assertTrue(all(b["depth"] == 2 and b["year_from"] == b["year_to"] == 2020 for b in children))
        deepest = refine_on_limit(refined, children[0]["id"])
        limited = next(b for b in deepest["batches"] if b["id"] == children[0]["id"])
        self.assertEqual(limited["status"], "coverage_limited")
        self.assertTrue(limited["gap"])
        self.assertEqual(len(deepest["batches"]), len(refined["batches"]), "no infinite query splitting")

    def test_one_year_with_no_refinements_reports_gap_and_never_complete(self):
        schedule = build_schedule(normalize_plan(plan(topics=[{"id": "x", "query": "explicit query"}]), 2026, 2026))
        refined = refine_on_limit(schedule, next_batch(schedule)["id"])
        self.assertIsNone(next_batch(refined))
        summary = summarize(refined)
        self.assertEqual(summary["status"], "coverage_limited")
        self.assertEqual(summary["coverage_limited_batches"], 1)
        self.assertFalse(summary["discovery_complete"])

    def test_verification_or_network_errors_do_not_trigger_automatic_partitioning(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2024))
        original = deepcopy(schedule)
        for reason in ("verification", "login", "network_error", "results_unrecognized",
                       "rate_limited", "access_blocked"):
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                refine_on_limit(schedule, next_batch(schedule)["id"], reason=reason)
        self.assertEqual(schedule, original)

    def test_all_visited_leaves_complete_is_accessible_processed_not_a_recall_claim(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2026))
        schedule["batches"][0]["status"] = "ok"
        self.assertEqual(next_batch(schedule)["year_from"], 2025)
        self.assertFalse(summarize(schedule)["discovery_complete"])
        schedule["batches"][1]["status"] = "no_results"
        summary = summarize(schedule)
        self.assertIsNone(next_batch(schedule))
        self.assertEqual(summary["status"], "processed")
        self.assertEqual(summary["processed_batches"], 2)
        self.assertTrue(summary["discovery_complete"])
        self.assertFalse(summary["complete_recall_claimed"])

    def test_tampered_plan_or_ledger_is_rejected_without_reinitializing(self):
        original = build_schedule(normalize_plan(plan(), 2020, 2024))
        invalid = deepcopy(original)
        invalid["plan"]["topics"][0]["query"] = "changed query"
        with self.assertRaises(ValueError):
            next_batch(invalid)
        invalid = deepcopy(original)
        invalid["batches"].append(deepcopy(invalid["batches"][0]))
        with self.assertRaises(ValueError):
            summarize(invalid)
        invalid = deepcopy(original)
        invalid["batches"][0]["status"] = "silently-finished"
        with self.assertRaises(ValueError):
            summarize(invalid)
        with self.assertRaises(ValueError):
            refine_on_limit(original, "missing")

    def test_missing_initial_window_cannot_be_silently_marked_complete(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2026))
        schedule["batches"].pop()
        schedule["batches"][0]["status"] = "ok"
        with self.assertRaises(ValueError):
            summarize(schedule)

    def test_missing_split_year_cannot_be_hidden_by_editing_parent_children(self):
        schedule = build_schedule(normalize_plan(plan(), 2020, 2024))
        original_id = next_batch(schedule)["id"]
        refined = refine_on_limit(schedule, original_id)
        parent = next(b for b in refined["batches"] if b["id"] == original_id)
        removed = parent["children"].pop()
        refined["batches"] = [b for b in refined["batches"] if b["id"] != removed]
        for batch in refined["batches"]:
            if batch["parent_id"]:
                batch["status"] = "ok"
        with self.assertRaises(ValueError):
            summarize(refined)


if __name__ == "__main__":
    unittest.main()
