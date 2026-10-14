from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_output_v2


def _base_output(row: dict) -> dict:
    return {
        "source_pdf": "999.pdf",
        "status": "ok",
        "sheet": "点位试验",
        "classification_reason": "test fixture",
        "rows": [row],
        "warnings": [],
        "skip_reason": None,
    }


class ValidateSocRequiredTest(unittest.TestCase):
    def _validate(self, data: dict) -> list[str]:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "999.json"
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return validate_output_v2.validate_file(path)

    def test_non_skipped_rows_must_have_explicit_soc_value(self) -> None:
        data = _base_output(
            {
                "_split_key": "site=A|treatment=CK|year=2020|crop=maize",
                "No.": "999",
                "Reference": "Fixture paper",
                "采样年份": "2020 maize season",
                "Yield（t/ha）": "7.1",
            }
        )

        errors = self._validate(data)

        self.assertTrue(
            any("explicit SOC" in err for err in errors),
            f"expected explicit SOC error, got: {errors}",
        )

    def test_row_with_soc_value_passes_soc_requirement(self) -> None:
        data = _base_output(
            {
                "_split_key": "site=A|treatment=CK|year=2020|crop=maize",
                "No.": "999",
                "Reference": "Fixture paper",
                "采样年份": "2020 maize season",
                "土壤信息.SOC (g/kg)": "12.4",
            }
        )

        errors = self._validate(data)

        self.assertFalse(
            [err for err in errors if "explicit SOC" in err],
            f"unexpected SOC requirement error: {errors}",
        )

    def test_soc_unit_metadata_does_not_count_as_soc_value(self) -> None:
        data = {
            "source_pdf": "999.pdf",
            "status": "ok",
            "sheet": "长期定位试验",
            "classification_reason": "test fixture",
            "rows": [
                {
                    "_split_key": "site=A|treatment=CK|year=2020|crop=maize",
                    "No.": "999",
                    "Reference": "Fixture paper",
                    "采样年份": "2020 maize season",
                    "试验持续时间": "2010-2020",
                    "时间年份": "2020",
                    "SOC.SOC原始单位": "g/kg",
                }
            ],
            "warnings": [],
            "skip_reason": None,
        }

        errors = self._validate(data)

        self.assertTrue(
            any("explicit SOC" in err for err in errors),
            f"expected explicit SOC error, got: {errors}",
        )


if __name__ == "__main__":
    unittest.main()
