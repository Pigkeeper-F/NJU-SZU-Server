import csv
with open("smoke_input.csv", newline="", encoding="utf-8") as source:
    rows = list(csv.DictReader(source))
with open("smoke_output.csv", "w", newline="", encoding="utf-8") as target:
    writer = csv.DictWriter(target, fieldnames=["item", "double_value"])
    writer.writeheader()
    for row in rows:
        writer.writerow({"item": row["item"], "double_value": int(row["value"]) * 3})

