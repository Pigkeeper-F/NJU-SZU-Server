"""Generate labeled local-only data for download/UI integration tests."""
import argparse
import csv
import io
import json
from pathlib import Path
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--rows", type=int, default=120000)
    args = parser.parse_args()
    target = Path(args.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        with archive.open("Trade_DetailedTradeMatrix_E_All_Data_(Normalized).csv", "w") as raw:
            with io.TextIOWrapper(raw, encoding="utf-8", newline="") as text:
                writer = csv.writer(text)
                writer.writerow(["Reporter Country Code", "Reporter Country Code (M49)", "Reporter Countries", "Partner Country Code", "Partner Country Code (M49)", "Partner Countries", "Item Code", "Item Code (CPC)", "Item", "Element Code", "Element", "Year Code", "Year", "Unit", "Value", "Flag", "Test Note"])
                for i in range(args.rows):
                    year = "2023" if i % 6 == 0 else "2024"
                    writer.writerow(["2", "004", "TEST Afghanistan", "41", "156", "TEST China", "15", "0111", "TEST Wheat", "5610", "Import Quantity", year, year, "t", "-11.00" if i % 10 == 0 else "0", "E", "TEST_FIXTURE_NOT_RESEARCH_DATA_" + "x" * 220])
        archive.writestr("Flags.csv", "Flag,Description\nE,TEST estimate\n")
    print(json.dumps({"path": str(target), "size": target.stat().st_size, "rows": args.rows, "selected2024": args.rows - (args.rows + 5) // 6}))


if __name__ == "__main__":
    main()
