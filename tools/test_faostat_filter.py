import csv
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("faostat_filter", Path(__file__).with_name("faostat_filter.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
HEADER = ["Reporter Country Code", "Reporter Country Code (M49)", "Partner Country Code", "Item Code", "Element Code", "Element", "Year", "Unit", "Value", "Flag"]
ROWS = [["2", "004", "41", "15", "5610", "Import Quantity", "2023", "t", "0", "A"],
        ["2", "004", "41", "15", "5610", "Import Quantity", "2024", "t", "-11.00", "E"],
        ["2", "004", "41", "15", "5622", "Import Value", "2024", "1000 USD", "1.50", "A"]]
DICTIONARIES = {
    "ItemCodes": [["Item Code", "Item"], ["15", "Wheat"], ["16", "Wheat and meslin flour"]],
    "Elements": [["Element Code", "Element"],
                 ["5607", "Import quantity"], ["5608", "Import quantity"],
                 ["5609", "Import quantity"], ["5610", "Import quantity"],
                 ["5907", "Export quantity"], ["5908", "Export quantity"],
                 ["5909", "Export quantity"], ["5910", "Export quantity"],
                 ["5622", "Import value"], ["5922", "Export value"]],
    "ReporterCountries": [["Reporter Country Code", "Reporter Countries"],
                          ["2", "Afghanistan"], ["41", "China, mainland"], ["5100", "Africa"]],
    "PartnerCountries": [["Partner Country Code", "Partner Countries"],
                         ["2", "Afghanistan"], ["41", "China, mainland"], ["5100", "Africa"]],
}


def make_zip(path, rows=ROWS, header=HEADER, extra=None, dictionaries=None, omit=()):
    text = io.StringIO(newline="")
    writer = csv.writer(text)
    writer.writerow(header)
    writer.writerows(rows)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("Trade_DetailedTradeMatrix_E_All_Data_(Normalized).csv", text.getvalue())
        archive.writestr("Flags.csv", "Flag,Description\nA,Official\n")
        for kind, dictionary_rows in (DICTIONARIES if dictionaries is None else dictionaries).items():
            if kind in omit:
                continue
            table = io.StringIO(newline="")
            csv.writer(table).writerows(dictionary_rows)
            archive.writestr(f"Trade_DetailedTradeMatrix_E_{kind}.csv", table.getvalue())
        if extra:
            archive.writestr(extra, "bad")


class FilteringTest(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).resolve().parents[1] / ".workbench" / "test-fixtures"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="yanxu-faostat-filter-", dir=base)
        self.root = Path(self.temp.name)
        self.archive = self.root / "source.zip"
        make_zip(self.archive)

    def tearDown(self):
        self.temp.cleanup()

    def run_filter(self, config):
        return module.filter_archive(self.archive, config, self.root / "result", on_progress=lambda **x: None)

    def selected_rows(self, result):
        file = self.root / "result" / result["files"][0]["name"]
        with file.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            self.assertEqual(next(reader), HEADER)
            return list(reader)

    def assert_resolution_failure(self, filters):
        with self.assertRaises(ValueError) as caught:
            self.run_filter({"years": [2024], "filters": filters})
        self.assertNotIn("不支持的筛选条件", str(caught.exception),
                         "Named filters must be supported; this case must fail for its specific resolution problem")

    def test_year_values_and_flags_are_preserved(self):
        result = self.run_filter({"years": [2024], "filters": {}})
        self.assertEqual(result["sourceRows"], 3)
        self.assertEqual(result["rowsSelected"], 2)
        self.assertTrue(result["zipCRCVerified"])
        file = self.root / "result" / result["files"][0]["name"]
        with file.open(encoding="utf-8-sig", newline="") as handle:
            self.assertEqual(list(csv.reader(handle)), [HEADER] + ROWS[1:])
        self.assertEqual(module.file_sha(file), result["files"][0]["sha256"])

    def test_explicit_filters(self):
        result = self.run_filter({"years": [2024], "filters": {"elementNames": ["Import Quantity"], "reporterCodes": ["2"]}})
        self.assertEqual(result["rowsSelected"], 1)

    def test_exact_wheat_name_does_not_expand_to_wheat_flour(self):
        wheat = ["2", "'004", "41", "15", "5610", "Import quantity", "2024", "t", "12.00", "A"]
        flour = ["2", "'004", "41", "16", "5610", "Import quantity", "2024", "t", "99", "A"]
        make_zip(self.archive, [wheat, flour])
        original_hash = module.file_sha(self.archive)
        result = self.run_filter({"years": [2024], "filters": {"itemNames": ["Wheat"]}})
        self.assertEqual(self.selected_rows(result), [wheat])
        self.assertEqual(set(result["resolvedConfig"]["filters"]["itemCodes"]), {"15"})
        self.assertTrue(result["officialMappings"])
        self.assertEqual(module.file_sha(self.archive), original_hash, "Official archive must remain unchanged")

    def test_quantity_names_select_every_official_code_and_exclude_value(self):
        quantity_codes = {"5607", "5608", "5609", "5610", "5907", "5908", "5909", "5910"}
        rows = [["2", "004", "41", "15", code,
                 "Import quantity" if code.startswith("56") else "Export quantity",
                 "2024", "t", str(index + 1), "A"]
                for index, code in enumerate(sorted(quantity_codes))]
        rows.extend([["2", "004", "41", "15", "5622", "Import value", "2024", "1000 USD", "10", "A"],
                     ["2", "004", "41", "15", "5922", "Export value", "2024", "1000 USD", "20", "A"]])
        make_zip(self.archive, rows)
        result = self.run_filter({"years": [2024], "filters": {
            "itemNames": ["Wheat"], "elementNames": ["Import Quantity", "Export Quantity"]}})
        self.assertEqual(result["rowsSelected"], 8)
        self.assertEqual({row[4] for row in self.selected_rows(result)}, quantity_codes)
        self.assertEqual(set(result["resolvedConfig"]["filters"]["elementCodes"]), quantity_codes)
        units = {record["elementCode"]: (record["element"].casefold(), record["unit"], record["rows"])
                 for record in result["unitsByElement"]}
        self.assertEqual(units, {code: ("import quantity" if code.startswith("56") else "export quantity", "t", 1)
                                 for code in quantity_codes},
                         "Unit counts must cover every selected quantity code and exclude value records")

    def test_name_matching_is_case_insensitive_for_item_and_both_country_roles(self):
        other_reporter = ["41", "156", "41", "15", "5610", "Import quantity", "2024", "t", "9", "A"]
        other_partner = ["2", "004", "2", "15", "5610", "Import quantity", "2024", "t", "8", "A"]
        make_zip(self.archive, ROWS + [other_reporter, other_partner])
        result = self.run_filter({"years": [2024], "filters": {
            "itemNames": ["wHeAt"], "reporterNames": ["AFGHANISTAN"],
            "partnerNames": ["china, MAINLAND"], "elementNames": ["IMPORT QUANTITY"]}})
        self.assertEqual(self.selected_rows(result), [ROWS[1]])
        resolved = result["resolvedConfig"]["filters"]
        self.assertEqual(set(resolved["reporterCodes"]), {"2"})
        self.assertEqual(set(resolved["partnerCodes"]), {"41"})

    def test_duplicate_item_name_with_distinct_codes_requires_clarification(self):
        dictionaries = {kind: [row[:] for row in rows] for kind, rows in DICTIONARIES.items()}
        dictionaries["ItemCodes"].append(["999", "wheat"])
        make_zip(self.archive, dictionaries=dictionaries)
        self.assert_resolution_failure({"itemNames": ["Wheat"]})

    def test_duplicate_country_name_with_distinct_codes_requires_clarification(self):
        for role, field in [("ReporterCountries", "reporterNames"), ("PartnerCountries", "partnerNames")]:
            with self.subTest(role=role):
                dictionaries = {kind: [row[:] for row in rows] for kind, rows in DICTIONARIES.items()}
                dictionaries[role].append(["999", "AFGHANISTAN"])
                make_zip(self.archive, dictionaries=dictionaries)
                self.assert_resolution_failure({field: ["Afghanistan"]})

    def test_name_and_code_conflict_is_not_silently_intersected_or_ignored(self):
        for filters in [
                {"itemNames": ["Wheat"], "itemCodes": ["16"]},
                {"reporterNames": ["Afghanistan"], "reporterCodes": ["41"]},
                {"partnerNames": ["China, mainland"], "partnerCodes": ["2"]},
                {"elementNames": ["Import quantity"], "elementCodes": ["5622"]}]:
            with self.subTest(filters=filters):
                self.assert_resolution_failure(filters)

    def test_names_cannot_be_resolved_without_their_official_dictionary(self):
        for kind, filters in [
                ("ItemCodes", {"itemNames": ["Wheat"]}),
                ("Elements", {"elementNames": ["Import quantity"]}),
                ("ReporterCountries", {"reporterNames": ["Afghanistan"]}),
                ("PartnerCountries", {"partnerNames": ["China, mainland"]})]:
            with self.subTest(kind=kind):
                make_zip(self.archive, omit=[kind])
                self.assert_resolution_failure(filters)

    def test_partial_name_is_not_a_fallback_for_unmatched_exact_name(self):
        self.assert_resolution_failure({"itemNames": ["Whea"]})

    def test_consistent_explicit_name_and_code_are_accepted(self):
        result = self.run_filter({"years": [2024], "filters": {
            "itemNames": ["Wheat"], "itemCodes": ["15"],
            "reporterNames": ["Afghanistan"], "reporterCodes": ["2"]}})
        self.assertEqual(self.selected_rows(result), ROWS[1:])

    def test_no_matching_year_is_failure(self):
        with self.assertRaisesRegex(ValueError, "没有数据"):
            self.run_filter({"years": [2022]})

    def test_bad_row_is_not_silently_skipped(self):
        make_zip(self.archive, ROWS + [["bad"]])
        with self.assertRaisesRegex(ValueError, "字段数量"):
            self.run_filter({"years": [2024]})

    def test_unsafe_member(self):
        make_zip(self.archive, extra="../outside.csv")
        with self.assertRaisesRegex(ValueError, "不安全"):
            self.run_filter({"years": [2024]})

    def test_unknown_filter_is_not_ignored(self):
        with self.assertRaisesRegex(ValueError, "不支持"):
            self.run_filter({"years": [2024], "filters": {"other": ["x"]}})

    def test_crc_corruption_fails(self):
        data = self.archive.read_bytes()
        self.archive.write_bytes(data.replace(b"-11.00", b"-22.00", 1))
        with self.assertRaises(zipfile.BadZipFile):
            self.run_filter({"years": [2024]})


if __name__ == "__main__":
    unittest.main()
