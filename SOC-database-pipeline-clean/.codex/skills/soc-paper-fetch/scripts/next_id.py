"""Print the next paper id based on files in papers/ and papers_index.csv.

Output: a JSON object like {"next_id": 61, "papers_dir": "...", "floor": 1}.

Collaborators use a reserved id range so their downloads don't collide with the
main corpus. Pass `--min 1001` (or whichever floor has been assigned) and the
returned id will be at least that value. Norascat's main corpus has no floor.
"""
from __future__ import annotations

import argparse
import csv
import re

from common import next_paper_id, papers_dir, print_json


def _highest_in_index() -> int:
    """Highest id in papers_index.csv (0 if absent / empty)."""
    idx = papers_dir().parent / "papers_index.csv"
    if not idx.exists():
        return 0
    highest = 0
    with idx.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                highest = max(highest, int(row.get("id", "0")))
            except ValueError:
                continue
    return highest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=1,
                    help="Floor id (collaborators pass e.g. 1001 to reserve a range)")
    args = ap.parse_args()

    # Consider both the corpus directory and the shared index so a collaborator
    # who just pulled a fresh index still gets the right next id without having
    # every paper locally.
    base = max(next_paper_id(), _highest_in_index() + 1, args.min)
    print_json({"next_id": base, "papers_dir": str(papers_dir()), "floor": args.min})


if __name__ == "__main__":
    main()
