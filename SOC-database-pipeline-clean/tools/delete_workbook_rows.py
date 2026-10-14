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
    parser.add_argument("--start-row", type=int, required=True)
    parser.add_argument("--count", type=int, required=True)
    args = parser.parse_args()

    workbook_path = Path(args.workbook)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = workbook_path.with_name(
        f"{workbook_path.stem}.bak_before_delete_rows_{args.start_row}_{timestamp}{workbook_path.suffix}"
    )
    shutil.copy2(workbook_path, backup)

    wb = openpyxl.load_workbook(workbook_path)
    ws = wb[args.sheet]
    ws.delete_rows(args.start_row, args.count)
    wb.save(workbook_path)

    print(f"backup={backup}")
    print(f"deleted_start_row={args.start_row}")
    print(f"deleted_count={args.count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
