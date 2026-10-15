from __future__ import annotations

import contextlib
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import literature_dedupe as dedupe

SOC_SCRIPTS = Path(__file__).resolve().parents[1] / "SOC-database-pipeline-clean" / "scripts"


def _record(candidate_id: str, title: str, **extra: object) -> dict:
    record = {
        "candidate_id": candidate_id,
        "title": title,
        "screening_status": "pending_review",
        "evidence_level": "search_result_snippet",
    }
    record.update(extra)
    return record


def _write_candidates(root: Path, records: list[dict], **header: object) -> Path:
    report = {
        "version": 2, "source": "Google Scholar", "query": "demo query",
        "count": len(records), "caution": "Search snippets are not verified abstracts or full text; all records await screening.",
        **header, "records": records,
    }
    path = root / "candidates.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _run_captured(root: Path, **options: object):
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        code = dedupe.run({"query": "demo query", "sources": ["google-scholar"]}, root, **options)
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
    return code, events


class DedupeMergeTest(unittest.TestCase):
    def test_doi_exact_merges_same_paper_across_sources_and_batches(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = _record("GSC-001", "Climate effects on aquaculture",
                            doi="10.1016/j.aquaculture.2019.01.001", source_key="google-scholar", batch_index=1)
            second = _record("GSC-B2-003", "Climate effects on aquaculture",
                             doi="https://doi.org/10.1016/J.AQUACULTURE.2019.01.001", source_key="cnki", batch_index=2)
            _write_candidates(root, [first, second])

            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            self.assertEqual(events[0], {"type": "stage", "stage": "dedupe", "message": "对累计候选执行跨来源归并去重"})
            result = events[-1]
            self.assertEqual(result["type"], "result")
            self.assertEqual(result["stage"], "dedupe")
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["counts"], {"records_in": 2, "groups": 1, "merged": 1, "needs_review_groups": 0})
            self.assertEqual(result["files"], ["dedupe/dedupe.json", "dedupe/dedupe.csv"])

            document = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))
            self.assertEqual(document["version"], 1)
            self.assertEqual(document["threshold"], 0.55)
            self.assertEqual(len(document["groups"]), 1)
            group = document["groups"][0]
            self.assertEqual(group["canonical_id"], "GSC-001")
            self.assertEqual(group["candidate_ids"], ["GSC-001", "GSC-B2-003"])
            self.assertEqual(group["sources"], ["google-scholar", "cnki"])
            self.assertEqual(group["merge_confidence"], "exact")
            self.assertEqual(group["merge_reason"], "doi_exact")
            self.assertEqual(group["max_score"], 1.0)
            self.assertFalse(group["needs_review"])
            self.assertEqual(group["doi"], "10.1016/j.aquaculture.2019.01.001")

            canonical, member = group["records"]
            self.assertEqual(canonical["screening_status"], "pending_review")
            self.assertEqual(member["screening_status"], "auto_excluded_duplicate")
            self.assertIn("GSC-001", member["screening_reason"])
            # Every original field of the member record is retained verbatim;
            # the only overrides are the two contract-mandated screening fields.
            for key, value in second.items():
                if key == "screening_status":
                    continue
                self.assertEqual(member[key], value, key)
            self.assertEqual(set(member) - set(second), {"screening_reason"})
            self.assertEqual(member["candidate_id"], "GSC-B2-003")

    def test_normalized_title_substring_hit_is_exact_merge(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "Climate Effects on Aquaculture", source_key="google-scholar", batch_index=1),
                _record("GSC-B2-001", "Climate effects on aquaculture: a meta-analysis",
                        source_key="google-scholar", batch_index=2),
            ])
            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            group = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))["groups"][0]
            self.assertEqual(group["candidate_ids"], ["GSC-001", "GSC-B2-001"])
            self.assertEqual(group["merge_confidence"], "exact")
            self.assertEqual(group["merge_reason"], "title_substring")
            self.assertEqual(group["max_score"], 0.95)
            self.assertFalse(group["needs_review"])
            self.assertEqual(group["records"][1]["screening_status"], "auto_excluded_duplicate")

    def test_cjk_bigram_jaccard_hit_is_probable_and_never_silent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "土壤有机碳固存与团聚体", source_key="google-scholar", batch_index=1),
                _record("GSC-002", "土壤有机碳固存及团聚体", source_key="google-scholar", batch_index=1),
            ])
            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            document = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))
            group = document["groups"][0]
            self.assertEqual(group["candidate_ids"], ["GSC-001", "GSC-002"])
            self.assertEqual(group["merge_confidence"], "probable")
            self.assertEqual(group["merge_reason"], "title_jaccard")
            self.assertGreaterEqual(group["max_score"], 0.55)
            self.assertTrue(group["needs_review"])
            # probable merges must not silently exclude anyone
            for member in group["records"]:
                self.assertEqual(member["screening_status"], "pending_review")
            self.assertEqual(document["counts"]["needs_review_groups"], 1)

    def test_threshold_option_controls_probable_merging(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "土壤有机碳固存与团聚体", source_key="google-scholar", batch_index=1),
                _record("GSC-002", "土壤有机碳固存及团聚体", source_key="google-scholar", batch_index=1),
            ])
            groups = dedupe.group_records(dedupe.load_candidates(root)[1], threshold=0.9)
            self.assertEqual(len(groups), 2)
            groups = dedupe.group_records(dedupe.load_candidates(root)[1], threshold=0.55)
            self.assertEqual(len(groups), 1)

    def test_distinct_papers_are_not_false_merged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "Soil organic carbon in paddy soils", doi="10.1/a", source_key="google-scholar", batch_index=1),
                _record("GSC-002", "Soil organic carbon dynamics in forests", doi="10.1/b", source_key="google-scholar", batch_index=1),
                _record("GSC-003", "海洋鱼类群落结构变化", source_key="google-scholar", batch_index=1),
                _record("GSC-004", "农田氮磷流失特征", source_key="google-scholar", batch_index=1),
            ])
            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            document = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))
            self.assertEqual(document["counts"], {"records_in": 4, "groups": 4, "merged": 0, "needs_review_groups": 0})
            for group in document["groups"]:
                self.assertEqual(len(group["candidate_ids"]), 1)
                self.assertEqual(group["merge_reason"], "")
                self.assertEqual(group["max_score"], 0.0)
                self.assertFalse(group["needs_review"])
                self.assertEqual(group["records"][0]["screening_status"], "pending_review")
            self.assertEqual(events[-1]["count"], 4)

    def test_canonical_prefers_earliest_batch_even_when_json_order_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # batch 2 record stored BEFORE the batch 1 record in the JSON array
            _write_candidates(root, [
                _record("GSC-B2-009", "Sea surface temperature reconstruction", doi="10.2/x", source_key="cnki", batch_index=2),
                _record("GSC-005", "Sea surface temperature reconstruction", doi="10.2/x", source_key="google-scholar", batch_index=1),
            ])
            groups = dedupe.group_records(dedupe.load_candidates(root)[1])
            self.assertEqual(groups[0]["canonical_id"], "GSC-005")
            self.assertEqual(groups[0]["candidate_ids"], ["GSC-005", "GSC-B2-009"])

    def test_rerun_is_idempotent_and_covers_batch_retry_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "Remote sensing of coastal wetlands", doi="10.3/a", source_key="google-scholar", batch_index=1),
                _record("GSC-002", "Nitrogen cycling in estuaries", doi="10.3/b", source_key="google-scholar", batch_index=1),
                # interrupted re-run re-fetched batch 1 as batch 2 (new ids, same papers)
                _record("GSC-B2-001", "Remote sensing of coastal wetlands", doi="10.3/a", source_key="google-scholar", batch_index=2),
            ])
            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["counts"], {"records_in": 3, "groups": 2, "merged": 1, "needs_review_groups": 0})
            csv_bytes_first = (root / "dedupe" / "dedupe.csv").read_bytes()
            json_first = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))

            code, events = _run_captured(root)
            self.assertEqual(code, 0)
            csv_bytes_second = (root / "dedupe" / "dedupe.csv").read_bytes()
            json_second = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))

            self.assertEqual(csv_bytes_first, csv_bytes_second)
            json_first.pop("generated_at"), json_second.pop("generated_at")
            self.assertEqual(json_first, json_second)

            group = json_second["groups"][0]
            self.assertEqual(group["candidate_ids"], ["GSC-001", "GSC-B2-001"])
            self.assertEqual(group["merge_confidence"], "exact")
            self.assertEqual(group["records"][1]["screening_reason"], "duplicate of GSC-001")

    def test_csv_shape_and_screening_records_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _write_candidates(root, [
                _record("GSC-001", "Climate effects on aquaculture", doi="10.4/a", source_key="google-scholar", batch_index=1),
                _record("GSC-B2-002", "Climate effects on aquaculture", doi="10.4/a", source_key="cnki", batch_index=2),
                _record("GSC-003", "土壤有机碳固存与团聚体", source_key="google-scholar", batch_index=1),
                _record("GSC-004", "土壤有机碳固存及团聚体", source_key="google-scholar", batch_index=1),
            ])
            code, _ = _run_captured(root)
            self.assertEqual(code, 0)
            raw = (root / "dedupe" / "dedupe.csv").read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "CSV must be utf-8-sig")
            with open(root / "dedupe" / "dedupe.csv", encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(list(rows[0].keys()), list(dedupe.CSV_COLUMNS))
            self.assertEqual(len(rows), 2)
            first = rows[0]
            self.assertEqual(first["canonical_id"], "GSC-001")
            self.assertEqual(first["merged_count"], "1")
            self.assertEqual(first["merge_confidence"], "exact")
            self.assertEqual(first["sources"], "google-scholar|cnki")
            self.assertEqual(first["needs_review"], "false")
            second = rows[1]
            self.assertEqual(second["merge_confidence"], "probable")
            self.assertEqual(second["needs_review"], "true")
            self.assertEqual(second["merged_count"], "1")

            # screening records are retained (nothing dropped) and all ids kept exactly once
            document = json.loads((root / "dedupe" / "dedupe.json").read_text(encoding="utf-8"))
            all_ids = [cid for group in document["groups"] for cid in group["candidate_ids"]]
            self.assertCountEqual(all_ids, ["GSC-001", "GSC-B2-002", "GSC-003", "GSC-004"])
            by_id = {record["candidate_id"]: record for group in document["groups"] for record in group["records"]}
            self.assertEqual(by_id["GSC-B2-002"]["screening_status"], "auto_excluded_duplicate")
            self.assertEqual(by_id["GSC-003"]["screening_status"], "pending_review")
            self.assertEqual(by_id["GSC-004"]["screening_status"], "pending_review")


class DedupeCliTest(unittest.TestCase):
    def test_missing_candidates_reports_frozen_error_message(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "run_config.json"
            config.write_text(json.dumps({"query": "demo query", "sources": ["google-scholar"]}), encoding="utf-8")
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                code = dedupe.main(["--config", str(config), "--output-dir", str(root / "job")])
            self.assertEqual(code, 1)
            events = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
            self.assertEqual(events, [{"type": "error", "message": "尚未完成候选检索"}])

    def test_cli_end_to_end_ndjson_and_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp) / "job"
            job.mkdir()
            _write_candidates(job, [
                _record("GSC-001", "Ecosystem services of mangroves", doi="10.5/a", source_key="google-scholar", batch_index=1),
                _record("GSC-002", "Mangrove ecosystem services assessment", source_key="google-scholar", batch_index=1),
            ])
            config = job / "run_config.json"
            config.write_text(json.dumps({"query": "mangrove services", "sources": ["google-scholar"]}), encoding="utf-8")
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
            process = subprocess.run(
                [sys.executable, "-u", str(TOOLS / "literature_dedupe.py"),
                 "--config", str(config), "--output-dir", str(job), "--resume"],
                capture_output=True, text=True, encoding="utf-8", env=env, cwd=temp,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertNotIn("Traceback", process.stderr)
            lines = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
            self.assertEqual(lines[0]["type"], "stage")
            self.assertEqual(lines[0]["stage"], "dedupe")
            self.assertEqual(lines[-1]["type"], "result")
            self.assertEqual(lines[-1]["stage"], "dedupe")
            self.assertIn("count", lines[-1])
            self.assertIn("counts", lines[-1])
            self.assertTrue((job / "dedupe" / "dedupe.json").is_file())
            self.assertTrue((job / "dedupe" / "dedupe.csv").is_file())


class V3PapersIndexImportTest(unittest.TestCase):
    """V3: verify importing SOC papers_index pure functions has no harmful side effects."""

    def test_import_side_effects_are_stdout_reconfigure_and_pycache_only(self) -> None:
        probe = (
            "import json, os, sys\n"
            f"soc = r'{SOC_SCRIPTS}'\n"
            "before_files = set(os.listdir(soc))\n"
            "before_encoding = getattr(sys.stdout, 'encoding', None)\n"
            "sys.path.insert(0, soc)\n"
            "import papers_index\n"
            "after_files = set(os.listdir(soc))\n"
            "print(json.dumps({\n"
            "  'new_entries': sorted(after_files - before_files),\n"
            "  'before_encoding': before_encoding,\n"
            "  'after_encoding': getattr(sys.stdout, 'encoding', None),\n"
            "  'same_title_jaccard': papers_index.jaccard(papers_index.tokens('土壤有机碳固存'), papers_index.tokens('土壤有机碳固存')),\n"
            "  'normalize': papers_index.normalize(' 土壤 有机碳 Carbon: Storage! '),\n"
            "}, ensure_ascii=True))\n"
        )
        env = {key: value for key, value in os.environ.items() if key not in ("PYTHONUTF8", "PYTHONIOENCODING")}
        process = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True,
                                 encoding="utf-8", env=env, cwd=tempfile.gettempdir())
        self.assertEqual(process.returncode, 0, process.stderr)
        report = json.loads(process.stdout.strip().splitlines()[-1])
        # only the unavoidable bytecode cache may appear; no data files, no config writes
        self.assertTrue(set(report["new_entries"]) <= {"__pycache__"}, report["new_entries"])
        # measured side effect: papers_index reconfigures sys.stdout to utf-8 at import time
        if hasattr(sys.stdout, "reconfigure"):
            self.assertEqual(report["after_encoding"], "utf-8")
        self.assertEqual(report["same_title_jaccard"], 1.0)
        self.assertEqual(report["normalize"], "土壤 有机碳 carbon storage")

    def test_module_reexports_papers_index_pure_functions(self) -> None:
        left = dedupe.tokens("土壤有机碳固存与团聚体")
        right = dedupe.tokens("土壤有机碳固存及团聚体")
        self.assertGreater(dedupe.jaccard(left, right), 0.55)
        self.assertEqual(dedupe.normalize("The Effects: of Soil!"), "the effects of soil")
        self.assertEqual(dedupe.normalize_doi("https://doi.org/10.1000/XYZ"), "10.1000/xyz")
        self.assertEqual(dedupe.normalize_doi("doi:10.1000/XYZ"), "10.1000/xyz")
        self.assertEqual(dedupe.normalize_doi(None), "")


if __name__ == "__main__":
    unittest.main()
