"""Create a small, genuine FBSH excerpt for a read-only workflow trial."""

import csv
import io
import zipfile
from pathlib import Path


SOURCE = Path(r"D:\claudecode\model1992\data_download\FoodBalanceSheetsHistoric_E_All_Data_(Normalized).zip")
OUTPUT = Path(__file__).with_name("FBSH_1992_Afghanistan_练习样本.csv")
ELEMENT_CODES = {"5511", "5611", "5911", "5074", "5142", "5521"}
LIMIT = 80

with zipfile.ZipFile(SOURCE) as archive:
    name = next(name for name in archive.namelist() if name.endswith("(Normalized).csv"))
    with archive.open(name) as binary, OUTPUT.open("w", encoding="utf-8-sig", newline="") as target:
        reader = csv.DictReader(io.TextIOWrapper(binary, encoding="utf-8-sig", newline=""))
        writer = csv.DictWriter(target, fieldnames=reader.fieldnames)
        writer.writeheader()
        count = 0
        for row in reader:
            if row["Year"] != "1992" or row["Area Code (M49)"].lstrip("'") != "004":
                continue
            if row["Element Code"] not in ELEMENT_CODES:
                continue
            writer.writerow(row)
            count += 1
            if count == LIMIT:
                break

print(f"Wrote {count} source rows to {OUTPUT}")
