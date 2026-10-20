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


def make_zip(path, rows=ROWS, header=HEADER, extra=None):
    text = io.StringIO(newline="")
    writer = csv.writer(text)
    writer.writerow(header)
    writer.writerows(rows)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("Trade_DetailedTradeMatrix_E_All_Data_(Normalized).csv", text.getvalue())
        archive.writestr("Flags.csv", "Flag,Description\nA,Official\n")
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
