"""Read-only gates tested against isolated, explicit screening fixtures."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import literature_dedupe as dedupe
import literature_screening as screening


POLICY = {"id": "TEST-P-v1", "line": "production", "text": "Target animals, environmental contrast and production outcomes."}


class ScreeningGateTests(unittest.TestCase):
    def make(self, directory, decision="include", abstract="Thermoneutral and heat stress groups were compared."):
        job = Path(directory)
        records = [{"candidate_id": "R1", "source_key": "scopus", "title": "Heat stress and growth", "abstract": abstract, "keywords": ["growth"]}]
        (job / "candidates.json").write_text(json.dumps({"records": records}), encoding="utf-8")
        bundle = screening.load_inputs(job)[0]
        review = {"paper_id": "R1", "decision": decision, "reason": "Explicit evidence.", "exclusionRule": "target mismatch" if decision == "exclude" else "",
                  **screening.policy_identity(POLICY), "inputHash": screening.input_hash(bundle),
                  "reviewer": {"type": "codex", "runId": "mock"},
                  "evidence": [{"source_id": "R1", "field": "title", "quote": "Heat stress"}]}
        (job / "screening").mkdir()
        self.save(job, review)
        return job, review

    def save(self, job, review):
        (job / "screening/status.json").write_text(json.dumps({"version": screening.VERSION, "records": {"R1": review}, "history": {}}), encoding="utf-8")

    def test_pending_downloads_but_excludes_and_unscreened_never_enter_queue(self):
        for decision in ("include", "pending", "exclude"):
            with self.subTest(decision=decision), tempfile.TemporaryDirectory() as temp:
                job, _ = self.make(temp, decision)
                result = screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)
                self.assertEqual(result["unscreened"], [])
                if decision == "exclude":
                    self.assertEqual(result["targets"], [])
                    self.assertEqual(result["excluded"], ["R1"])
                else:
                    self.assertEqual(result["targets"][0]["extraction_allowed"], decision == "include")

    def test_missing_abstract_cannot_support_automatic_include_or_exclude(self):
        for decision in ("include", "exclude"):
            with self.subTest(decision=decision), tempfile.TemporaryDirectory() as temp:
                job, _ = self.make(temp, decision, abstract="")
                result = screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)
                self.assertEqual(result["unscreened"], ["R1"])
                self.assertEqual(result["excluded"], [])

    def test_missing_abstract_rule_accepts_only_pending_and_never_enables_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            job, review = self.make(temp, "pending", abstract="")
            review.update(reviewer={"type": "rule", "ruleId": "missing-full-abstract-v1"}, extraction_allowed=False)
            self.save(job, review)
            gated = screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)
            self.assertEqual(gated["pending"], ["R1"])
            self.assertFalse(gated["targets"][0]["extraction_allowed"])
            for change in ({"decision": "include"}, {"extraction_allowed": True},
                           {"reviewer": {"type": "rule", "ruleId": "arbitrary-rule"}}):
                self.save(job, {**review, **change})
                self.assertEqual(screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)["unscreened"], ["R1"])
            data = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
            data["records"][0]["abstract"] = "Full abstract has now been acquired."
            (job / "candidates.json").write_text(json.dumps(data), encoding="utf-8")
            review["inputHash"] = screening.input_hash(screening.load_inputs(job)[0])
            self.save(job, review)
            self.assertEqual(screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)["unscreened"], ["R1"])

    def test_policy_line_input_and_fabricated_quote_invalidate_prior_review(self):
        for variation in ("line", "rule", "input", "quote", "reviewer"):
            with self.subTest(variation=variation), tempfile.TemporaryDirectory() as temp:
                job, review = self.make(temp, "exclude")
                policy = copy.deepcopy(POLICY)
                if variation == "line": policy["line"] = "emission"
                if variation == "rule": policy["text"] += " Updated boundary."
                if variation == "input":
                    data = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
                    data["records"][0]["abstract"] += " Additional qualifying experiment."
                    (job / "candidates.json").write_text(json.dumps(data), encoding="utf-8")
                if variation == "quote": review["evidence"][0]["quote"] = "Not in this source"
                if variation == "reviewer": review["reviewer"] = {"type": "automatic_keyword_rule"}
                self.save(job, review)
                self.assertEqual(screening.gate_targets(job, [{"paper_id": "R1"}], policy)["unscreened"], ["R1"])

    def test_stale_dedupe_blocks_reading_an_incomplete_old_set(self):
        with tempfile.TemporaryDirectory() as temp:
            job, _ = self.make(temp)
            dedupe.run({"query": "test"}, job)
            self.assertEqual(len(screening.load_inputs(job)), 1)
            data = json.loads((job / "candidates.json").read_text(encoding="utf-8"))
            data["records"].append({**data["records"][0], "candidate_id": "R2", "title": "Another paper"})
            (job / "candidates.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(screening.ScreeningAttention): screening.load_inputs(job)

    def test_unconfigured_old_tasks_remain_unchanged(self):
        targets = [{"paper_id": "old"}]
        result = screening.gate_targets(Path("unused"), targets, None)
        self.assertIs(result["targets"], targets)

    def test_invalid_configured_policy_is_not_legacy(self):
        for policy in ({}, [], "", False):
            with self.subTest(policy=policy), self.assertRaises(screening.ScreeningAttention):
                screening.gate_targets(Path("unused"), [], policy)

    def test_invalid_state_and_reviewer_never_enable_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            job, review = self.make(temp)
            review["reviewer"] = {"type": "human", "name": "Researcher"}
            self.save(job, review)
            self.assertTrue(screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)["targets"][0]["extraction_allowed"])
            (job / "screening/status.json").write_text(json.dumps({"version": screening.VERSION, "records": []}), encoding="utf-8")
            self.assertEqual(screening.gate_targets(job, [{"paper_id": "R1"}], POLICY)["unscreened"], ["R1"])


if __name__ == "__main__":
    unittest.main()
