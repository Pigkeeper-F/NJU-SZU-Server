"""Merge outputs/*.json files into the final SOC database xlsx.

Reads per-PDF JSON files, disambiguates fields using composite keys
({group}.{field} or {field} for ungrouped), writes rows in schema column
order, and produces a markdown merge report.

Usage:
    python merge.py --template <xlsx> --schemas <dir> \
                    --outputs <dir> --target <xlsx> --report <md>
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

import openpyxl

# Force UTF-8 stdout on Windows so CJK paths print cleanly.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def composite_key(field_entry: dict) -> str:
    """Build the JSON key for a schema field entry."""
    if field_entry["group"]:
        return f"{field_entry['group']}.{field_entry['field']}"
    return field_entry["field"]


def load_schemas(schemas_dir: Path) -> dict[str, list[dict]]:
    schemas = {}
    for sheet in ("点位试验", "长期定位试验"):
        path = schemas_dir / f"{sheet}.json"
        schemas[sheet] = json.loads(path.read_text(encoding="utf-8"))
    return schemas


def numeric_stem(path: Path) -> tuple[int, str]:
    """Sort key so 1.json, 2.json, 10.json sort numerically."""
    m = re.match(r"^(\d+)", path.stem)
    if m:
        return (int(m.group(1)), path.name)
    return (10**9, path.name)


def load_outputs(outputs_dir: Path) -> list[tuple[Path, dict]]:
    """Load every *.json under outputs/ sorted numerically by filename."""
    files = sorted(outputs_dir.glob("*.json"), key=numeric_stem)
    result = []
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            result.append((f, data))
        except json.JSONDecodeError as e:
            print(f"WARN: could not parse {f}: {e}", file=sys.stderr)
    return result


def clear_sample_row(ws) -> None:
    """Delete all template data rows while keeping the two header rows."""
    if ws.max_row >= 3:
        ws.delete_rows(3, ws.max_row - 2)


def write_row(ws, schema: list[dict], next_row: int, row_data: dict) -> list[str]:
    """Write one data row into ws at next_row; return list of unmapped keys."""
    schema_keys = {composite_key(f) for f in schema}

    # Write known fields
    for field in schema:
        key = composite_key(field)
        value = row_data.get(key)
        if value not in (None, ""):
            ws.cell(next_row, field["col"], value)

    # Detect unmapped keys (in row_data but not in schema, excluding _split_key)
    unmapped = []
    for k, v in row_data.items():
        if k == "_split_key":
            continue
        if k in schema_keys:
            continue
        if v in (None, ""):
            continue
        unmapped.append(f"{k}={v}")

    # If anything unmapped, append to the overall remarks column.
    # Support both the current "备注" field and the older
    # "备注-结果/计算说明" field so legacy schemas still work.
    if unmapped:
        overall_remark_field = next(
            (
                f
                for f in schema
                if f["group"] is None
                and f["field"] in ("备注-结果/计算说明", "备注")
            ),
            None,
        )
        if overall_remark_field:
            existing = ws.cell(next_row, overall_remark_field["col"]).value or ""
            prefix = f"[unmapped] {'; '.join(unmapped)}"
            combined = f"{prefix} | {existing}" if existing else prefix
            ws.cell(next_row, overall_remark_field["col"], combined)

    return unmapped


def compute_fill_rates(
    ws, schema: list[dict], data_start_row: int, data_end_row: int
) -> dict[str, float]:
    """Return {composite_key: fill_rate_0_to_1} per column."""
    if data_end_row < data_start_row:
        return {composite_key(f): 0.0 for f in schema}
    total = data_end_row - data_start_row + 1
    rates = {}
    for f in schema:
        non_empty = 0
        for r in range(data_start_row, data_end_row + 1):
            v = ws.cell(r, f["col"]).value
            if v not in (None, ""):
                non_empty += 1
        rates[composite_key(f)] = non_empty / total if total else 0.0
    return rates


def format_report(
    per_sheet_counts: dict[str, int],
    skipped: list[tuple[str, str]],
    partial: list[tuple[str, list[str]]],
    failed: list[tuple[str, str]],
    fill_rates: dict[str, dict[str, float]],
) -> str:
    lines = ["# Merge Report", ""]
    lines.append("## Row counts")
    for sheet, n in per_sheet_counts.items():
        lines.append(f"- {sheet}: {n} rows")
    lines.append("")

    lines.append(f"## Skipped ({len(skipped)})")
    if skipped:
        for src, reason in skipped:
            lines.append(f"- {src}: {reason}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append(f"## Partial / with warnings ({len(partial)})")
    if partial:
        for src, warns in partial:
            lines.append(f"- {src}")
            for w in warns:
                lines.append(f"  - {w}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append(f"## Failed ({len(failed)})")
    if failed:
        for src, reason in failed:
            lines.append(f"- {src}: {reason}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Column fill rates")
    for sheet, rates in fill_rates.items():
        lines.append(f"### {sheet}")
        low = [(k, r) for k, r in rates.items() if r < 0.1]
        if low:
            lines.append("Columns below 10% fill:")
            for k, r in sorted(low, key=lambda x: x[1]):
                lines.append(f"- {k}: {r*100:.0f}%")
        else:
            lines.append("(no columns below 10% fill)")
        lines.append("")

    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--schemas", required=True)
    parser.add_argument("--outputs", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    template = Path(args.template)
    schemas_dir = Path(args.schemas)
    outputs_dir = Path(args.outputs)
    target = Path(args.target)
    report_path = Path(args.report)

    # Copy template -> target (always start from clean template)
    shutil.copyfile(template, target)
    wb = openpyxl.load_workbook(target)

    schemas = load_schemas(schemas_dir)

    # Clear sample row (row 3) from both sheets
    for sheet_name in ("点位试验", "长期定位试验"):
        clear_sample_row(wb[sheet_name])

    # Load outputs
    loaded = load_outputs(outputs_dir)

    per_sheet_next_row = {"点位试验": 3, "长期定位试验": 3}
    per_sheet_counts = {"点位试验": 0, "长期定位试验": 0}
    skipped: list[tuple[str, str]] = []
    partial: list[tuple[str, list[str]]] = []
    failed: list[tuple[str, str]] = []

    for path, data in loaded:
        if isinstance(data, list):
            failed.append((path.name, "old list format — needs re-extraction"))
            continue
        status = data.get("status")
        source = data.get("source_pdf", path.name)

        if status == "skipped":
            skipped.append((source, data.get("skip_reason") or "(no reason)"))
            continue

        sheet = data.get("sheet")
        if sheet not in ("点位试验", "长期定位试验"):
            failed.append((source, f"invalid sheet: {sheet!r}"))
            continue

        ws = wb[sheet]
        schema = schemas[sheet]
        for row in data.get("rows", []):
            write_row(ws, schema, per_sheet_next_row[sheet], row)
            per_sheet_next_row[sheet] += 1
            per_sheet_counts[sheet] += 1

        if status == "partial" or data.get("warnings"):
            partial.append((source, data.get("warnings", [])))

    wb.save(target)

    # Compute fill rates (reload workbook to read what was just written)
    wb2 = openpyxl.load_workbook(target)
    fill_rates = {}
    for sheet_name in ("点位试验", "长期定位试验"):
        ws = wb2[sheet_name]
        schema = schemas[sheet_name]
        start = 3
        end = per_sheet_next_row[sheet_name] - 1
        fill_rates[sheet_name] = compute_fill_rates(ws, schema, start, end)

    report_text = format_report(per_sheet_counts, skipped, partial, failed, fill_rates)
    report_path.write_text(report_text, encoding="utf-8")

    print(
        f"Merge complete: {per_sheet_counts['点位试验']} + "
        f"{per_sheet_counts['长期定位试验']} rows"
    )
    print(f"Target: {target}")
    print(f"Report: {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
