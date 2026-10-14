from __future__ import annotations

import argparse
import shutil
from datetime import datetime
from pathlib import Path

import openpyxl


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--old", required=True)
    parser.add_argument("--new", required=True)
    args = parser.parse_args()

    workbook_path = Path(args.workbook)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = workbook_path.with_name(
        f"{workbook_path.stem}.bak_before_fix_no_{args.new}_{timestamp}{workbook_path.suffix}"
    )
    shutil.copy2(workbook_path, backup)

    wb = openpyxl.load_workbook(workbook_path)
    ws = wb[args.sheet]
    changed = 0
    for row in ws.iter_rows(min_row=3):
        if str(row[0].value).strip() == args.old:
            row[0].value = args.new
            changed += 1
    wb.save(workbook_path)

    print(f"backup={backup}")
    print(f"changed={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
