"""Report whether the SOC collection has reached the spatial-model endpoint.

The endpoint is configured in collection_endpoint.json and is intentionally
defined on the merged/model-ready CSV, not on raw paper or JSON counts.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "collection_endpoint.json"

AGRO6_REGIONS = [
    "Northeast",
    "North_China_Plain",
    "Loess_Northwest",
    "Middle_Lower_Yangtze",
    "Southwest",
    "South_China",
]

AGRO6_PROVINCES = {
    "Northeast": {"Heilongjiang", "Jilin", "Liaoning", "Inner Mongolia"},
    "North_China_Plain": {"Beijing", "Tianjin", "Hebei", "Shandong", "Henan"},
    "Loess_Northwest": {"Shanxi", "Shaanxi", "Gansu", "Ningxia", "Xinjiang", "Qinghai"},
    "Middle_Lower_Yangtze": {"Jiangsu", "Shanghai", "Zhejiang", "Anhui", "Jiangxi", "Hubei", "Hunan"},
    "Southwest": {"Sichuan", "Chongqing", "Guizhou", "Yunnan", "Tibet", "Xizang"},
    "South_China": {"Fujian", "Guangdong", "Guangxi", "Hainan", "Hong Kong", "Macau", "Taiwan"},
}


def load_config(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    requirements = data.get("requirements", {})
    if not isinstance(requirements, dict) or not requirements:
        raise ValueError(f"{path} must define a non-empty 'requirements' object")
    for key, rule in requirements.items():
        if not isinstance(rule, dict):
            raise ValueError(f"requirement {key!r} must be an object")
        if "min" not in rule and "max" not in rule:
            raise ValueError(f"requirement {key!r} must define 'min' or 'max'")
        for bound in ("min", "max"):
            if bound in rule and not isinstance(rule[bound], (int, float)):
                raise ValueError(f"requirement {key!r}.{bound} must be numeric")
    return data


def parse_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(parsed) or math.isinf(parsed):
        return None
    return parsed


def point_key(row: dict[str, Any], decimals: int = 4) -> str | None:
    lon = parse_float(row.get("lon_dd"))
    lat = parse_float(row.get("lat_dd"))
    if lon is None or lat is None:
        return None
    return f"{round(lon, decimals)}_{round(lat, decimals)}"


def has_valid_china_coordinate(row: dict[str, Any]) -> bool:
    lon = parse_float(row.get("lon_dd"))
    lat = parse_float(row.get("lat_dd"))
    if lon is None or lat is None:
        return False
    return 73 <= lon <= 135 and 18 <= lat <= 54


def layer_matches(row: dict[str, Any], layer_name: str, top_cm: float, bottom_cm: float) -> bool:
    """Return true when a row is within a target layer window.

    Older model outputs only carried SOC_layer labels such as 0_30. Current
    outputs also carry parsed depth bounds, which let endpoint metrics count
    valid surface sublayers such as 0-20 cm without pretending they are 0-30 cm
    observations.
    """
    layer = str(row.get("SOC_layer", "")).strip()
    if layer == layer_name:
        return True
    depth_top = parse_float(row.get("depth_top_cm"))
    depth_bottom = parse_float(row.get("depth_bottom_cm"))
    if depth_top is None or depth_bottom is None:
        return False
    if depth_bottom <= depth_top:
        return False
    return depth_top >= top_cm and depth_bottom <= bottom_cm


def assign_agro_region_6(china_province: Any) -> str:
    province = "" if china_province is None else str(china_province).strip()
    if not province or province.lower() in {"unknown", "outside_china", "nan"}:
        return "Unknown"
    for region, provinces in AGRO6_PROVINCES.items():
        if province in provinces:
            return region
    return "Unknown"


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def measure_model_readiness_metrics(model_csv: Path) -> dict[str, Any]:
    rows = read_csv_rows(model_csv)
    valid_rows = [row for row in rows if has_valid_china_coordinate(row)]
    invalid_coordinate_rows = len(rows) - len(valid_rows)

    valid_points = {point_key(row) for row in valid_rows}
    valid_points.discard(None)

    layer_points: dict[str, set[str]] = {"0_30": set(), "30_60": set(), "60_100": set()}
    agro_region_points: dict[str, set[str]] = {region: set() for region in AGRO6_REGIONS}
    references: set[str] = set()
    point_row_counts: dict[str, int] = {}

    for row in rows:
        reference = str(row.get("Reference", "")).strip()
        if reference:
            references.add(reference)
        key = point_key(row)
        if key is not None:
            point_row_counts[key] = point_row_counts.get(key, 0) + 1

    for row in valid_rows:
        key = point_key(row)
        if key is None:
            continue
        if layer_matches(row, "0_30", 0, 30):
            layer_points["0_30"].add(key)
        if layer_matches(row, "30_60", 30, 60):
            layer_points["30_60"].add(key)
        if layer_matches(row, "60_100", 60, 100):
            layer_points["60_100"].add(key)
        region = assign_agro_region_6(row.get("china_province"))
        if region in agro_region_points:
            agro_region_points[region].add(key)

    agro_region_unique_points = {
        region: len(points) for region, points in agro_region_points.items()
    }
    max_rows_per_point = max(point_row_counts.values(), default=0)

    return {
        "model_rows": len(rows),
        "valid_rows": len(valid_rows),
        "invalid_coordinate_rows": invalid_coordinate_rows,
        "invalid_coordinate_rate": round(invalid_coordinate_rows / len(rows), 6) if rows else 1.0,
        "valid_unique_points": len(valid_points),
        "valid_surface_points_0_30": len(layer_points["0_30"]),
        "valid_deep_points_30_60": len(layer_points["30_60"]),
        "valid_deep_points_60_100": len(layer_points["60_100"]),
        "agro_region_unique_points": agro_region_unique_points,
        "min_agro_region_unique_points": min(agro_region_unique_points.values(), default=0),
        "max_rows_per_point": max_rows_per_point,
        "max_rows_per_point_share": round(max_rows_per_point / len(rows), 6) if rows else 1.0,
        "unique_references": len(references),
    }


def count_indexed_papers(index_csv: Path) -> int:
    if not index_csv.exists():
        return 0
    with index_csv.open(encoding="utf-8-sig", newline="") as fh:
        return sum(1 for _ in csv.DictReader(fh))


def iter_output_objects(outputs_dir: Path) -> list[dict[str, Any]]:
    if not outputs_dir.exists():
        return []
    objects: list[dict[str, Any]] = []
    for path in sorted(outputs_dir.glob("*.json")):
        try:
            with path.open(encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            objects.append(data)
    return objects


def measure_metrics(root: Path) -> dict[str, int]:
    output_objects = iter_output_objects(root / "outputs")
    extracted = [
        obj for obj in output_objects
        if str(obj.get("status", "")).lower() in {"ok", "partial"}
        and isinstance(obj.get("rows"), list)
        and len(obj["rows"]) > 0
    ]
    return {
        "indexed_papers": count_indexed_papers(root / "papers_index.csv"),
        "output_files": len(output_objects),
        "extracted_papers": len(extracted),
        "soc_rows": sum(len(obj["rows"]) for obj in extracted),
    }


def build_report(metrics: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    requirement_report: dict[str, dict[str, int | float | bool | None]] = {}
    all_reached = True
    for name, rule in config["requirements"].items():
        current = metrics.get(name, 0)
        min_value = rule.get("min")
        max_value = rule.get("max")
        min_reached = True if min_value is None else current >= min_value
        max_reached = True if max_value is None else current <= max_value
        reached = min_reached and max_reached
        all_reached = all_reached and reached
        requirement_report[name] = {
            "current": current,
            "min": min_value,
            "max": max_value,
            "remaining": max(min_value - current, 0) if min_value is not None else 0,
            "excess": max(current - max_value, 0) if max_value is not None else 0,
            "progress": round(current / min_value, 4) if min_value else None,
            "reached": reached,
        }
    return {
        "reached": all_reached,
        "metrics": metrics,
        "requirements": requirement_report,
        "monitor_only": config.get("monitor_only", {}),
    }


def summarize_collection_progress(root: Path, config: dict[str, Any]) -> dict[str, Any]:
    model_dataset = Path(config.get("model_dataset", ""))
    if not model_dataset.is_absolute():
        model_dataset = root / model_dataset
    metrics = measure_model_readiness_metrics(model_dataset)
    metrics["pipeline"] = measure_metrics(root)
    return build_report(metrics, config)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="Pipeline root directory")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="Endpoint config JSON")
    parser.add_argument(
        "--fail-open",
        action="store_true",
        help="Return exit code 0 even when the endpoint has not been reached",
    )
    args = parser.parse_args(argv)

    config = load_config(args.config)
    report = summarize_collection_progress(args.root, config)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["reached"] or args.fail_open:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
