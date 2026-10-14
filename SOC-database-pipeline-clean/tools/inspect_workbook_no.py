from __future__ import annotations

import argparse
from pathlib import Path

import openpyxl


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--no", required=True)
    args = parser.parse_args()

    wb = openpyxl.load_workbook(Path(args.workbook), read_only=True, data_only=True)
    ws = wb[args.sheet]
    found = []
    for row in ws.iter_rows(min_row=3, values_only=False):
        if str(row[0].value).strip() == args.no:
            found.append(
                {
                    "row": row[0].row,
                    "no": row[0].value,
                    "reference": row[1].value,
                    "treatment": row[2].value,
                    "year": row[3].value,
                    "soc": row[15].value,
                }
            )
    print(f"count={len(found)}")
    for item in found:
        print(item)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
