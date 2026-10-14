"""Export sheet schemas from the SOC Database xlsx template.

Produces one JSON per sheet listing {col, group, field} for every column that
has a field name. Handles merged row-1 group headers by forward-filling the
group within the merged range.

Usage:
    python export_schema.py <xlsx_path> <output_dir>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl

# Force UTF-8 stdout on Windows so CJK paths print cleanly.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def build_schema(ws) -> list[dict]:
    """Build a list of {col, group, field} dicts for one worksheet.

    Row 1 holds group headers (merged) OR standalone field names.
    Row 2 holds field names within groups.

    A column is:
      - standalone (group=None, field=row1_value) if row1 has a value and is NOT
        part of a row-1-only merge
      - grouped (group=row1_forward_filled, field=row2_value) if the column is
        inside a row-1-only merged range and row2 has a value
      - skipped if neither row has a usable value
    """
    # Build a map col_index -> the group header that covers it by scanning
    # merged ranges that live only in row 1.
    row1_group: dict[int, str] = {}
    for mr in ws.merged_cells.ranges:
        if mr.min_row == 1 and mr.max_row == 1:
            top_left_value = ws.cell(1, mr.min_col).value
            if top_left_value is None:
                continue
            for c in range(mr.min_col, mr.max_col + 1):
                row1_group[c] = top_left_value

    schema: list[dict] = []
    for col in range(1, ws.max_column + 1):
        row1_val = ws.cell(1, col).value
        row2_val = ws.cell(2, col).value

        group = row1_group.get(col)  # set only if col is inside a row-1 merged group
        if group is not None:
            # Multi-column group (merged row-1 header): field name is in row 2.
            if row2_val is None:
                continue
            schema.append({"col": col, "group": group, "field": row2_val})
        elif row1_val is not None and row2_val is not None:
            # Single-column group (unmerged but has both row1 header and row2 field).
            # E.g. 碳排放 + CH4（kg/ha） — visually looks like a group of one column.
            schema.append({"col": col, "group": row1_val, "field": row2_val})
        elif row1_val is not None:
            # Standalone column: field name is in row 1.
            schema.append({"col": col, "group": None, "field": row1_val})
        # else: both rows empty → skip

    return schema


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: export_schema.py <xlsx_path> <output_dir>", file=sys.stderr)
        return 2

    xlsx_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    wb = openpyxl.load_workbook(xlsx_path)
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        schema = build_schema(ws)
        out_path = out_dir / f"{sheet_name}.json"
        out_path.write_text(
            json.dumps(schema, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"Wrote {out_path} ({len(schema)} fields)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
