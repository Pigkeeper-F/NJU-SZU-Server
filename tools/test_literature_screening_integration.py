"""Offline guards from current screening through downloads and extraction inputs."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_dedupe as dedupe
import literature_extract as extract
import literature_fulltext as fulltext
import literature_screening as screening
from test_literature_extract import write_job, valid_result
from test_literature_fulltext import FakeFetcher, candidate, write_candidates, read_status, run_stage


POLICY = {"id": "TEST-production-v1", "line": "production", "text": "Original target-animal environmental comparisons and production outcomes."}


def reviews(job, decisions, policy=POLICY):
    records = {}
    for bundle in screening.load_inputs(job):
        key = bundle["paper_id"]
        if key not in decisions:
            continue
        records[key] = {"paper_id": key, "decision": decisions[key], "reason": "Fixture direct evidence.",
                        "exclusionRule": "scope" if decisions[key] == "exclude" else "",
                        **screening.policy_identity(policy), "inputHash": screening.input_hash(bundle),
                        "reviewer": {"type": "codex", "runId": "offline-fixture"},
                        "evidence": [{"source_id": bundle["documents"][0]["source_id"], "field": "title",
                                      "quote": bundle["documents"][0]["title"]}]}
    (job / "screening").mkdir(exist_ok=True)
    (job / "screening/status.json").write_text(json.dumps({"version": screening.VERSION, "records": records, "history": {}}), encoding="utf-8")


def row(key):
    return candidate(key, result_url=f"https://example.invalid/{key}.pdf", source_key="scopus",
                     abstract="Broilers were assigned to thermoneutral and heat stress groups; weight gain was measured.")


class ScreeningDownloadIntegrationTests(unittest.TestCase):
    def test_unscreened_pauses_before_browser_or_saved_state_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory); write_candidates(job, [row("R1")])
            fetcher = FakeFetcher()
            with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("No browser before screening")):
                code, events = run_stage(job, {"screeningPolicy": POLICY}, fetcher=fetcher)
            self.assertEqual(code, 0); self.assertEqual(fetcher.calls, [])
            self.assertEqual(events[-1]["reason"], "screening_required")
            self.assertFalse((job / "fulltext/status.json").exists())

    def test_include_and_pending_download_but_excluded_never_enters_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory); write_candidates(job, [row("R1"), row("R2"), row("R3")])
            reviews(job, {"R1": "include", "R2": "pending", "R3": "exclude"})
            fetcher = FakeFetcher()
            code, _ = run_stage(job, {"screeningPolicy": POLICY}, fetcher=fetcher)
            self.assertEqual(code, 0)
            called = [url for kind, url in fetcher.calls if kind == "fetch_pdf"]
            self.assertEqual(called, ["https://example.invalid/R1.pdf", "https://example.invalid/R2.pdf"])
            items = {item["paper_id"]: item for item in read_status(job)["items"]}
            self.assertEqual(items["R2"]["status"], "fetched_pdf")
            self.assertEqual(items["R2"]["screening_decision"], "pending")
            self.assertFalse(items["R2"]["extraction_allowed"])
            self.assertTrue(items["R1"]["extraction_allowed"])
            self.assertEqual(items["R3"]["screening_decision"], "exclude")
            self.assertFalse((job / "fulltext/files/R3.pdf").exists())

    def test_saved_pdf_survives_changed_decision_but_cannot_bypass_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory); write_candidates(job, [row("R1")])
            reviews(job, {"R1": "include"}); config = {"screeningPolicy": POLICY}
            self.assertEqual(run_stage(job, config, fetcher=FakeFetcher())[0], 0)
            saved = read_status(job)["items"][0]; before = (job / saved["path"]).read_bytes()
            reviews(job, {"R1": "exclude"}); fetcher = FakeFetcher()
            code, _ = run_stage(job, config, fetcher=fetcher, resume=True, retry_unavailable=True)
            self.assertEqual(code, 0); self.assertEqual(fetcher.calls, [])
            current = read_status(job)["items"][0]
            self.assertEqual(current["status"], "fetched_pdf")
            self.assertEqual(current["screening_decision"], "exclude")
            self.assertFalse(current["extraction_allowed"])
            self.assertEqual((job / saved["path"]).read_bytes(), before)
            reviews(job, {"R1": "pending"}); fetcher = FakeFetcher()
            self.assertEqual(run_stage(job, config, fetcher=fetcher, resume=True)[0], 0)
            self.assertFalse(read_status(job)["items"][0]["extraction_allowed"])
            self.assertEqual(fetcher.calls, [])

    def test_stale_dedupe_is_attention_before_browser_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory); write_candidates(job, [row("R1")])
            dedupe.run({}, job); reviews(job, {"R1": "include"})
            write_candidates(job, [row("R1"), row("R2")])
            with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("No browser")):
                code, events = run_stage(job, {"screeningPolicy": POLICY})
            self.assertEqual(code, 0); self.assertEqual(events[-1]["reason"], "screening_required")

    def test_doi_only_fallback_encodes_suffix_and_rejects_non_doi_values(self):
        self.assertEqual(fulltext.candidate_urls({"doi": "https://doi.org/10.1234/a?b#c"}),
                         [("html", "https://doi.org/10.1234/a%3Fb%23c")])
        for bad in ("https://evil.invalid/x", "10.1234/a\nHeader", "10.1/test", "10.1234/"):
            self.assertEqual(fulltext.candidate_urls({"doi": bad}), [])
        target = fulltext._target_from_candidate({**row("R1"), "eid": "2-s2.0-1234", "ut": "WOS:1234"})
        self.assertEqual(target["source_identifiers"]["scopus"], "2-s2.0-1234")


class ScreeningExtractIntegrationTests(unittest.TestCase):
    def make(self, directory, decision="include"):
        job = write_job(Path(directory))
        status = read_status(job); status["items"] = status["items"][:1]
        (job / "fulltext/status.json").write_text(json.dumps(status), encoding="utf-8")
        write_candidates(job, [dict(row("GSC-001"), title="A")])
        reviews(job, {"GSC-001": decision})
        config = extract.load_config(job / "run_config.json"); config["screeningPolicy"] = copy.deepcopy(POLICY)
        return job, config

    def test_current_pending_or_exclude_blocks_even_when_old_status_claims_allowed(self):
        for decision in ("pending", "exclude"):
            with self.subTest(decision=decision), tempfile.TemporaryDirectory() as directory:
                job, config = self.make(directory, decision)
                status = read_status(job); status["items"][0].update(screening_decision="include", extraction_allowed=True)
                (job / "fulltext/status.json").write_text(json.dumps(status), encoding="utf-8")
                result = extract.build_bundles(config, job)
                self.assertEqual(result["counts"]["bundles"], 0)
                self.assertFalse((job / "extraction/inputs/GSC-001.json").exists())

    def test_old_inputs_never_run_after_current_decision_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            job, config = self.make(directory)
            extract.build_bundles(config, job)
            bundle = job / "extraction/inputs/GSC-001.json"; before = bundle.read_bytes()
            (job / "extraction/GSC-001.json").write_text(json.dumps(valid_result("GSC-001")), encoding="utf-8")
            reviews(job, {"GSC-001": "pending"})
            with self.assertRaises(extract.StageError): extract.build_bundles(config, job, force=True)
            report = extract.check_results(job, config)
            self.assertEqual(report["ok"], 0); self.assertEqual(report["failed"], 1)
            self.assertEqual(bundle.read_bytes(), before)

    def test_new_rule_include_requires_rebinding_old_input_and_check_rejects_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            job, config = self.make(directory)
            extract.build_bundles(config, job)
            (job / "extraction/GSC-001.json").write_text(json.dumps(valid_result("GSC-001")), encoding="utf-8")
            config["screeningPolicy"]["text"] += " Rule changed."
            reviews(job, {"GSC-001": "include"}, config["screeningPolicy"])
            with self.assertRaises(extract.StageError): extract.build_bundles(config, job)
            self.assertEqual(extract.check_results(job, config)["failed"], 1)
            extract.build_bundles(config, job, force=True)
            bundle = json.loads((job / "extraction/inputs/GSC-001.json").read_text(encoding="utf-8"))
            self.assertEqual(bundle["screening"]["policyHash"], screening.policy_identity(config["screeningPolicy"])["policyHash"])

    def test_fulltext_human_candidate_selection_stays_non_extractable(self):
        with tempfile.TemporaryDirectory() as directory:
            job, config = self.make(directory)
            binding = {"paper_id": "GSC-001", "screening_decision": "include", "extraction_allowed": False,
                       "requires_fulltext_eligibility": True}
            with patch.object(extract, "gate_targets", return_value={"targets": [binding], "excluded": [], "pending": [], "unscreened": []}):
                self.assertEqual(extract.build_bundles(config, job)["counts"]["bundles"], 0)

    def test_missing_or_outdated_screening_pauses_prepare_and_check(self):
        with tempfile.TemporaryDirectory() as directory:
            job, config = self.make(directory)
            extract.build_bundles(config, job)
            config["screeningPolicy"]["text"] += " Updated policy without a new review."
            with self.assertRaises(extract.StageError): extract.build_bundles(config, job, force=True)
            with self.assertRaises(extract.StageError): extract.check_results(job, config)

    def test_current_input_cannot_legitimize_an_old_unbound_result(self):
        with tempfile.TemporaryDirectory() as directory:
            job, config = self.make(directory)
            extract.build_bundles(config, job)
            bundle = json.loads((job / "extraction/inputs/GSC-001.json").read_text(encoding="utf-8"))
            result = valid_result("GSC-001")
            target = job / "extraction/GSC-001.json"
            target.write_text(json.dumps(result), encoding="utf-8")
            self.assertEqual(extract.check_results(job, config)["failed"], 1)
            result["screening"] = bundle["screening"]
            target.write_text(json.dumps(result), encoding="utf-8")
            self.assertEqual(extract.check_results(job, config)["ok"], 1)


if __name__ == "__main__":
    unittest.main()
