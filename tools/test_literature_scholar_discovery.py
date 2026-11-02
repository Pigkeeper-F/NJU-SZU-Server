"""Callback-driven Scholar discovery tests; no real browser or network."""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import unittest

from literature_scholar_discovery import run_plan


def configuration(*, topics=None, low=2020, high=2024, budget=None, version=1):
    return {"query": "legacy default is not submitted", "sources": ["google-scholar"],
            "publicationYearFrom": low, "publicationYearTo": high, "searchMode": "formal", "stopMode": "end",
            "scholarPlan": {"version": version, "yearSpan": 5 if version == 1 else 0, "sort": "relevance", "trialMaxPages": budget,
                            "topics": topics or [{"id": "chicken", "label": "鸡", "query": 'broiler "heat stress"'}]}}


def candidate(title, doi=""):
    return {"title": title, "doi": doi, "year": 2020,
            "result_url": "https://example.org/" + title.replace(" ", "-")}


def page(rows, *, index=0, more=False, **extra):
    return {"status": "ok", "results": rows, "page_index": index, "has_next": more,
            "url": "https://scholar.google.com/scholar", "transport": "browser", **extra}


def identities(row):
    keys = {"title:" + row["title"].casefold()} if row.get("title") else set()
    if row.get("doi"):
        keys.add("doi:" + row["doi"].casefold())
    return keys


def fingerprint(rows):
    return hashlib.sha256(json.dumps(sorted(row.get("title", "") for row in rows)).encode()).hexdigest()


