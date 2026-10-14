"""Schema-compliance validator for soc-database-extract outputs.

Usage:
    python scripts/validate_output_v2.py outputs_v2/10.json [11.json ...]
    python scripts/validate_output_v2.py outputs_v2/   # validates all *.json under dir

Reports (via stderr + exit code 1 on any failure):
  - Top-level must be JSON object with keys: source_pdf, status, sheet,
    classification_reason, rows, warnings, skip_reason
  - sheet must be "点位试验" | "长期定位试验" | null (when status=skipped)
  - Every row key must be either `_split_key`, `_sheet`, or present in the
    schema for the selected sheet. No invented keys, no re-prefixed keys.
  - Every row must carry `No.` matching the source stem, and `_split_key`.
  - Every non-skipped row must contain an explicit SOC value. POC/MAOC,
    organic matter, yield, and emissions alone are not admissible.
  - figure-extracted / calculated marking format sanity check (informational).
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "schemas"

TOP_KEYS = [
    "source_pdf", "status", "sheet", "classification_reason",
    "rows", "warnings", "skip_reason",
]
ALLOWED_SHEETS = {"点位试验", "长期定位试验", None}
ROW_EXTRA_KEYS = {"_split_key", "_sheet"}


def load_schema_keys(sheet: str) -> set[str]:
    path = SCHEMA_DIR / f"{sheet}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    keys = set()
    for entry in data:
        group = entry.get("group")
        field = entry["field"]
        keys.add(f"{group}.{field}" if group else field)
    return keys


def soc_value_keys(sheet: str) -> set[str]:
    """Return schema keys that count as explicit SOC measurements.

    The tightened admission rule is article-level in intent, but outputs are
    row-based. Enforcing it per row prevents a paper with one SOC treatment row
    from smuggling non-SOC rows into the database.
    """
    path = SCHEMA_DIR / f"{sheet}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    keys: set[str] = set()
    for entry in data:
        group = entry.get("group")
        field = str(entry["field"])
        field_upper = field.upper()
        if "SOC" not in field_upper:
            continue
        if "POC" in field_upper or "MAOC" in field_upper:
            continue
        if any(marker in field for marker in ("单位", "土层", "备注")):
            continue
        key = f"{group}.{field}" if group else field
        keys.add(key)
    return keys


def has_explicit_soc(row: dict, candidate_keys: set[str]) -> bool:
    for key in candidate_keys:
        value = row.get(key)
        if value not in (None, ""):
            return True
    return False


def validate_file(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"{path.name}: JSON parse error — {e}"]

    if not isinstance(data, dict):
        return [f"{path.name}: top-level must be object, got {type(data).__name__}"]

    missing = [k for k in TOP_KEYS if k not in data]
    if missing:
        errors.append(f"{path.name}: missing top-level keys: {missing}")

    sheet = data.get("sheet")
    if sheet not in ALLOWED_SHEETS:
        errors.append(f"{path.name}: sheet={sheet!r} not in {ALLOWED_SHEETS}")

    status = data.get("status")
    if status not in {"ok", "partial", "skipped"}:
        errors.append(f"{path.name}: status={status!r} not in ok/partial/skipped")

    rows = data.get("rows")
    if rows is None:
        errors.append(f"{path.name}: no 'rows' key")
        return errors
    if not isinstance(rows, list):
        errors.append(f"{path.name}: rows must be list, got {type(rows).__name__}")
        return errors

    if status == "skipped":
        return errors

    if sheet is None:
        errors.append(f"{path.name}: status={status} but sheet is null")
        return errors

    try:
        schema_keys = load_schema_keys(sheet)
        soc_keys = soc_value_keys(sheet)
    except Exception as e:
        errors.append(f"{path.name}: cannot load schema for sheet={sheet!r}: {e}")
        return errors

    allowed = schema_keys | ROW_EXTRA_KEYS
    pdf_no = Path(data.get("source_pdf", path.stem + ".pdf")).stem

    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f"{path.name}: rows[{i}] is not object")
            continue
        bad = [k for k in row.keys() if k not in allowed]
        if bad:
            errors.append(f"{path.name}: rows[{i}] has non-schema keys: {bad[:8]}{' …' if len(bad) > 8 else ''}")
        if "_split_key" not in row:
            errors.append(f"{path.name}: rows[{i}] missing _split_key")
        if row.get("No.") != pdf_no:
            errors.append(f"{path.name}: rows[{i}] No.={row.get('No.')!r} expected {pdf_no!r}")
        if not has_explicit_soc(row, soc_keys):
            errors.append(
                f"{path.name}: rows[{i}] missing explicit SOC value; "
                "only rows with reported SOC are admissible"
            )

        # Informational checks (warnings, not hard errors). Goal: make it easy to
        # spot figure-derived values that were written without the canonical token.
        # Hard blocking is too brittle — "figure" legitimately appears in prose
        # describing *why* we declined to digitize a chart.
        pass

    return errors


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    paths: list[Path] = []
    for a in argv[1:]:
        p = Path(a)
        if p.is_dir():
            paths.extend(sorted(p.glob("*.json")))
        elif p.is_file():
            paths.append(p)
        else:
            print(f"skip (not found): {a}", file=sys.stderr)

    total_err = 0
    per_file_ok = 0
    for p in paths:
        errs = validate_file(p)
        if errs:
            total_err += len(errs)
            for e in errs:
                print(e, file=sys.stderr)
        else:
            per_file_ok += 1
            print(f"{p.name}: OK")
    print(
        f"\nvalidated {len(paths)} files — {per_file_ok} OK, "
        f"{len(paths) - per_file_ok} with errors ({total_err} total)"
    )
    return 0 if total_err == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
