from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import collection_endpoint


FIELDS = [
    "Reference",
    "SOC_layer",
    "depth_top_cm",
    "depth_bottom_cm",
    "lon_dd",
    "lat_dd",
    "china_province",
]


def write_model_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


class CollectionEndpointTest(unittest.TestCase):
    def test_model_readiness_counts_valid_unique_points_layers_and_regions(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            model_csv = Path(td) / "model.csv"
            write_model_csv(
                model_csv,
                [
                    {"Reference": "A", "SOC_layer": "0_30", "depth_top_cm": "0", "depth_bottom_cm": "30", "lon_dd": "126", "lat_dd": "46", "china_province": "Heilongjiang"},
                    {"Reference": "A", "SOC_layer": "0_30", "depth_top_cm": "0", "depth_bottom_cm": "30", "lon_dd": "126", "lat_dd": "46", "china_province": "Heilongjiang"},
                    {"Reference": "B", "SOC_layer": "30_60", "depth_top_cm": "30", "depth_bottom_cm": "60", "lon_dd": "116", "lat_dd": "39", "china_province": "Hebei"},
                    {"Reference": "C", "SOC_layer": "60_100", "depth_top_cm": "60", "depth_bottom_cm": "100", "lon_dd": "113", "lat_dd": "23", "china_province": "Guangdong"},
                    {"Reference": "D", "SOC_layer": "0_30", "depth_top_cm": "0", "depth_bottom_cm": "30", "lon_dd": "-119", "lat_dd": "-32", "china_province": "Jiangsu"},
                    {"Reference": "E", "SOC_layer": "0_20", "depth_top_cm": "0", "depth_bottom_cm": "20", "lon_dd": "114", "lat_dd": "34", "china_province": "Henan"},
                    {"Reference": "F", "SOC_layer": "0_40", "depth_top_cm": "0", "depth_bottom_cm": "40", "lon_dd": "112", "lat_dd": "31", "china_province": "Hubei"},
                ],
            )

            metrics = collection_endpoint.measure_model_readiness_metrics(model_csv)

        self.assertEqual(metrics["model_rows"], 7)
        self.assertEqual(metrics["valid_rows"], 6)
        self.assertEqual(metrics["invalid_coordinate_rows"], 1)
        self.assertAlmostEqual(metrics["invalid_coordinate_rate"], round(1 / 7, 6))
        self.assertEqual(metrics["valid_unique_points"], 5)
        self.assertEqual(metrics["valid_surface_points_0_30"], 2)
        self.assertEqual(metrics["valid_deep_points_30_60"], 1)
        self.assertEqual(metrics["valid_deep_points_60_100"], 1)
        self.assertEqual(metrics["agro_region_unique_points"]["Northeast"], 1)
        self.assertEqual(metrics["min_agro_region_unique_points"], 0)
        self.assertEqual(metrics["max_rows_per_point"], 2)
        self.assertAlmostEqual(metrics["max_rows_per_point_share"], round(2 / 7, 6))

    def test_report_uses_minimum_and_maximum_requirements(self) -> None:
        report = collection_endpoint.build_report(
            {
                "valid_unique_points": 520,
                "valid_surface_points_0_30": 500,
                "min_agro_region_unique_points": 62,
                "invalid_coordinate_rate": 0.01,
            },
            {
                "requirements": {
                    "valid_unique_points": {"min": 500},
                    "valid_surface_points_0_30": {"min": 500},
                    "min_agro_region_unique_points": {"min": 60},
                    "invalid_coordinate_rate": {"max": 0.02},
                }
            },
        )

        self.assertTrue(report["reached"])
        self.assertTrue(report["requirements"]["valid_unique_points"]["reached"])
        self.assertEqual(report["requirements"]["invalid_coordinate_rate"]["remaining"], 0)

    def test_report_fails_when_any_requirement_is_not_met(self) -> None:
        report = collection_endpoint.build_report(
            {"valid_unique_points": 259, "invalid_coordinate_rate": 0.08},
            {
                "requirements": {
                    "valid_unique_points": {"min": 500},
                    "invalid_coordinate_rate": {"max": 0.02},
                }
            },
        )

        self.assertFalse(report["reached"])
        self.assertEqual(report["requirements"]["valid_unique_points"]["remaining"], 241)
        self.assertAlmostEqual(report["requirements"]["invalid_coordinate_rate"]["excess"], 0.06)


if __name__ == "__main__":
    unittest.main()