class Harness:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls, self.events, self.snapshots, self.normalizations = [], [], [], []
        self.entry = {"status": "running", "results": [], "pages": [], "next_page": 0,
                      "count": 0, "retrieved_count": 0, "applied_filters": [], "deferred_rules": []}

    def fetch(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if not self.responses:
            raise AssertionError("Unexpected source request after planned stop")
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return deepcopy(value)

    def normalize(self, search, config, source, query, *, full_page):
        self.normalizations.append((config["publicationYearFrom"], config["publicationYearTo"], source, query, full_page))
        return {"results": [{**row, "source_key": source, "_query": query, "_retrieved_at": "saved-time"}
                            for row in search.get("results", [])],
                "applied_filters": ["query", "publicationYearFrom", "publicationYearTo"],
                "deferred_rules": ["inclusion", "exclusion"], "url": search.get("url", ""),
                "transport": "browser", "retrieved_at": "saved-time",
                "year_filtering": {"mode": "source_ui", "excluded": 0, "unknown_year_retained": 0}}

    def run(self, config=None, *, resumed=False):
        return run_plan(config or configuration(), Path("unused-offline-directory"), self.entry,
                        resumed=resumed, fetch=self.fetch, normalize_page=self.normalize,
                        record_keys=identities, page_fingerprint=fingerprint,
                        persist=lambda: self.snapshots.append(deepcopy(self.entry)),
                        emit=lambda kind, **data: self.events.append((kind, data)))


class ScholarDiscoveryTests(unittest.TestCase):
    def test_v2_runs_primary_then_fixed_supplement_without_first_n_or_year_expansion(self):
        topics = [{"id": "main", "query": "title primary",
                   "refinementQueries": ["limited child one", "limited child two"]},
                  {"id": "supplement", "query": "outside title supplement"}]
        h = Harness([page([candidate("main row")]), page([candidate("supplement row")])])
        self.assertEqual(h.run(configuration(version=2, topics=topics, low=2000, high=2026)), "processed")
        self.assertEqual([(call[0][1], call[0][4], call[0][5]) for call in h.calls],
                         [("title primary", 2000, 2026), ("outside title supplement", 2000, 2026)])
        self.assertEqual(h.entry["scholar_summary"]["total_batches"], 2)
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 0)
        self.assertTrue(h.entry["scholar_summary"]["discovery_complete"])

    def test_v2_access_blocks_override_stale_cap_and_keep_same_page_for_resume(self):
        for reason in ("rate_limited", "access_blocked"):
            for status in ("ok", "attention", "error"):
                with self.subTest(reason=reason, status=status):
                    h = Harness([page([candidate("saved")], more=True),
                                 page([candidate("stale")], index=1, status=status, reason=reason,
                                      source_limit_reached=True),
                                 page([candidate("resumed")], index=1)])
                    config = configuration(version=2, low=2000, high=2026)
                    self.assertEqual(h.run(config), "attention")
                    self.assertEqual(h.entry["reason"], reason)
                    self.assertEqual((h.entry["count"], h.entry["next_page"]), (1, 1))
                    self.assertEqual(h.entry["scholar_summary"]["split_batches"], 0)
                    self.assertEqual(len(h.calls), 2)
                    self.assertEqual(h.run(config), "attention")
                    self.assertEqual(len(h.calls), 2, "no automatic retries or alternate-query requests")
                    self.assertEqual(h.run(config, resumed=True), "processed")
                    self.assertEqual([call[1]["page_index"] for call in h.calls], [0, 1, 1])
                    self.assertEqual([r["title"] for r in h.entry["results"]], ["saved", "resumed"])

    def test_v2_source_cap_splits_all_years_without_hiding_supplement(self):
        topics = [{"id": "main", "query": "primary"}, {"id": "supplement", "query": "supplement"}]
        h = Harness([page([candidate("kept parent")], source_limit_reached=True),
                     page([candidate("year one")]), page([candidate("year two")]),
                     page([candidate("supplement row")])])
        config = configuration(version=2, topics=topics, low=2025, high=2026)
        self.assertEqual(h.run(config), "processed")
        self.assertEqual([(call[0][1], call[0][4], call[0][5]) for call in h.calls],
                         [("primary", 2025, 2026), ("primary", 2025, 2025),
                          ("primary", 2026, 2026), ("supplement", 2025, 2026)])
        self.assertEqual(h.entry["count"], 4)
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 1)

    def test_v1_waiting_checkpoint_cannot_be_silently_replaced_by_v2(self):
        h = Harness([page([candidate("legacy saved")], more=True),
                     {"status": "attention", "reason": "verification"}])
        self.assertEqual(h.run(), "attention")
        original_schedule = deepcopy(h.entry["scholar_schedule"])
        self.assertEqual(h.run(configuration(version=2), resumed=True), "attention")
        self.assertEqual(len(h.calls), 2)
        self.assertEqual(h.entry["scholar_schedule"], original_schedule)
        self.assertEqual(h.entry["results"][0]["title"], "legacy saved")

    def test_saved_page_then_verification_resumes_waiting_page_without_recollecting(self):
        h = Harness([page([candidate("first")], more=True),
                     {"status": "attention", "reason": "verification", "message": "请完成验证"},
                     page([candidate("second")], index=1)])
        self.assertEqual(h.run(), "attention")
        self.assertEqual((h.entry["count"], h.entry["next_page"]), (1, 1))
        self.assertEqual(len(h.entry["pages"]), 1)
        original_batch = h.entry["pages"][0]["batch_id"]
        self.assertTrue(any(s["count"] == 1 for s in h.snapshots))
        self.assertEqual(h.run(resumed=True), "processed")
        self.assertEqual([row["title"] for row in h.entry["results"]], ["first", "second"])
        self.assertEqual([call[1]["page_index"] for call in h.calls], [0, 1, 1])
        self.assertEqual([call[0][2] for call in h.calls], [False, False, True])
        self.assertTrue(all(p["batch_id"] == original_batch for p in h.entry["pages"]))
        self.assertTrue(h.entry["scholar_summary"]["discovery_complete"])
        self.assertEqual(h.entry["results"][0]["hit_batches"][0]["query"], 'broiler "heat stress"')

    def test_shared_result_keeps_both_hit_batches_and_is_not_a_repeated_page(self):
        topics = [{"id": "one", "label": "动物线", "query": "query one"},
                  {"id": "two", "label": "来源线", "query": "query two"}]
        same = candidate("same paper", "10.1/shared")
        h = Harness([page([same]), page([same])])
        self.assertEqual(h.run(configuration(topics=topics, low=2020, high=2020)), "processed")
        self.assertEqual(h.entry["count"], 1)
        self.assertEqual(h.entry["retrieved_count"], 2)
        self.assertEqual(len(h.entry["pages"]), 2)
        hits = h.entry["results"][0]["hit_batches"]
        self.assertEqual([x["topic_id"] for x in hits], ["one", "two"])
        self.assertEqual(len({x["id"] for x in hits}), 2)

    def test_repeat_within_same_batch_pauses_without_adding_page_or_result(self):
        a = candidate("repeated")
        h = Harness([page([a], more=True), page([a], index=1, more=True)])
        self.assertEqual(h.run(), "attention")
        self.assertEqual((h.entry["count"], len(h.entry["pages"]), h.entry["next_page"]), (1, 1, 1))
        self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])

    def test_trial_budget_is_two_saved_pages_across_topics_and_never_requests_third(self):
        topics = [{"id": str(i), "label": str(i), "query": f"query {i}"} for i in range(3)]
        h = Harness([page([candidate("a")]), page([candidate("b")])])
        config = configuration(topics=topics, low=2020, high=2020, budget=2)
        self.assertEqual(h.run(config), "trial_complete")
        self.assertEqual(len(h.calls), 2)
        self.assertEqual(h.entry["status"], "ok")
        self.assertEqual(h.entry["stop_reason"], "trial_budget_reached")
        self.assertEqual(h.entry["scholar_summary"]["pending_batches"], 1)
        self.assertTrue(h.entry["scholar_summary"]["trial_complete"])
        self.assertTrue(h.entry["trial_complete"])
        self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])
        self.assertEqual(h.run(config, resumed=True), "trial_complete")
        self.assertEqual(len(h.calls), 2, "resuming a finished trial cannot reset its budget")

    def test_trial_budget_survives_attention_and_resume(self):
        h = Harness([page([candidate("a")], more=True),
                     {"status": "attention", "reason": "verification"},
                     page([candidate("b")], index=1, more=True)])
        config = configuration(budget=2)
        self.assertEqual(h.run(config), "attention")
        self.assertEqual(h.run(config, resumed=True), "trial_complete")
        self.assertEqual(len(h.entry["pages"]), 2)
        self.assertEqual(len(h.calls), 3)
        self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])

    def test_early_trial_end_cannot_be_promoted_to_formal_discovery_complete(self):
        h = Harness([page([candidate("only paper")])])
        self.assertEqual(h.run(configuration(budget=2)), "trial_complete")
        self.assertEqual(h.entry["stop_reason"], "trial_plan_processed")
        self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])
        self.assertEqual(len(h.calls), 1)

    def test_source_limit_saves_rows_then_splits_years_with_global_deduplication(self):
        h = Harness([page([candidate("parent paper")], more=True, source_limit_reached=True),
                     page([candidate("parent paper")]), page([candidate("new paper")])])
        self.assertEqual(h.run(configuration(low=2020, high=2021)), "processed")
        self.assertEqual(h.entry["count"], 2)
        self.assertEqual(len(h.entry["pages"]), 3)
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 1)
        self.assertEqual([(call[0][4], call[0][5]) for call in h.calls], [(2020, 2021), (2020, 2020), (2021, 2021)])
        self.assertEqual([call[1]["page_index"] for call in h.calls], [0, 0, 0])
        self.assertEqual(len(h.entry["results"][0]["hit_batches"]), 2)
        self.assertTrue(any(s["results"] and s["results"][0]["title"] == "parent paper" for s in h.snapshots))

    def test_single_year_limit_becomes_explicit_gap_and_preserves_last_rows(self):
        h = Harness([page([candidate("last visible")], more=True, source_limit_reached=True)])
        self.assertEqual(h.run(configuration(low=2020, high=2020)), "attention")
        self.assertEqual((h.entry["status"], h.entry["count"]), ("attention", 1))
        self.assertEqual(h.entry["scholar_summary"]["coverage_limited_batches"], 1)
        self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])

    def test_verification_does_not_import_stale_rows_or_trigger_partitioning(self):
        h = Harness([{"status": "attention", "reason": "verification", "source_limit_reached": True,
                      "results": [candidate("unverified stale paper")]}])
        self.assertEqual(h.run(), "attention")
        self.assertEqual((h.entry["count"], len(h.entry["pages"])), (0, 0))
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 0)
        self.assertEqual(h.entry["reason"], "verification")

    def test_explicit_cap_attention_keeps_rows_then_partitions(self):
        h = Harness([page([candidate("cap row")], more=True, status="attention",
                          reason="results_unrecognized", source_limit_reached=True),
                     page([candidate("one")]), page([candidate("two")])])
        self.assertEqual(h.run(configuration(low=2020, high=2021)), "processed")
        self.assertEqual(h.entry["count"], 3)
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 1)
        self.assertEqual(len(h.entry["pages"]), 3)

    def test_empty_cap_marker_partitions_without_inventing_saved_page(self):
        h = Harness([{ "status": "attention", "reason": "results_unrecognized",
                       "source_limit_reached": True, "results": [], "page_index": 0},
                     page([candidate("one")]), page([candidate("two")])])
        self.assertEqual(h.run(configuration(low=2020, high=2021)), "processed")
        self.assertEqual(h.entry["count"], 2)
        self.assertEqual(len(h.entry["pages"]), 2)
        self.assertEqual(h.entry["scholar_schedule"]["batches"][0]["pages"], [])

    def test_network_failure_flag_does_not_trigger_partition(self):
        h = Harness([page([candidate("stale")], status="error", reason="source_unavailable",
                          source_limit_reached=True)])
        self.assertEqual(h.run(), "attention")
        self.assertEqual(h.entry["count"], 0)
        self.assertEqual(h.entry["scholar_summary"]["split_batches"], 0)

    def test_network_exception_preserves_cursor_and_returns_attention(self):
        h = Harness([page([candidate("kept")], more=True), RuntimeError("network unavailable")])
        self.assertEqual(h.run(), "attention")
        self.assertEqual((h.entry["count"], h.entry["next_page"]), (1, 1))

    def test_wrong_page_is_not_committed(self):
        h = Harness([page([candidate("wrong page")], index=9)])
        self.assertEqual(h.run(), "attention")
        self.assertEqual((h.entry["count"], len(h.entry["pages"])), (0, 0))

    def test_changed_plan_or_legacy_rows_are_not_silently_mixed(self):
        h = Harness([page([candidate("kept")], more=True), {"status": "attention", "reason": "verification"}])
        self.assertEqual(h.run(), "attention")
        saved = deepcopy(h.entry["results"])
        modified = configuration()
        modified["scholarPlan"]["topics"][0]["query"] = "new query"
        calls = len(h.calls)
        self.assertEqual(h.run(modified, resumed=True), "attention")
        self.assertEqual(h.entry["results"], saved)
        self.assertEqual(len(h.calls), calls)
        legacy = Harness([])
        legacy.entry["results"] = [candidate("old record")]
        legacy.entry["count"] = 1
        self.assertEqual(legacy.run(), "attention")
        self.assertEqual(legacy.entry["count"], 1)
        self.assertFalse(legacy.calls)

    def test_page_metadata_keeps_recovery_and_actual_batch_fields(self):
        h = Harness([page([candidate("a")], recovery={"mode": "direct", "target_page": 0, "cookies": "never store"})])
        self.assertEqual(h.run(), "processed")
        saved_page = h.entry["pages"][0]
        self.assertEqual(set(("batch_id", "page_index", "fingerprint", "returned", "recovery")) - set(saved_page), set())
        self.assertEqual(saved_page["recovery"]["mode"], "direct")
        self.assertNotIn("never store", json.dumps(h.entry))
        self.assertEqual(h.normalizations[0][:2], (2020, 2024))

    def test_invalid_has_next_is_attention_after_preserving_current_rows(self):
        for malformed in (1, {}, "yes"):
            with self.subTest(malformed=malformed):
                h = Harness([page([candidate("kept")], more=malformed)])
                self.assertEqual(h.run(), "attention")
                self.assertEqual((h.entry["count"], h.entry["next_page"]), (1, 1))
                self.assertEqual(len(h.calls), 1)
                self.assertFalse(h.entry["scholar_summary"]["discovery_complete"])

    def test_failed_page_commit_never_requests_following_page(self):
        h = Harness([page([candidate("a")], more=True), page([candidate("b")], index=1)])
        def persist():
            if h.entry["pages"]:
                raise OSError("disk unavailable")
        with self.assertRaises(OSError):
            run_plan(configuration(), Path("unused"), h.entry, resumed=False,
                     fetch=h.fetch, normalize_page=h.normalize, record_keys=identities,
                     page_fingerprint=fingerprint, persist=persist, emit=lambda *args, **kwargs: None)
        self.assertEqual(len(h.calls), 1)


if __name__ == "__main__":
    unittest.main()
