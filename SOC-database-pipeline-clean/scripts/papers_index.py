"""Dedup + append helper for papers_index.csv.

Two subcommands:

    check  — fuzzy-match a candidate title (+ optional DOI) against the index.
             Prints JSON with {"duplicate": bool, "matches": [...]}.
             Use in the soc-paper-fetch preflight before downloading.

    add    — append a new row after a successful download.
             Normalizes whitespace, ensures unique id, and rewrites the CSV.

Columns: id,title,doi,source,added_date

`source` is free-form text — typically "google-scholar:<url-or-domain>",
"publisher:<domain>", or "legacy" for pre-index seed rows. `added_date` is
ISO YYYY-MM-DD.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
INDEX_CSV = ROOT / "papers_index.csv"
FIELDS = ["id", "title", "doi", "source", "added_date"]

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
PUNCT_RE = re.compile(r"[\s\-_.,;:!?/\\()\[\]{}'\"“”‘’（），。：；！？—·]+")
# Common short English stopwords that shouldn't count toward token overlap.
STOP = {
    "the", "a", "an", "of", "and", "or", "for", "on", "in", "to", "at",
    "with", "from", "by", "as", "is", "are", "be", "under",
}


def normalize(text: str) -> str:
    """Lowercase, strip punctuation/whitespace. Keeps CJK chars intact."""
    if not text:
        return ""
    t = text.lower()
    t = PUNCT_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def tokens(text: str) -> set[str]:
    """Tokenize: Latin words (filtered by stopword) + CJK bigrams."""
    n = normalize(text)
    if not n:
        return set()
    toks: set[str] = set()
    for w in re.findall(r"[a-z][a-z0-9]+", n):
        if w not in STOP and len(w) >= 3:
            toks.add(w)
    # CJK bigrams — short enough for useful substring overlap
    cjk_only = "".join(ch for ch in n if CJK_RE.match(ch))
    for i in range(len(cjk_only) - 1):
        toks.add(cjk_only[i : i + 2])
    return toks


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def load_rows() -> list[dict]:
    if not INDEX_CSV.exists():
        return []
    with INDEX_CSV.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_rows(rows: list[dict]) -> None:
    INDEX_CSV.parent.mkdir(parents=True, exist_ok=True)
    with INDEX_CSV.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def cmd_check(args) -> None:
    rows = load_rows()
    q_title = args.title or ""
    q_doi = (args.doi or "").strip().lower()
    threshold = args.threshold

    matches: list[dict] = []

    if q_doi:
        for r in rows:
            if r.get("doi", "").strip().lower() == q_doi:
                matches.append({
                    "id": r["id"], "title": r["title"], "doi": r["doi"],
                    "reason": "doi_exact", "score": 1.0,
                })

    if q_title and not matches:
        q_tok = tokens(q_title)
        q_norm = normalize(q_title)
        for r in rows:
            t = r.get("title", "")
            if not t:
                continue
            t_norm = normalize(t)
            # Strong signal: substring containment either way (after normalization)
            if q_norm and t_norm and (q_norm in t_norm or t_norm in q_norm):
                matches.append({
                    "id": r["id"], "title": r["title"], "doi": r["doi"],
                    "reason": "substring", "score": 0.95,
                })
                continue
            score = jaccard(q_tok, tokens(t))
            if score >= threshold:
                matches.append({
                    "id": r["id"], "title": r["title"], "doi": r["doi"],
                    "reason": "jaccard", "score": round(score, 3),
                })
        matches.sort(key=lambda m: m["score"], reverse=True)

    result = {
        "duplicate": bool(matches),
        "query": {"title": q_title, "doi": q_doi, "threshold": threshold},
        "matches": matches[:5],
        "index_size": len(rows),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(1 if matches else 0)


def cmd_add(args) -> None:
    rows = load_rows()
    new_id = str(args.id)
    if any(r["id"] == new_id for r in rows):
        print(json.dumps({"status": "exists", "id": new_id}, ensure_ascii=False))
        sys.exit(1)
    title = re.sub(r"\s+", " ", (args.title or "")).strip()
    rows.append({
        "id": new_id,
        "title": title,
        "doi": (args.doi or "").strip(),
        "source": (args.source or "").strip() or "unknown",
        "added_date": args.date or date.today().isoformat(),
    })
    rows.sort(key=lambda r: int(r["id"]) if r["id"].isdigit() else 0)
    write_rows(rows)
    print(json.dumps({"status": "added", "id": new_id, "title": title},
                     ensure_ascii=False))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    chk = sub.add_parser("check", help="Check if a candidate is already in the corpus")
    chk.add_argument("--title", required=True, help="Candidate paper title")
    chk.add_argument("--doi", default="", help="Candidate DOI (preferred signal when available)")
    chk.add_argument("--threshold", type=float, default=0.55,
                     help="Jaccard similarity threshold (default 0.55)")

    add = sub.add_parser("add", help="Append a successfully-downloaded paper to the index")
    add.add_argument("--id", type=int, required=True)
    add.add_argument("--title", required=True)
    add.add_argument("--doi", default="")
    add.add_argument(
        "--source",
        default="",
        help="e.g. google-scholar:<url-or-domain> / publisher:<domain>",
    )
    add.add_argument("--date", default="", help="ISO date; defaults to today")

    args = p.parse_args()
    if args.cmd == "check":
        cmd_check(args)
    elif args.cmd == "add":
        cmd_add(args)


if __name__ == "__main__":
    main()
