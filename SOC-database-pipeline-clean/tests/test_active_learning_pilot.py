import json
import tempfile
import unittest
from pathlib import Path

from scripts.active_learning_pilot import (
    normalize_candidate,
    rank_candidates,
    load_reviews,
    ingest_reviews,
    create_supervisor_packet,
    validate_supervisor_gate,
    score_candidate,
    select_batch,
    summarize_reviews,
    write_round,
)


class ActiveLearningPilotTests(unittest.TestCase):
    def test_normalize_candidate_defaults_missing_fields(self):
        candidate = normalize_candidate({"candidate_id": "7", "title": "Field trial"})
        self.assertEqual(candidate["candidate_id"], "7")
        self.assertEqual(candidate["status"], "candidate")
        self.assertEqual(candidate["signals"], {})

    def test_score_candidate_uses_configured_signal_weights(self):
        config = {"weights": {"uncertainty": 2.0, "boundary_risk": 1.0, "impact": 1.0}}
        candidate = {
            "candidate_id": "x",
            "signals": {"uncertainty": 0.5, "boundary_risk": 0.25, "impact": 0.25},
        }
        self.assertEqual(score_candidate(candidate, config)["total"], 1.5)

    def test_select_batch_keeps_strata_represented(self):
        candidates = [
            {"candidate_id": "a1", "score": 10, "stratum": "table"},
            {"candidate_id": "a2", "score": 9, "stratum": "table"},
            {"candidate_id": "b1", "score": 1, "stratum": "figure"},
        ]
        selected = select_batch(candidates, batch_size=2, exploration_fraction=0.5, seed=1)
        self.assertEqual({item["stratum"] for item in selected}, {"table", "figure"})

    def test_select_batch_is_deterministic_with_seed(self):
        candidates = [
            {"candidate_id": str(i), "score": i, "stratum": "same"}
            for i in range(5)
        ]
        first = [x["candidate_id"] for x in select_batch(candidates, 3, 0.0, seed=42)]
        second = [x["candidate_id"] for x in select_batch(candidates, 3, 0.0, seed=42)]
        self.assertEqual(first, second)

    def test_write_round_creates_manifest_and_review_template(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = write_round(
                Path(temp_dir),
                "round_01",
                [{"candidate_id": "7", "score": 2.5}],
                "rules_v0.2",
            )
            self.assertTrue(paths["manifest"].exists())
            self.assertTrue(paths["review_template"].exists())
            self.assertIn(
                "rules_v0.2",
                paths["manifest"].read_text(encoding="utf-8"),
            )

    def test_write_round_records_collection_session(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = write_round(
                Path(temp_dir),
                "round_01",
                [{"candidate_id": "7", "score": 2.5}],
                "rules_v0.2",
                collection_session_id="collect_001",
            )
            manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
            self.assertEqual(manifest["session_role"], "collector")
            self.assertEqual(manifest["collection_session_id"], "collect_001")

    def test_supervisor_packet_and_gate_require_distinct_sessions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = write_round(
                root,
                "round_01",
                [{"candidate_id": "7", "score": 2.5}],
                "rules_v0.2",
                collection_session_id="collect_001",
            )
            packet = create_supervisor_packet(paths["manifest"], root / "supervisor", "supervise_001")
            self.assertTrue(packet["prompt"].exists())
            decision = root / "supervisor" / "supervisor_decision.json"
            decision.write_text(
                json.dumps({
                    "session_role": "supervisor",
                    "supervisor_session_id": "supervise_001",
                    "collection_session_id": "collect_001",
                    "decision": "pass",
                    "reasons": ["sample reviewed"],
                }),
                encoding="utf-8",
            )
            result = validate_supervisor_gate(paths["manifest"], decision)
            self.assertEqual(result["decision"], "pass")

    def test_summarize_reviews_reports_decision_and_uncertainty_rates(self):
        reviews = [
            {"candidate_id": "1", "decision": "include", "uncertainty_reason": ""},
            {
                "candidate_id": "2",
                "decision": "needs_review",
                "uncertainty_reason": "layer ambiguity",
            },
        ]
        summary = summarize_reviews(reviews)
        self.assertEqual(summary["total_reviews"], 2)
        self.assertEqual(summary["needs_review_rate"], 0.5)
        self.assertEqual(summary["decision_counts"]["include"], 1)

    def test_round_and_review_metrics_agree_on_selected_ids(self):
        config = {
            "version": "test_v1",
            "strata_fields": ["source_type"],
            "weights": {"uncertainty": 1.0},
        }
        candidates = [
            {"candidate_id": str(i), "title": f"Trial {i}", "source_type": "table" if i < 3 else "figure", "signals": {"uncertainty": i / 5}}
            for i in range(5)
        ]
        ranked = rank_candidates(candidates, config)
        selected = select_batch(ranked, 3, 0.3, seed=3)
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = write_round(Path(temp_dir), "round_01", selected, "rules_v1", ranked_count=len(ranked))
            manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
            reviews = [
                {"candidate_id": item["candidate_id"], "decision": "include"}
                for item in selected[:2]
            ]
            reviews.append({"candidate_id": selected[2]["candidate_id"], "decision": "needs_review", "uncertainty_reason": "boundary"})
            summary = summarize_reviews(reviews)
            self.assertEqual(manifest["selected_ids"], [item["candidate_id"] for item in selected])
            self.assertEqual(summary["total_reviews"], manifest["selected_count"])

    def test_load_reviews_skips_unreviewed_template_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            review_path = Path(temp_dir) / "review_template.csv"
            review_path.write_text(
                "candidate_id,decision,uncertainty_reason\n7,,\n8,include,\n",
                encoding="utf-8",
            )
            reviews = load_reviews(review_path)
            self.assertEqual([row["candidate_id"] for row in reviews], ["8"])

    def test_ingest_reviews_appends_only_completed_reviews(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            review_path = temp / "review.csv"
            review_path.write_text(
                "candidate_id,decision,uncertainty_reason\n7,,\n8,exclude,format\n",
                encoding="utf-8",
            )
            output_path = temp / "reviews.jsonl"
            count = ingest_reviews(
                review_path,
                output_path,
                round_id="round_01",
                reviewer="alice",
                validation_session_id="supervise_001",
            )
            self.assertEqual(count, 1)
            rows = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(rows[0]["candidate_id"], "8")
            self.assertEqual(rows[0]["round_id"], "round_01")
            self.assertEqual(rows[0]["reviewer"], "alice")
            self.assertEqual(rows[0]["validation_session_id"], "supervise_001")


if __name__ == "__main__":
    unittest.main()
