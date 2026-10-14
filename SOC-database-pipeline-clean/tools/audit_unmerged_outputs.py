from __future__ import annotations

import json
import sys
from collections import Counter
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


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: audit_unmerged_outputs.py <repo_dir> <workbook>")
        return 2
    repo = Path(sys.argv[1])
    workbook_path = Path(sys.argv[2])
    wb = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)

    workbook_ids: set[str] = set()
    workbook_counts = {}
    workbook_rows = {}
    for sheet_name in ("点位试验", "长期定位试验"):
        ws = wb[sheet_name]
        ids: set[str] = set()
        rows = 0
        for row in ws.iter_rows(min_row=3, values_only=True):
            no = norm_id(row[0] if row else None)
            if no is None:
                continue
            ids.add(no)
            workbook_ids.add(no)
            rows += 1
        workbook_counts[sheet_name] = len(ids)
        workbook_rows[sheet_name] = rows

    output_ids: set[str] = set()
    output_sheet: dict[str, str] = {}
    output_rows: dict[str, int] = {}
    skipped = 0
    bad = []
    for path in sorted((repo / "outputs").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            bad.append((path.name, str(exc)))
            continue
        if data.get("status") == "skipped":
            skipped += 1
            continue
        sid = path.stem
        output_ids.add(sid)
        output_sheet[sid] = data.get("sheet")
        output_rows[sid] = len(data.get("rows") or [])

    missing = sorted(output_ids - workbook_ids, key=lambda x: int(x) if x.isdigit() else 10**9)
    extra = sorted(workbook_ids - output_ids, key=lambda x: int(x) if x.isdigit() else 10**9)
    missing_counter = Counter(output_sheet[i] for i in missing)
    missing_row_counter = Counter()
    for mid in missing:
        missing_row_counter[output_sheet[mid]] += output_rows.get(mid, 0)

    print(f"workbook={workbook_path}")
    print(f"workbook_unique={workbook_counts}")
    print(f"workbook_rows={workbook_rows}")
    print(f"outputs_non_skipped={len(output_ids)}")
    print(f"outputs_skipped={skipped}")
    print(f"outputs_bad_json={len(bad)}")
    print(f"missing_count={len(missing)}")
    print(f"missing_by_sheet={dict(missing_counter)}")
    print(f"missing_rows_by_sheet={dict(missing_row_counter)}")
    print(f"missing_first={missing[:60]}")
    print(f"missing_last={missing[-30:]}")
    print(f"extra_count={len(extra)}")
    print(f"extra_first={extra[:60]}")
    if bad:
        print(f"bad_first={bad[:10]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
