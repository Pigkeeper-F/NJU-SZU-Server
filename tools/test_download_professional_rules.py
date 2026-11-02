"""Synthetic offline fixtures for confirmed download rules; no downloads occur."""
import csv
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("download_verification", Path(__file__).with_name("download_verification.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class ProfessionalRulesTest(unittest.TestCase):
    def setUp(self):
        self.fixture_parent = Path(__file__).resolve().parents[1] / ".workbench" / "test-fixtures"
        self.fixture_parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="professional-rules-", dir=self.fixture_parent)
        self.root = Path(self.temp.name)
        self.hashes = {}

    def tearDown(self):
        for path, value in self.hashes.items():
            self.assertEqual(engine.file_sha(path), value, "专业规则核验不得修改原件")
        resolved = Path(engine.local_path(self.root)).resolve()
        self.assertEqual(resolved.parent, Path(engine.local_path(self.fixture_parent)).resolve())
        self.assertTrue(resolved.name.startswith("professional-rules-"))
        shutil.rmtree(resolved)
        self.temp.cleanup()

    def table(self, name, rows, columns=("id", "item", "unit", "value"), delimiter=","):
        path = Path(engine.local_path(self.root / name))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle, delimiter=delimiter)
            writer.writerow(columns)
            writer.writerows(rows)
        self.hashes[path] = engine.file_sha(path)
        return {"path": str(path), "name": name, "sha256": self.hashes[path]}

    def rule(self, kind, **extra):
        return {"id": "R1", "label": "已确认规则", "kind": kind, "basis": "研究者确认的模型输入要求",
                "sourceText": "仅检查，保留原值", **extra}

    def verify(self, rules, files=None, baseline=None):
        files = files if files is not None else [self.table("data.csv", [["1", "wheat", "t", "12.00"], ["2", "rice", "kg", "5"]])]
        return engine.verify_download({"current": {"files": files, "professionalRules": {"schema": 1, "rules": rules}},
                                       "baseline": baseline, "outputDir": str(self.root / "evidence")})

    def check(self, result, index=0):
        return result["professionalChecks"][index]

    def professional_issues(self, result):
        return [issue for issue in result["issues"] if issue.get("ruleId")]

    def evidence(self, check):
        return [json.loads(line) for line in Path(engine.local_path(check["evidenceFile"]["path"])).read_text(encoding="utf-8").splitlines()]

    def test_no_rules_do_not_invent_checks_or_thresholds(self):
        result = self.verify([])
        self.assertEqual(result["professionalChecks"], [])
        self.assertEqual(self.professional_issues(result), [])

    def test_all_supported_rules_really_execute_and_pass(self):
        rules = [self.rule("required_columns", id="columns", columns=["id", "value"]),
                 self.rule("not_empty", id="empty", column="id"),
                 self.rule("allowed_values", id="units", column="unit", allowed=["t", "kg"]),
                 self.rule("numeric_range", id="range", column="value", min="0", max="20"),
                 self.rule("unique_key", id="keys", columns=["id"]),
                 self.rule("row_count", id="count", min=2, max=2)]
        result = self.verify(rules)
        self.assertEqual([check["status"] for check in result["professionalChecks"]], ["passed"] * 6)
        self.assertTrue(all(check["checkedRows"] == 2 for check in result["professionalChecks"]))
        self.assertEqual(self.professional_issues(result), [])

    def test_required_columns_checks_each_file_not_just_first(self):
        files = [self.table("good.csv", [["1", "a", "t", "1"]]), self.table("missing.csv", [["2", "a"]], ["id", "item"])]
        result = self.verify([self.rule("required_columns", columns=["value"])], files)
        check = self.check(result)
        self.assertEqual(check["status"], "needs_decision")
        missing = next(row for row in self.evidence(check) if row["type"] == "missing-columns")
        self.assertEqual(missing["file"], "missing.csv")
        self.assertEqual(missing["missingColumns"], ["value"])

    def test_not_empty_checks_whitespace_and_retains_line_original(self):
        files = [self.table("empty.tsv", [["1", "a", "t", "  "], ["2", "b", "t", "5"]], delimiter="\t")]
        result = self.verify([self.rule("not_empty", column="value")], files)
        check = self.check(result)
        self.assertEqual((check["checkedRows"], check["failedRows"]), (2, 1))
        sample = check["samples"][0]
        self.assertEqual((sample["file"], sample["line"], sample["values"]["value"]), ("empty.tsv", 2, "  "))
        issue = self.professional_issues(result)[0]
        self.assertEqual(issue["severity"], "warning")
        self.assertTrue(issue["requiresDecision"])
        self.assertEqual(issue["evidence"]["basis"], "研究者确认的模型输入要求")

    def test_allowed_values_are_exact_text_not_guessed_codes_or_units(self):
        files = [self.table("text.csv", [["1", "a", "t", "1"], ["2", "a", "T", "2"], ["3", "a", " t", "3"]])]
        result = self.verify([self.rule("allowed_values", column="unit", allowed=["t"])], files)
        self.assertEqual(self.check(result)["failedRows"], 2)
        self.assertEqual([row["values"]["unit"] for row in self.check(result)["samples"]], ["T", " t"])

    def test_when_is_and_across_columns_or_within_values(self):
        rows = [["1", "a", "t", "1"], ["2", "b", "t", "2"], ["3", "a", "kg", "-9"], ["4", "c", "t", "-8"]]
        result = self.verify([self.rule("numeric_range", column="value", min="0", when={"item": ["a", "b"], "unit": ["t"]})], [self.table("conditional.csv", rows)])
        self.assertEqual((self.check(result)["status"], self.check(result)["checkedRows"]), ("passed", 2))

    def test_zero_matching_rows_is_not_vacuous_success(self):
        result = self.verify([self.rule("allowed_values", column="unit", allowed=["t"], when={"item": ["unknown"]})])
        check = self.check(result)
        self.assertEqual((check["status"], check["checkedRows"]), ("needs_decision", 0))
        self.assertIn("零匹配", check["reason"])

    def test_missing_condition_column_cannot_silently_skip_file(self):
        result = self.verify([self.rule("numeric_range", column="value", min=0, when={"unknown column": ["x"]})])
        check = self.check(result)
        self.assertEqual(check["status"], "needs_decision")
        self.assertIn("unknown column", check["samples"][0]["missingColumns"])

    def test_numeric_range_uses_decimal_without_float_rounding(self):
        exact = "0.1000000000000000000000000001"
        next_value = "0.1000000000000000000000000002"
        files = [self.table("decimal.csv", [["1", "a", "t", exact], ["2", "a", "t", next_value]])]
        result = self.verify([self.rule("numeric_range", column="value", max=exact)], files)
        self.assertEqual(self.check(result)["failedRows"], 1)
        self.assertEqual(self.check(result)["samples"][0]["values"]["value"], next_value)

    def test_numeric_empty_nan_infinity_and_formatted_text_are_undetermined(self):
        originals = ["", " ", "NaN", "Infinity", "-Infinity", "1,000", "1_000", "12 kg", "不详"]
        files = [self.table("invalid.csv", [[str(index), "a", "t", value] for index, value in enumerate(originals)])]
        result = self.verify([self.rule("numeric_range", column="value", min="0")], files)
        check = self.check(result)
        self.assertEqual(check["failedRows"], len(originals))
        self.assertTrue(all(sample["type"] == "numeric-undetermined" for sample in check["samples"]))
        self.assertEqual([sample["values"]["value"] for sample in check["samples"]], originals)

    def test_unique_key_detects_cross_file_duplicates_with_both_locations(self):
        files = [self.table("a.csv", [["001", "a", "t", "1"]]), self.table("b.csv", [["001", "b", "t", "2"], ["1", "b", "t", "2"]])]
        result = self.verify([self.rule("unique_key", columns=["id"])], files)
        check = self.check(result)
        self.assertEqual((check["checkedRows"], check["failedRows"]), (3, 2))
        self.assertEqual([sample["file"] for sample in check["samples"]], ["a.csv", "b.csv"])
        self.assertTrue(all(sample["key"] == ["001"] for sample in check["samples"]))

    def test_unique_key_blank_or_missing_column_is_needs_decision(self):
        result = self.verify([self.rule("unique_key", columns=["id"])], [self.table("empty.csv", [[" ", "a", "t", "1"]])])
        self.assertEqual(self.check(result)["samples"][0]["type"], "empty-key")
        result = self.verify([self.rule("unique_key", columns=["not supplied"])])
        self.assertEqual(self.check(result)["status"], "needs_decision")

    def test_row_count_checks_exact_condition_count_and_zero_not_passed(self):
        result = self.verify([self.rule("row_count", min=2, max=2, when={"unit": ["t"]})])
        sample = self.check(result)["samples"][0]
        self.assertEqual((sample["type"], sample["actualRows"]), ("row-count-outside-range", 1))
        result = self.verify([self.rule("row_count", min=0, when={"unit": ["unseen"]})])
        self.assertEqual(self.check(result)["status"], "needs_decision")

    def test_unsupported_and_failed_files_prevent_partial_pass(self):
        pdf = self.root / "table.pdf"
        pdf.write_bytes(b"%PDF-1.7\nnot parsed table\n%%EOF")
        self.hashes[pdf] = engine.file_sha(pdf)
        good = self.table("good.csv", [["1", "a", "t", "1"]])
        result = self.verify([self.rule("row_count", min=1, max=1)], [good, {"path": str(pdf), "name": pdf.name}])
        self.assertEqual(self.check(result)["status"], "needs_decision")
        self.assertEqual(self.check(result)["checkedRows"], 1)
        result = self.verify([self.rule("required_columns", columns=["id"])], [{"path": str(self.root / "absent.csv"), "name": "absent.csv"}])
        self.assertEqual(self.check(result)["status"], "needs_decision")

    def test_manual_unknown_ambiguous_and_invalid_rules_are_never_ignored(self):
        rules = [self.rule("manual", id="M", reason="专业合理性需确认"), self.rule("guess", id="U"),
                 self.rule("numeric_range", id="N", column="value"),
                 self.rule("numeric_range", id="R", column="value", min=10, max=1),
                 self.rule("allowed_values", id="A", column="unit", allowed="t"),
                 {"id": "B", "kind": "not_empty", "column": "id"}, "未解析的规则文本",
                 self.rule([], id="bad-kind")]
        result = self.verify(rules)
        self.assertEqual(len(self.professional_issues(result)), len(rules))
        self.assertTrue(all(check["status"] == "needs_decision" for check in result["professionalChecks"]))

    def test_invalid_envelope_and_duplicate_ids_are_explicit_decisions(self):
        file = self.table("valid.csv", [["1", "a", "t", "1"]])
        result = engine.verify_download({"current": {"files": [file], "professionalRules": {"schema": 999, "rules": []}}, "outputDir": str(self.root / "evidence")})
        self.assertEqual(self.check(result)["status"], "needs_decision")
        result = self.verify([self.rule("not_empty", column="id"), self.rule("not_empty", column="id")], [file])
        self.assertEqual([check["status"] for check in result["professionalChecks"]], ["passed", "needs_decision"])
        self.assertNotEqual(self.check(result)["id"], self.check(result, 1)["id"])

    def test_full_evidence_is_preserved_beyond_ten_preview_rows(self):
        rows = [[str(index), "a", "wrong", "1"] for index in range(27)]
        result = self.verify([self.rule("allowed_values", column="unit", allowed=["t"])], [self.table("all.csv", rows)])
        check = self.check(result)
        self.assertEqual((check["failedRows"], len(check["samples"])), (27, 10))
        events = self.evidence(check)
        self.assertEqual(sum(event["type"] == "disallowed-value" for event in events), 27)
        self.assertIn(check["evidenceFile"], result["evidenceFiles"])

    def test_professional_rules_apply_current_only_not_old_values(self):
        current = self.table("current.csv", [["1", "a", "t", "5"]])
        baseline = self.table("baseline.csv", [["1", "a", "t", "-9"]])
        result = self.verify([self.rule("numeric_range", column="value", min=0)], [current], {"files": [baseline]})
        self.assertEqual((self.check(result)["status"], self.check(result)["checkedRows"]), ("passed", 1))
        self.assertEqual(result["comparison"]["summary"]["removed"], 1)

    def test_no_files_cannot_pass_required_columns(self):
        result = self.verify([self.rule("required_columns", columns=["id"])], [])
        self.assertEqual(self.check(result)["status"], "needs_decision")

    def test_windows_long_input_and_evidence_paths_use_existing_extended_path_support(self):
        name = "/".join(["专业规则长路径" * 4] * 5 + ["data.csv"])
        file = self.table(name, [["1", "a", "t", "1"]])
        result = self.verify([self.rule("not_empty", column="value")], [file])
        self.assertEqual(self.check(result)["status"], "passed")


if __name__ == "__main__":
    unittest.main()
