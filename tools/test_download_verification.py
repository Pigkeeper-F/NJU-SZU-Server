"""Offline regression fixtures; no actual sources, browser or downloads are used."""
import csv
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("download_verification", Path(__file__).with_name("download_verification.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
HEADER = ["Reporter Country Code", "Partner Country Code", "Item Code", "Element Code", "Year", "Unit", "Value", "Flag"]


def record(year="2024", value="12.00", unit="t", flag="A", item="15", partner="41"):
    return ["2", partner, item, "5610", year, unit, value, flag]


class DownloadVerificationTest(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / ".workbench" / "test-fixtures"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="download-verification-", dir=parent)
        self.root = Path(self.temp.name)
        self.source_hashes = {}

    def tearDown(self):
        for path, original in self.source_hashes.items():
            self.assertEqual(engine.file_sha(path), original, "核验不得更改下载原件或历史原件")
        target = Path(engine.local_path(self.root)).resolve()
        fixture_root = Path(engine.local_path(Path(__file__).resolve().parents[1] / ".workbench" / "test-fixtures")).resolve()
        self.assertEqual(target.parent, fixture_root)
        self.assertTrue(target.name.startswith("download-verification-"))
        shutil.rmtree(target)
        self.temp.cleanup()

    def table(self, name, rows, columns=HEADER, delimiter=",", encoding="utf-8-sig"):
        path = self.root / name
        with path.open("w", encoding=encoding, newline="") as handle:
            writer = csv.writer(handle, delimiter=delimiter)
            writer.writerow(columns)
            writer.writerows(rows)
        self.source_hashes[path] = engine.file_sha(path)
        return {"path": str(path), "name": name, "sha256": self.source_hashes[path]}

    def dataset(self, files, **extra):
        return {"kind": "faostat-tm", "files": files, **extra}

    def verify(self, current, baseline=None, **extra):
        return engine.verify_download({"current": current, "baseline": baseline,
                                       "outputDir": str(self.root / "evidence"), **extra})

    def differences(self, result):
        evidence = next(x for x in result["evidenceFiles"] if x["kind"] == "differences")
        return [json.loads(line) for line in Path(evidence["path"]).read_text(encoding="utf-8").splitlines()]

    def test_first_download_profiles_actual_files_without_baseline_decision(self):
        result = self.verify(self.dataset([self.table("current.csv", [record(value="0"), record(partner="42", value="-11.00", flag="E")])]))
        self.assertEqual(result["comparison"]["status"], "first-acquisition")
        self.assertEqual(result["issues"], [])
        profile = result["profile"]["current"]
        self.assertEqual(profile["rows"], 2)
        self.assertEqual(profile["years"], ["2024"])
        self.assertEqual(profile["files"][0]["units"], [{"elementCode": "5610", "unit": "t", "rows": 2}])
        self.assertEqual(profile["files"][0]["columns"], HEADER)
        self.assertEqual(profile["files"][0]["sha256"], engine.file_sha(profile["files"][0]["path"]))

    def test_keyed_values_flags_and_units_are_compared_without_conversion(self):
        old = self.table("old.csv", [record(value="12.00"), record(partner="42", flag="A"), record(partner="43")])
        new = self.table("new.csv", [record(value="12"), record(partner="42", flag="E"), record(partner="43", unit="kg")])
        result = self.verify(self.dataset([new]), self.dataset([old]))
        summary = result["comparison"]["summary"]
        self.assertEqual((summary["revised"], summary["unitChanges"]), (3, 1))
        self.assertEqual({tuple(x["changedColumns"]) for x in self.differences(result)}, {("Value",), ("Flag",), ("Unit",)})
        self.assertIn("historical-data-changed", [x["code"] for x in result["issues"]])

    def test_new_years_are_coverage_extension_not_historical_added_or_deleted(self):
        old = self.table("old.csv", [record("2022"), record("2023", "10")])
        new = self.table("new.csv", [record("2023", "11"), record("2024"), record("2024", partner="42")])
        result = self.verify(self.dataset([new], config={"years": [2023, 2024]}), self.dataset([old], config={"years": [2022, 2023]}))
        comparison = result["comparison"]
        self.assertEqual(comparison["coverage"]["commonYears"], ["2023"])
        self.assertEqual(comparison["coverage"]["addedYearRows"], 2)
        self.assertEqual(comparison["coverage"]["missingYearRows"], 1)
        self.assertEqual((comparison["summary"]["added"], comparison["summary"]["removed"], comparison["summary"]["revised"]), (0, 0, 1))
        self.assertEqual(len(self.differences(result)), 1)

    def test_duplicate_keys_are_never_arbitrarily_paired(self):
        old = self.table("old.csv", [record(value="10"), record(partner="42", value="2")])
        new = self.table("new.csv", [record(value="10"), record(value="11"), record(partner="42", value="3")])
        result = self.verify(self.dataset([new]), self.dataset([old]))
        summary = result["comparison"]["summary"]
        self.assertEqual(summary["duplicateKeys"], 1)
        self.assertEqual((summary["ambiguousCurrentRows"], summary["ambiguousBaselineRows"]), (2, 1))
        self.assertEqual((summary["revised"], summary["added"], summary["removed"]), (1, 0, 0))
        ambiguous = next(x for x in result["evidenceFiles"] if x["kind"] == "ambiguous-keys")
        self.assertEqual(len(Path(ambiguous["path"]).read_text(encoding="utf-8").splitlines()), 3)

    def test_without_keys_multiset_preserves_duplicate_counts_and_does_not_guess_revisions(self):
        old = self.table("old.tsv", [["x", "a"], ["x", "a"], ["y", "b"]], ["item", "value"], "\t")
        new = self.table("new.tsv", [["x", "a"], ["y", "c"]], ["item", "value"], "\t")
        result = self.verify({"files": [new]}, {"files": [old]})
        summary = result["comparison"]["summary"]
        self.assertEqual(result["comparison"]["method"], "full-row-multiset")
        self.assertEqual((summary["added"], summary["removed"], summary["revised"], summary["unchanged"]), (1, 2, 0, 1))
        self.assertIn("unkeyed-records-changed", [x["code"] for x in result["issues"]])
        self.assertTrue(all(x["type"] != "revised" for x in self.differences(result)))

    def test_without_keys_only_additions_do_not_force_a_key_confirmation(self):
        old = self.table("old.csv", [["a"]], ["v"])
        new = self.table("new.csv", [["a"], ["b"]], ["v"])
        result = self.verify({"files": [new]}, {"files": [old]})
        self.assertEqual(result["comparison"]["summary"]["added"], 1)
        self.assertEqual(result["issues"], [])

    def test_explicit_generic_keys_identify_a_revision(self):
        old = self.table("old.csv", [["a", "1"]], ["id", "v"])
        new = self.table("new.csv", [["a", "2"]], ["id", "v"])
        result = self.verify({"files": [new]}, {"files": [old]}, keyColumns=["id"])
        self.assertEqual(result["comparison"]["summary"]["revised"], 1)

    def test_reordered_columns_do_not_create_false_revisions(self):
        old = self.table("old.csv", [record()])
        new = self.table("new.csv", [list(reversed(record()))], list(reversed(HEADER)))
        result = self.verify(self.dataset([new]), self.dataset([old]))
        self.assertTrue(result["comparison"]["schema"]["orderChanged"])
        self.assertEqual(result["comparison"]["summary"]["unchanged"], 1)
        self.assertEqual(result["comparison"]["summary"]["revised"], 0)

    def test_schema_addition_is_reported_separately_not_as_a_value_revision(self):
        old = self.table("old.csv", [record()])
        new = self.table("new.csv", [record() + ["new provenance"]], HEADER + ["Note"])
        result = self.verify(self.dataset([new]), self.dataset([old]))
        self.assertEqual(result["comparison"]["schema"]["addedColumns"], ["Note"])
        self.assertEqual(result["comparison"]["summary"]["revised"], 0)
        self.assertIn("schema-changed", [x["code"] for x in result["issues"]])

    def test_scope_change_does_not_mislabel_rows_as_deletions(self):
        old = self.table("old.csv", [record(item="15")])
        new = self.table("new.csv", [record(item="16")])
        result = self.verify(self.dataset([new], config={"filters": {"itemCodes": ["16"]}}),
                             self.dataset([old], config={"filters": {"itemCodes": ["15"]}}))
        self.assertEqual(result["comparison"]["status"], "incomparable")
        self.assertEqual(result["comparison"]["summary"]["removed"], 0)
        self.assertIn("scope-not-comparable", [x["code"] for x in result["issues"]])

    def test_actual_rows_are_checked_against_years_and_resolved_official_filters(self):
        current = self.table("new.csv", [record(year="2022", item="16"), record(year="2024", item="15")])
        result = self.verify(self.dataset([current], config={"years": [2024], "filters": {"itemNames": ["Wheat"]}},
                                          result={"resolvedConfig": {"filters": {"itemCodes": ["15"]}}}))
        problem = next(x for x in result["issues"] if x["code"] == "rows-outside-plan")
        self.assertEqual(problem["severity"], "error")
        self.assertEqual(problem["affected"]["rows"], 1)
        self.assertEqual(set(problem["evidence"]["samples"][0]["violations"]), {"years", "itemNames"})
        self.assertEqual(result["profile"]["current"]["rows"], 2, "原件越界行不可由核验器擅自删除")

    def test_bad_csv_blocks_whole_batch_comparison_instead_of_using_partial_rows(self):
        old = self.table("old.csv", [record()])
        bad = self.table("bad.csv", [record(), ["broken"]])
        result = self.verify(self.dataset([bad]), self.dataset([old]))
        self.assertEqual(result["comparison"]["status"], "blocked")
        self.assertEqual(result["profile"]["current"]["rows"], 0)
        self.assertEqual(result["profile"]["current"]["files"][0]["rowsReadBeforeFailure"], 1)

    def test_duplicate_header_empty_file_and_hash_mismatch_are_errors(self):
        duplicate = self.table("duplicate.csv", [["a", "b"]], ["id", "id"])
        empty_path = self.root / "empty.csv"
        empty_path.write_bytes(b"")
        mismatch = self.table("mismatch.csv", [["a"]], ["id"])
        mismatch["sha256"] = "0" * 64
        result = self.verify({"files": [duplicate, {"path": str(empty_path)}, mismatch]})
        self.assertEqual(result["profile"]["current"]["failedFiles"], 3)
        self.assertTrue(all(x["severity"] == "error" for x in result["issues"]))

    def test_utf16_bom_and_multiline_quoted_cells_parse_without_changes(self):
        file = self.table("unicode.csv", [["a", "含,逗号\n及换行"]], ["id", "value"], encoding="utf-16")
        result = self.verify({"files": [file]})
        self.assertEqual(result["profile"]["current"]["rows"], 1)
        self.assertEqual(result["profile"]["current"]["files"][0]["encoding"], "utf-16")

    def test_unknown_years_are_not_silently_excluded_from_comparison(self):
        old = self.table("old.csv", [["a", "2024", "1"]], ["id", "Year", "value"])
        new = self.table("new.csv", [["a", "2024", "1"], ["b", "", "2"]], ["id", "Year", "value"])
        result = self.verify({"files": [new]}, {"files": [old]}, keyColumns=["id", "Year"])
        self.assertEqual(result["comparison"]["status"], "blocked")
        self.assertTrue(result["profile"]["current"]["failedFiles"])
        # With an unkeyed source, CSV is readable, but unknown years still block a complete comparison.
        unkeyed = self.verify({"files": [new]}, {"files": [old]})
        self.assertEqual(unkeyed["comparison"]["status"], "blocked")
        self.assertEqual(unkeyed["profile"]["current"]["emptyYearRows"], 1)
        self.assertIn("year-values-missing", [x["code"] for x in unkeyed["issues"]])

    def test_missing_requested_years_are_reported_and_not_invented(self):
        current = self.table("new.csv", [record("2024")])
        result = self.verify(self.dataset([current], config={"years": [2023, 2024]}))
        problem = next(x for x in result["issues"] if x["code"] == "requested-years-missing")
        self.assertEqual(problem["affected"]["years"], ["2023"])
        self.assertEqual(result["profile"]["current"]["rows"], 1)

    def test_no_common_years_is_coverage_only(self):
        old = self.table("old.csv", [record("2023")])
        new = self.table("new.csv", [record("2024")])
        result = self.verify(self.dataset([new]), self.dataset([old]))
        self.assertEqual(result["comparison"]["status"], "no-overlap")
        self.assertFalse(result["comparison"]["comparable"])
        self.assertEqual(result["comparison"]["summary"]["removed"], 0)

    def test_arbitrary_source_identity_change_blocks_comparison(self):
        old = self.table("old.csv", [["a"]], ["v"])
        new = self.table("new.csv", [["a"]], ["v"])
        result = self.verify({"files": [new], "sourceId": "official-A"}, {"files": [old], "sourceId": "other-B"})
        self.assertEqual(result["comparison"]["status"], "incomparable")

    def test_pdf_and_excel_have_explicit_content_check_boundaries(self):
        pdf = self.root / "text.pdf"
        pdf.write_bytes(b"%PDF-1.7\nexample\n%%EOF")
        xlsx = self.root / "book.xlsx"
        with zipfile.ZipFile(xlsx, "w") as archive:
            archive.writestr("xl/workbook.xml", "<workbook/>")
        result = self.verify({"files": [{"path": str(pdf)}, {"path": str(xlsx)}]})
        self.assertEqual(result["profile"]["current"]["limitedFiles"], 2)
        self.assertTrue(all(not x["contentChecked"] for x in result["profile"]["current"]["files"]))
        self.assertEqual(len(result["limitations"]), 2)

    def test_full_evidence_is_written_but_json_samples_are_bounded(self):
        old = self.table("old.csv", [record(partner=str(i), value="1") for i in range(35)])
        new = self.table("new.csv", [record(partner=str(i), value="2") for i in range(35)])
        result = self.verify(self.dataset([new]), self.dataset([old]))
        self.assertEqual(result["comparison"]["summary"]["revised"], 35)
        self.assertEqual(len(result["samples"]), engine.SAMPLE_LIMIT)
        self.assertEqual(len(self.differences(result)), 35)
        self.assertFalse(any((self.root / "evidence").glob("download-verification-*")), "临时 SQLite 索引应关闭清理")

    def test_cli_contract_writes_json_and_refuses_to_overwrite_source(self):
        current = self.table("new.csv", [record()])
        request = self.root / "request.json"
        request.write_text(json.dumps({"current": self.dataset([current]), "outputDir": str(self.root / "evidence")}), encoding="utf-8")
        report = self.root / "report.json"
        command = [sys.executable, str(Path(engine.__file__)), "--request", str(request), "--output"]
        process = subprocess.run(command + [str(report)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(report.read_text(encoding="utf-8"))["schema"], 1)
        refused = subprocess.run(command + [current["path"]], capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)

    def test_long_paths_include_source_request_report_evidence_and_sqlite(self):
        # Exercise real filesystem operations, not only a mocked path normalizer.
        long_dir = self.root
        for index in range(5):
            long_dir = long_dir / ("nested-" + str(index) + "-" + "x" * 40)
        self.assertGreater(len(str(long_dir)), 300)
        extended = Path(engine.local_path(long_dir))
        extended.mkdir(parents=True)
        sources = []
        for name, value in (("old.csv", "1"), ("current.csv", "2")):
            raw_path = long_dir / name
            path = Path(engine.local_path(raw_path))
            with path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(HEADER)
                writer.writerow(record(value=value))
            sha = engine.file_sha(raw_path)
            self.source_hashes[path] = sha
            sources.append({"path": raw_path.as_posix(), "name": name, "sha256": sha})
        output_dir = long_dir / "evidence-output"
        raw_request, raw_report = long_dir / "request.json", long_dir / "report.json"
        Path(engine.local_path(raw_request)).write_text(json.dumps({
            "current": self.dataset([sources[1]]), "baseline": self.dataset([sources[0]]),
            "outputDir": output_dir.as_posix()}), encoding="utf-8")
        process = subprocess.run([sys.executable, str(Path(engine.__file__)),
                                  "--request", raw_request.as_posix(), "--output", raw_report.as_posix()],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        report = json.loads(Path(engine.local_path(raw_report)).read_text(encoding="utf-8"))
        self.assertEqual(report["comparison"]["summary"]["revised"], 1)
        self.assertEqual(report["profile"]["current"]["failedFiles"], 0)
        differences = self.differences(report)
        self.assertEqual(differences[0]["current"]["values"]["Value"], "2")
        self.assertFalse(any(Path(engine.local_path(output_dir)).glob("download-verification-*")))

    def test_private_workdir_contains_only_temporary_index_and_never_exposes_it_as_output(self):
        current = self.table("current.csv", [record()])
        output_dir = self.root / "public-output"
        private_dir = self.root / "private-staging"
        # Include a long private staging path so this boundary also exercises Windows normalization.
        for index in range(4):
            private_dir = private_dir / ("private-" + str(index) + "-" + "x" * 40)
        request = {"current": self.dataset([current]), "workDir": private_dir.as_posix()}
        verification = engine.Engine(request, output_dir)
        try:
            temporary = Path(verification.temp.name)
            self.assertEqual(temporary.parent, Path(engine.local_path(private_dir)))
            self.assertTrue((temporary / "index.sqlite").is_file())
            self.assertFalse(any(output_dir.glob("**/*.sqlite")))
            result = verification.run()
            self.assertTrue(result["evidenceFiles"])
            for evidence in result["evidenceFiles"]:
                self.assertEqual(Path(evidence["path"]).parent, Path(engine.local_path(output_dir)))
        finally:
            verification.close()
        self.assertFalse(temporary.exists())
        self.assertEqual(list(Path(engine.local_path(private_dir)).iterdir()), [])
        self.assertFalse(any(output_dir.glob("**/*.sqlite")))

    @unittest.skipUnless(os.name == "nt", "Windows extended path normalization")
    def test_windows_path_normalization_accepts_forward_slashes_and_unc(self):
        normal = str(self.root / "file.csv")
        forward = normal.replace("\\", "/")
        self.assertEqual(engine.local_path(forward), engine.local_path(normal))
        self.assertEqual(engine.local_path(engine.local_path(normal)), engine.local_path(normal))
        self.assertEqual(engine.local_path("//server/share/folder/file.csv"), "\\\\?\\UNC\\server\\share\\folder\\file.csv")


if __name__ == "__main__":
    unittest.main()
