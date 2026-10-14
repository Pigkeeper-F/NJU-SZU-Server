from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl


def norm_id(value) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return str(int(float(text)))
    except Exception:
        return text


def extract_year(value) -> int | None:
    if value in (None, ""):
        return None
    years = [int(y) for y in re.findall(r"(?:19|20)\d{2}", str(value))]
    years = [y for y in years if 1900 <= y <= 2026]
    return years[0] if years else None


def decade(year: int | None) -> str:
    if year is None:
        return "未注明"
    return f"{year // 10 * 10}s"


def parse_duration(value, sample_year=None) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text)]
    if not nums:
        return None
    # If the field contains start/end years, convert to duration.
    years = [int(x) for x in nums if 1900 <= x <= 2026]
    if len(years) >= 2:
        return float(max(years) - min(years) + 1)
    if len(years) == 1 and sample_year:
        return float(sample_year - years[0] + 1)
    # Otherwise use the first plausible duration number.
    plausible = [x for x in nums if 0 < x <= 100]
    return plausible[0] if plausible else None


def duration_band(duration: float | None) -> str:
    if duration is None:
        return "未注明/无法解析"
    if duration < 10:
        return "<10 年"
    if duration <= 20:
        return "10-20 年"
    return ">20 年"


def normalize_depth(value, row) -> str:
    text = "" if value in (None, "") else str(value).strip()
    if text:
        text = text.replace("—", "-").replace("–", "-").replace("－", "-")
        return re.sub(r"\s+", "", text)
    for col, label in [(18, "0-30"), (21, "30-60"), (24, "60-100")]:
        if col <= len(row) and row[col - 1] not in (None, ""):
            return label
    return "未注明"


def depth_band(depth: str) -> str:
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", depth)]
    if len(nums) >= 2:
        top, bottom = nums[0], nums[1]
        if bottom <= 30:
            return "表层 0-30 cm"
        if top < 30 < bottom:
            return "跨 30 cm"
        if 30 <= top and bottom <= 60:
            return "30-60 cm"
        if 60 <= top and bottom <= 100:
            return "60-100 cm"
        if bottom > 100:
            return ">100 cm"
        return "其他土层"
    if depth == "未注明":
        return "未注明"
    return "其他/无法解析"


def counter_to_list(counter: Counter, limit: int | None = None):
    return [{"name": k, "count": v} for k, v in counter.most_common(limit)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    wb = openpyxl.load_workbook(Path(args.workbook), read_only=True, data_only=True)
    ws = wb["长期定位试验"]

    rows = []
    unique_ids = set()
    for row in ws.iter_rows(min_row=3, values_only=True):
        no = norm_id(row[0])
        if not no:
            continue
        unique_ids.add(no)
        sample_year = extract_year(row[3])
        time_year = extract_year(row[5])
        year = sample_year or time_year
        duration = parse_duration(row[4], year)
        depth = normalize_depth(row[27] if len(row) >= 28 else None, row)
        lon = row[7] if len(row) >= 8 else None
        lat = row[8] if len(row) >= 9 else None
        crop = row[28] if len(row) >= 29 else None
        rows.append(
            {
                "no": no,
                "year": year,
                "duration": duration,
                "duration_band": duration_band(duration),
                "depth": depth,
                "depth_band": depth_band(depth),
                "has_coord": lon not in (None, "") and lat not in (None, ""),
                "crop": "未注明" if crop in (None, "") else str(crop).strip(),
                "has_soc": any(row[col - 1] not in (None, "") for col in (18, 21, 24) if col <= len(row)),
            }
        )

    by_depth_band = Counter(r["depth_band"] for r in rows)
    by_depth = Counter(r["depth"] for r in rows)
    by_year = Counter(r["year"] if r["year"] is not None else "未注明" for r in rows)
    by_decade = Counter(decade(r["year"]) for r in rows)
    by_duration_band = Counter(r["duration_band"] for r in rows)

    ids_by_depth_band = defaultdict(set)
    ids_by_year = defaultdict(set)
    ids_by_decade = defaultdict(set)
    ids_by_duration_band = defaultdict(set)
    for r in rows:
        ids_by_depth_band[r["depth_band"]].add(r["no"])
        ykey = r["year"] if r["year"] is not None else "未注明"
        ids_by_year[ykey].add(r["no"])
        ids_by_decade[decade(r["year"])].add(r["no"])
        ids_by_duration_band[r["duration_band"]].add(r["no"])

    summary = {
        "workbook": str(Path(args.workbook)),
        "sheet": "长期定位试验",
        "total_rows": len(rows),
        "unique_articles": len(unique_ids),
        "rows_with_soc": sum(1 for r in rows if r["has_soc"]),
        "rows_with_coordinates": sum(1 for r in rows if r["has_coord"]),
        "coordinate_coverage_percent": round(sum(1 for r in rows if r["has_coord"]) / len(rows) * 100, 1) if rows else 0,
        "year_min": min((r["year"] for r in rows if r["year"] is not None), default=None),
        "year_max": max((r["year"] for r in rows if r["year"] is not None), default=None),
        "missing_year_rows": sum(1 for r in rows if r["year"] is None),
        "duration_min": min((r["duration"] for r in rows if r["duration"] is not None), default=None),
        "duration_max": max((r["duration"] for r in rows if r["duration"] is not None), default=None),
        "missing_duration_rows": sum(1 for r in rows if r["duration"] is None),
        "duration_band_distribution": [
            {"duration_band": k, "rows": by_duration_band[k], "articles": len(ids_by_duration_band[k])}
            for k in ("<10 年", "10-20 年", ">20 年", "未注明/无法解析")
            if k in by_duration_band
        ],
        "depth_band_distribution": [
            {"depth_band": k, "rows": by_depth_band[k], "articles": len(ids_by_depth_band[k])}
            for k in by_depth_band
        ],
        "top_exact_depths": counter_to_list(by_depth, 20),
        "decade_distribution": [
            {"period": k, "rows": by_decade[k], "articles": len(ids_by_decade[k])}
            for k in sorted(by_decade, key=lambda x: 9999 if x == "未注明" else int(str(x)[:4]))
        ],
        "year_distribution": [
            {"year": k, "rows": by_year[k], "articles": len(ids_by_year[k])}
            for k in sorted(by_year, key=lambda x: 9999 if x == "未注明" else int(x))
        ],
        "top_crops": counter_to_list(Counter(r["crop"] for r in rows), 15),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
