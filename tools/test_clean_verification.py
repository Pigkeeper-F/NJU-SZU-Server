"""Synthetic offline cleaning-verification fixtures. Never run cleaning code."""
import csv
import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("clean_verification", Path(__file__).with_name("clean_verification.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class CleanVerificationTest(unittest.TestCase):
    def setUp(self):
        self.parent = Path(__file__).resolve().parents[1] / ".workbench" / "test-fixtures"
        self.parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="clean-verification-", dir=engine.local_path(self.parent))
        self.root = Path(self.temp.name)
        self.hashes = {}
        self.run_number = 0

    def tearDown(self):
        for name, original_hash in self.hashes.items():
            self.assertEqual(engine.file_sha(name), original_hash, "核验不得修改原件或清洗结果")
        resolved = self.root.resolve()
        self.assertEqual(resolved.parent, Path(engine.local_path(self.parent)).resolve())
        self.assertTrue(resolved.name.startswith("clean-verification-"))
        shutil.rmtree(resolved)
        self.temp.cleanup()

    def table(self, name, rows, role=None, columns=("id", "value", "unit")):
        filename = Path(engine.local_path(self.root / name))
        filename.parent.mkdir(parents=True, exist_ok=True)
        with filename.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream, delimiter="\t" if name.endswith(".tsv") else ",")
            writer.writerow(columns)
            writer.writerows(rows)
        digest = engine.file_sha(filename)
        self.hashes[str(filename)] = digest
        return {"name": name, "path": str(filename), "size": filename.stat().st_size, "sha256": digest, **({"role": role} if role else {})}

    def ref(self, file, row):
        return {"file": file["name"], "record": row}

    def relation(self, source, row, target, target_row=None, action="keep", **extra):
        return {"sources": [self.ref(source, row)], "targets": [self.ref(target, target_row or row)] if target else [],
                "action": action, "ruleIds": [], **extra}

    def rule(self, kind, **extra):
        return {"id": "R1", "kind": kind, "inputColumn": "value", "outputColumn": "value", "basis": "研究者已确认本合成测试规则", **extra}

    def duplicate_policy(self, **extra):
        return {"id": "D1", "kind": "duplicate", "columns": ["*"], "keep": "first", "when": {}, "basis": "本例研究者明确允许：全部原字段完全相同，同原文件内保留最早记录", **extra}

    def verify(self, inputs=None, outputs=None, events=None, rules=None, checks=None, alter=None):
        self.run_number += 1
        if inputs is None:
            inputs = [self.table("input.csv", [["A", "2.50", "kg"]])]
        if outputs is None:
            outputs = [self.table("cleaned.csv", [["A", "2.50", "kg"]], "cleaned")]
        if events is None:
            events = [self.relation(inputs[0], 1, outputs[0])]
        lineage = Path(engine.local_path(self.root / ("lineage-" + str(self.run_number) + ".jsonl")))
        lineage.write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events), encoding="utf-8")
        text = "本测试已确认：保留原值，按明确规则处理，不自行猜测。"
        request = {"schema": 1, "plan": {"text": text, "sha256": hashlib.sha256(text.encode()).hexdigest(),
                                         "valueRules": {"schema": 1, "rules": rules or []},
                                         "checks": checks or {"schema": 1, "state": "none", "rules": []}},
                   "inputs": inputs, "outputs": outputs, "lineagePath": str(lineage),
                   "outputDir": str(self.root / ("report-" + str(self.run_number))), "workDir": str(self.root / "private")}
        if alter:
            alter(request)
        result = engine.verify_cleaning(request)
        result["_directory"] = Path(engine.local_path(request["outputDir"]))
        return result

    def codes(self, result):
        return {issue["code"] for issue in result["issues"]}

    def assert_ready(self, result):
        self.assertEqual(result["issues"], [])
        self.assertTrue(all(item["status"] == "passed" for item in result["checks"]))

    def test_keep_actual_values_passes_without_cleaner_success_claim(self):
        result = self.verify()
        self.assert_ready(result)
        self.assertEqual(result["summary"]["inputRows"], 1)
        self.assertEqual(result["summary"]["cleanedRows"], 1)
        self.assertEqual(result["summary"]["changedCells"], 0)

    def test_affine_and_unit_mapping_independently_recomputed(self):
        source = self.table("input.csv", [["A", "2.5", "kg"], ["B", "100", "g"]])
        target = self.table("cleaned.csv", [["A", "2500", "g"], ["B", "100", "g"]], "cleaned")
        rules = [self.rule("affine", factor="1000", when={"unit": ["kg"]}),
                 self.rule("map", id="R2", inputColumn="unit", outputColumn="unit", mapping={"kg": "g"}, when={"unit": ["kg"]})]
        result = self.verify([source], [target], [self.relation(source, row, target, action="transform") for row in (1, 2)], rules)
        self.assert_ready(result)
        self.assertEqual(result["summary"]["changedCells"], 2)
        changes = [json.loads(line) for line in (result["_directory"] / "changes.jsonl").read_text(encoding="utf-8").splitlines()]
        value_change = next(change for change in changes if change["column"] == "value")
        self.assertEqual(value_change["before"], "2.5")
        self.assertEqual(value_change["after"], "2500")
        self.assertEqual(value_change["rules"][0]["id"], "R1")

    def test_incorrect_conversion_is_blocking_not_acceptible_warning(self):
        target = self.table("cleaned.csv", [["A", "250", "kg"]], "cleaned")
        result = self.verify(outputs=[target], rules=[self.rule("affine", factor="1000")])
        issue = next(issue for issue in result["issues"] if issue["code"] == "value-result-wrong")
        self.assertEqual(issue["severity"], "error")
        self.assertIn("2500", issue["evidence"][0]["detail"])

    def test_non_numeric_conversion_result_is_blocking(self):
        target = self.table("cleaned.csv", [["A", "not-number", "kg"]], "cleaned")
        result = self.verify(outputs=[target], rules=[self.rule("affine", factor="1000")])
        self.assertTrue(any(issue["code"] == "value-result-wrong" and issue["severity"] == "error" for issue in result["issues"]))

    def test_decimal_precision_and_confirmed_tolerance(self):
        source = self.table("input.csv", [["A", "0.12345678901234567890123456789", "kg"]])
        target = self.table("cleaned.csv", [["A", "0.012345678901234567890123456789", "kg"]], "cleaned")
        result = self.verify([source], [target], rules=[self.rule("affine", factor="0.1")])
        self.assert_ready(result)
        target = self.table("rounded.csv", [["A", "0.01235", "kg"]], "cleaned")
        result = self.verify([source], [target], rules=[self.rule("affine", factor="0.1", absoluteTolerance="0.00001")])
        self.assert_ready(result)

    def test_negative_tolerance_never_silently_applied(self):
        result = self.verify(rules=[self.rule("affine", factor="1", absoluteTolerance="-1")])
        self.assertIn("value-rule-manual", self.codes(result))

    def test_trim_copy_rename_and_map(self):
        source = self.table("input.csv", [[" A ", "2", "kg"]], columns=("id", "raw", "unit"))
        target = self.table("cleaned.csv", [["A", "2", "g"]], "cleaned")
        rules = [self.rule("trim", inputColumn="id", outputColumn="id"), self.rule("copy", id="R2", inputColumn="raw"),
                 self.rule("map", id="R3", inputColumn="unit", outputColumn="unit", mapping={"kg": "g"})]
        result = self.verify([source], [target], rules=rules)
        self.assert_ready(result)

    def test_trim_wrong_output_blocks(self):
        target = self.table("cleaned.csv", [["B", "2.50", "kg"]], "cleaned")
        result = self.verify(outputs=[target], rules=[self.rule("trim", inputColumn="id", outputColumn="id")])
        self.assertIn("value-result-wrong", self.codes(result))

    def test_condition_matches_exact_original_text_without_implicit_trim(self):
        source = self.table("input.csv", [["A", "2", " kg "]])
        target = self.table("cleaned.csv", [["A", "2000", " kg "]], "cleaned")
        result = self.verify([source], [target], rules=[self.rule("affine", factor="1000", when={"unit": ["kg"]})])
        self.assertIn("value-change-unexplained", self.codes(result))
        self.assertNotIn("value-result-wrong", self.codes(result))

    def test_missing_declared_target_field_blocks(self):
        target = self.table("cleaned.csv", [["A", "kg"]], "cleaned", columns=("id", "unit"))
        result = self.verify(outputs=[target], rules=[self.rule("copy")])
        self.assertIn("value-rule-output-missing", self.codes(result))

    def test_unexplained_change_and_new_column_are_not_passed(self):
        target = self.table("cleaned.csv", [["A", "22", "kg", "guessed"]], "cleaned", columns=("id", "value", "unit", "new"))
        result = self.verify(outputs=[target])
        issue = next(issue for issue in result["issues"] if issue["code"] == "value-change-unexplained")
        self.assertEqual(issue["impact"]["occurrences"], 2)
        self.assertEqual(result["summary"]["changedCells"], 2)

    def test_removed_field_not_assumed_safe(self):
        target = self.table("cleaned.csv", [["A", "2.50"]], "cleaned", columns=("id", "value"))
        result = self.verify(outputs=[target])
        self.assertIn("column-removal-unexplained", self.codes(result))

    def test_full_row_duplicate_verified_with_kept_anchor(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 1), ruleIds=["D1"])]
        result = self.verify([source], [target], events, rules=[self.duplicate_policy()])
        self.assert_ready(result)
        self.assertEqual(result["summary"]["duplicateRows"], 1)
        self.assertNotEqual(result["summary"]["inputRows"], result["summary"]["cleanedRows"])

    def test_full_row_duplicates_cannot_be_deleted_without_confirmed_policy(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 1))]
        result = self.verify([source], [target], events)
        self.assertIn("duplicate-policy-unconfirmed", self.codes(result))

    def test_duplicate_event_must_reference_confirmed_policy_id(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 1), ruleIds=["D2"])]
        result = self.verify([source], [target], events, rules=[self.duplicate_policy()])
        self.assertIn("duplicate-policy-unconfirmed", self.codes(result))

    def test_duplicate_policy_requires_actual_first_original_row(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 3, target, 1),
                  self.relation(source, 1, None, action="duplicate", retainedSource=self.ref(source, 3), ruleIds=["D1"]),
                  self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 3), ruleIds=["D1"])]
        result = self.verify([source], [target], events, rules=[self.duplicate_policy()])
        self.assertTrue(any(issue["code"] == "duplicate-retained-not-first" and issue["severity"] == "error" for issue in result["issues"]))

    def test_cross_file_duplicate_is_outside_initial_policy_scope(self):
        first = self.table("first.csv", [["A", "2", "kg"]])
        second = self.table("second.csv", [["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(first, 1, target), self.relation(second, 1, None, action="duplicate", retainedSource=self.ref(first, 1), ruleIds=["D1"])]
        result = self.verify([first, second], [target], events, rules=[self.duplicate_policy()])
        self.assertIn("duplicate-policy-scope-unverified", self.codes(result))

    def test_business_key_policy_not_silently_treated_as_full_row_policy(self):
        result = self.verify(rules=[self.duplicate_policy(columns=["id"])])
        self.assertIn("value-rule-manual", self.codes(result))

    def test_declared_rule_without_matches_is_not_marked_passed(self):
        result = self.verify(rules=[self.rule("affine", factor="1000", when={"unit": ["g"]})])
        self.assertIn("value-rule-not-executed", self.codes(result))
        check = next(check for check in result["checks"] if check["id"] == "value-rule-R1")
        self.assertEqual(check["matchedRows"], 0)
        self.assertEqual(check["checkedRows"], 0)
        self.assertEqual(check["status"], "needs_decision")

    def test_used_rule_reports_actual_matched_checked_counts(self):
        result = self.verify(rules=[self.rule("copy")])
        self.assert_ready(result)
        check = next(check for check in result["checks"] if check["id"] == "value-rule-R1")
        self.assertEqual(check["matchedRows"], 1)
        self.assertEqual(check["checkedRows"], 1)

    def test_business_key_duplicate_requires_decision(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "3", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 1))]
        self.assertIn("duplicate-not-identical", self.codes(self.verify([source], [target], events)))

    def test_duplicate_without_real_retained_destination_blocks(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [], "cleaned")
        events = [self.relation(source, 1, None, action="exclude", reason="需要确认"),
                  self.relation(source, 2, None, action="duplicate", retainedSource=self.ref(source, 1))]
        result = self.verify([source], [target], events)
        self.assertIn("duplicate-retained-not-kept", self.codes(result))

    def test_missing_input_destination_even_if_row_counts_equal(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["B", "3", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"], ["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 1, target, 2)]
        result = self.verify([source], [target], events)
        self.assertIn("lineage-duplicate-claim", self.codes(result))
        self.assertIn("input-without-destination", self.codes(result))

    def test_output_without_source_and_invalid_reference_block(self):
        source = self.table("input.csv", [["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"], ["B", "3", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 9, target, 9)]
        result = self.verify([source], [target], events)
        self.assertIn("lineage-record-missing", self.codes(result))
        self.assertIn("output-without-source", self.codes(result))

    def test_merge_valid_provenance_but_semantics_remain_pending(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["B", "3", "kg"]])
        target = self.table("cleaned.csv", [["TOTAL", "5", "kg"]], "cleaned")
        events = [{"sources": [self.ref(source, 1), self.ref(source, 2)], "targets": [self.ref(target, 1)], "action": "merge", "ruleIds": ["SUM"]}]
        result = self.verify([source], [target], events)
        self.assertEqual(result["summary"]["blockingIssues"], 0)
        self.assertIn("aggregate-semantics-unverified", self.codes(result))

    def test_split_valid_provenance_without_requiring_equal_row_counts(self):
        source = self.table("input.csv", [["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A1", "1", "kg"], ["A2", "1", "kg"]], "cleaned")
        events = [{"sources": [self.ref(source, 1)], "targets": [self.ref(target, 1), self.ref(target, 2)], "action": "split", "ruleIds": ["SPLIT"]}]
        result = self.verify([source], [target], events)
        self.assertEqual(result["summary"]["blockingIssues"], 0)
        self.assertEqual(result["summary"]["splitEvents"], 1)

    def test_pending_records_not_subject_to_main_nonempty_condition(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["B", "", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        pending = self.table("pending.csv", [["B", "", "kg"]], "pending")
        events = [self.relation(source, 1, target), self.relation(source, 2, pending, 1, action="pending", reason="原文缺数值")]
        checks = {"schema": 1, "rules": [{"id": "P1", "kind": "not_empty", "column": "value", "basis": "主结果供计算，不能为空"}]}
        result = self.verify([source], [target, pending], events, checks=checks)
        self.assertEqual(result["professionalChecks"][0]["status"], "passed")
        displayed = next(check for check in result["checks"] if check["id"] == "postcondition-P1")
        self.assertEqual(displayed["status"], "passed")
        self.assertEqual(displayed["checkedRows"], 1)
        self.assertEqual(displayed["failedRows"], 0)
        self.assertIn("pending-records", self.codes(result))
        self.assertEqual(result["summary"]["pendingRows"], 1)

    def test_pending_changed_values_are_still_audited(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["B", "", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        pending = self.table("pending.csv", [["B", "invented", "kg"]], "pending")
        events = [self.relation(source, 1, target), self.relation(source, 2, pending, 1, action="pending", reason="缺数值")]
        result = self.verify([source], [target, pending], events)
        self.assertIn("pending-value-changed", self.codes(result))
        changes = [json.loads(line) for line in (result["_directory"] / "changes.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(changes[0]["before"], "")
        self.assertEqual(changes[0]["after"], "invented")

    def test_main_postconditions_really_scan_actual_output(self):
        checks = {"schema": 1, "rules": [{"id": "P1", "kind": "numeric_range", "column": "value", "max": "2", "basis": "本例确认上限"}]}
        result = self.verify(checks=checks)
        self.assertIn("professional-rule-P1", self.codes(result))
        self.assertEqual(result["professionalChecks"][0]["failedRows"], 1)
        displayed = next(check for check in result["checks"] if check["id"] == "postcondition-P1")
        self.assertEqual(displayed["status"], "needs_decision")
        self.assertEqual(displayed["failedRows"], 1)

    def test_csv_multiline_and_tsv_use_logical_record_number(self):
        source = self.table("input.tsv", [["A\nsecond line", "2", "kg"], ["B", "3", "kg"]])
        target = self.table("cleaned.csv", [["A\nsecond line", "2", "kg", "1"], ["B", "3", "kg", "2"]], "cleaned", columns=("id", "value", "unit", "source_row"))
        result = self.verify([source], [target], [self.relation(source, row, target) for row in (1, 2)])
        self.assert_ready(result)
        self.assertEqual(result["summary"]["inputRows"], 2)

    def test_source_row_wrong_is_error(self):
        target = self.table("cleaned.csv", [["A", "2.50", "kg", "2"]], "cleaned", columns=("id", "value", "unit", "source_row"))
        self.assertIn("source-row-wrong", self.codes(self.verify(outputs=[target])))

    def test_existing_source_row_column_cannot_hide_wrong_reference(self):
        source = self.table("input.csv", [["A", "2", "kg", "9"]], columns=("id", "value", "unit", "source_row"))
        target = self.table("cleaned.csv", [["A", "2", "kg", "9"]], "cleaned", columns=("id", "value", "unit", "source_row"))
        self.assertIn("source-row-wrong", self.codes(self.verify([source], [target])))

    def test_duplicate_missing_retained_reference_blocks(self):
        source = self.table("input.csv", [["A", "2", "kg"], ["A", "2", "kg"]])
        target = self.table("cleaned.csv", [["A", "2", "kg"]], "cleaned")
        events = [self.relation(source, 1, target), self.relation(source, 2, None, action="duplicate")]
        self.assertIn("lineage-reference-invalid", self.codes(self.verify([source], [target], events)))

    def test_plan_and_file_tampering_block(self):
        result = self.verify(alter=lambda request: request["plan"].update(sha256="0" * 64))
        self.assertIn("plan-hash-wrong", self.codes(result))
        result = self.verify(alter=lambda request: request["inputs"][0].update(sha256="0" * 64))
        self.assertIn("file-unreadable", self.codes(result))

    def test_unknown_format_and_unknown_rules_are_never_passed(self):
        filename = Path(engine.local_path(self.root / "data.xlsx"))
        filename.write_bytes(b"synthetic placeholder, not a real workbook")
        source = {"path": str(filename), "name": "data.xlsx", "size": filename.stat().st_size, "sha256": engine.file_sha(filename)}
        result = self.verify(inputs=[source], events=[], rules=[self.rule("manual", reason="需要模型业务判断")])
        self.assertIn("format-unverified", self.codes(result))
        self.assertIn("value-rule-manual", self.codes(result))
        self.assertEqual(result["checks"][0]["status"], "limited")
        values_check = next(check for check in result["checks"] if check["id"] == "values")
        self.assertEqual(values_check["status"], "limited")

    def test_malformed_csv_does_not_validate_partial_rows(self):
        source = self.table("input.csv", [["A", "2", "kg"]])
        location = Path(source["path"])
        with location.open("a", encoding="utf-8") as stream:
            stream.write('"unclosed\n')
        source.update(size=location.stat().st_size, sha256=engine.file_sha(location))
        self.hashes[str(location)] = source["sha256"]
        result = self.verify(inputs=[source])
        self.assertIn("file-unreadable", self.codes(result))
        self.assertEqual(result["summary"]["inputRows"], 0)

    def test_large_table_disk_index_coverage_and_evidence_full(self):
        rows = [[str(index), str(index), "kg"] for index in range(5000)]
        source = self.table("input.csv", rows)
        target = self.table("cleaned.csv", rows, "cleaned")
        result = self.verify([source], [target], [self.relation(source, index, target) for index in range(1, 5001)])
        self.assert_ready(result)
        self.assertEqual(result["summary"]["inputRows"], 5000)
        self.assertFalse(list((self.root / "private").glob("clean-check-*")))

    def test_duplicate_first_lookup_uses_covering_disk_index(self):
        verifier = engine.CleanVerifier({"outputDir": str(self.root / "query-plan"), "workDir": str(self.root / "private")})
        try:
            plan = verifier.db.execute("EXPLAIN QUERY PLAN " + engine.DUPLICATE_FIRST_QUERY, (1, "{}")).fetchall()
            detail = " ".join(str(row[-1]) for row in plan)
            self.assertIn("records_duplicate_first_idx", detail)
            self.assertIn("COVERING INDEX", detail.upper())
        finally:
            verifier.run()  # Close the synthetic index and report handles normally.

    def a_rows(self):
        # Synthetic 80-row fixture: no researcher dataset or cleaning code.
        return [["2", "'004", "Afghanistan", str(1000 + index), "'S" + str(1000 + index), "Item " + str(index),
                 "5511", "Production", "1992", "1992", "1000 t", "0.000000" if index == 0 else "-11.000000" if index == 79 else "2.500000", "E"]
                for index in range(80)]

    def verify_a(self, original=None, cleaned=None, columns=None, reordered_events=False, adapter=engine.A_PRESERVE_ADAPTER):
        original = self.a_rows() if original is None else original
        cleaned = [list(row) for row in original] if cleaned is None else cleaned
        source = self.table("a-input.csv", original, columns=engine.A_PRESERVE_COLUMNS)
        target = self.table("a-cleaned.csv", cleaned, "cleaned", columns=columns or engine.A_PRESERVE_COLUMNS)
        events = [self.relation(source, record, target, (2 if record == 1 else 1 if record == 2 else record) if reordered_events else record)
                  for record in range(1, len(original) + 1)]
        return self.verify([source], [target], events, alter=lambda request: request["plan"].update(executionAdapter=adapter))

    def test_a_preservation_exact_original_text_and_evidence(self):
        result = self.verify_a()
        self.assert_ready(result)
        self.assertEqual(result["summary"]["aPreserveRowsCompared"], 80)
        self.assertEqual(result["summary"]["aPreserveCellsCompared"], 1040)
        self.assertEqual(result["summary"]["aPreserveMismatchCells"], 0)
        entries = [json.loads(line) for line in (result["_directory"] / "fbsh80-a-preservation.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sum(entry["type"] == "row-comparison" for entry in entries), 80)
        self.assertEqual(sum(entry["type"] == "types" for entry in entries), 160)
        self.assertEqual(entries[-1]["id"], "a-preserve-duplicates")
        self.assertNotIn("manualChecks", result, "The machine checker never invents human conclusions")

    def test_a_preservation_detects_reordered_rows_even_with_valid_lineage(self):
        cleaned = self.a_rows()
        cleaned[0], cleaned[1] = cleaned[1], cleaned[0]
        result = self.verify_a(cleaned=cleaned, reordered_events=True)
        self.assertNotIn("value-change-unexplained", self.codes(result), "Existing provenance may map the reordered records correctly")
        self.assertIn("a-preserve-cell-mismatch", self.codes(result), "A policy nevertheless requires original row order")
        self.assertTrue(any(check["id"] == "a-preserve-content" and check["status"] == "failed" for check in result["checks"]))

    def test_a_preservation_detects_column_reordering(self):
        cleaned = [list(reversed(row)) for row in self.a_rows()]
        result = self.verify_a(cleaned=cleaned, columns=list(reversed(engine.A_PRESERVE_COLUMNS)))
        self.assertIn("a-preserve-schema", self.codes(result))
        self.assertEqual(result["summary"]["aPreserveCellsCompared"], 0)

    def test_a_preservation_detects_nan_even_unchanged_from_source(self):
        rows = self.a_rows()
        rows[2][11] = "NaN"
        result = self.verify_a(original=rows)
        self.assertIn("a-preserve-type", self.codes(result))
        self.assertEqual(result["summary"]["aPreserveTypeFailures"], 2, "Actual input and output are both checked")

    def test_a_preservation_requires_integer_year_not_decimal_spelling(self):
        rows = self.a_rows()
        rows[2][8] = "1992.0"
        result = self.verify_a(original=rows)
        self.assertIn("a-preserve-type", self.codes(result))

    def test_a_preservation_reports_code_name_conflict(self):
        rows = self.a_rows()
        rows[1][3] = rows[0][3]  # Same item code, two different actual names.
        result = self.verify_a(original=rows)
        self.assertIn("a-preserve-code-name", self.codes(result))
        self.assertGreater(result["summary"]["aPreserveCodeNameConflicts"], 0)

    def test_a_preservation_duplicate_report_never_deletes_or_requires_exception(self):
        rows = self.a_rows()
        rows[1] = list(rows[0])
        result = self.verify_a(original=rows)
        self.assert_ready(result)
        self.assertEqual(result["summary"]["aPreserveFullDuplicateGroups"], 1)
        self.assertEqual(result["summary"]["aPreserveBusinessDuplicateGroups"], 1)
        self.assertEqual(result["summary"]["inputRows"], 80)
        self.assertEqual(result["summary"]["cleanedRows"], 80)
        self.assertEqual(result["summary"]["duplicateRows"], 0)

    def test_a_preservation_new_blank_is_blocking(self):
        cleaned = self.a_rows()
        cleaned[3][12] = ""
        result = self.verify_a(cleaned=cleaned)
        self.assertIn("a-preserve-new-empty", self.codes(result))
        self.assertEqual(result["summary"]["aPreserveNewEmptyCells"], 1)

    def test_a_preservation_adapter_cannot_apply_to_unrelated_plan(self):
        result = self.verify_a(adapter="another-adapter")
        self.assert_ready(result)
        self.assertNotIn("aPreserveCellsCompared", result["summary"])
        self.assertFalse((result["_directory"] / "fbsh80-a-preservation.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
