"""One-off: walk papers/*.pdf and produce papers_index.csv (id,title,doi,source,added_date).

Title extraction heuristic:
- Read page 1 with fitz, cluster spans by font size.
- Pick the largest font-size cluster on the upper 2/3 of the page as title candidate.
- Skip lines matching journal/header/DOI/received-date noise.
- Concatenate adjacent lines that share the same dominant font size.
- Fallback to the 2nd largest cluster if the largest is noise.

Existing papers_index.csv rows are preserved: this script only fills in missing ids.
Run it once to bootstrap; after that the soc-paper-fetch skill appends rows via papers_index.py.
"""
from __future__ import annotations

import csv
import re
import sys
from datetime import date
from pathlib import Path

import fitz  # PyMuPDF

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
PAPERS_DIR = ROOT / "papers"
INDEX_CSV = ROOT / "papers_index.csv"

HEADER_NOISE = re.compile(
    r"(journal of|vol\.|volume|issue|received|accepted|available online|doi[:\s]|"
    r"http[s]?://|www\.|©|elsevier|springer|wiley|taylor|mdpi|frontiers|"
    r"correspondence|e-?mail|corresponding author|issn|"
    r"ScienceDirect|atmospheric environment|agriculture, ecosystems|"
    r"ecological engineering|soil & tillage research|agricultural water management|"
    r"atmosphere|journal logo|"
    r"第\s*\d+\s*[卷期]|年\s*\d+\s*月|"
    r"网络首发论文|学位论文)",
    re.IGNORECASE,
)

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# Cover-page patterns for CNKI preprints / theses where the title follows a fixed label.
TITLE_LABEL_RE = re.compile(r"题\s*目\s*[:：]?\s*(.+)")
THESIS_HEADERS = (
    "硕 士 学 位 论 文", "博 士 学 位 论 文",
    "硕士学位论文", "博士学位论文",
)


def looks_garbled(text: str) -> bool:
    """Detect mojibake like the '˶ʿ ѧ λ' that shows up when a CJK font has
    missing glyphs: lots of Latin-Extended / IPA / Greek codepoints, no CJK."""
    if not text:
        return True
    if CJK_RE.search(text):
        return False
    weird = sum(1 for c in text if 0x0180 <= ord(c) <= 0x058F)
    return weird >= 3 and weird / max(1, len(text)) > 0.2


def extract_title_from_plaintext(page_text: str) -> str:
    """Fallback: scan page-1 raw text for a title near a known label."""
    lines = [ln.strip() for ln in page_text.split("\n")]
    lines = [ln for ln in lines if ln]

    def clean(t: str) -> str:
        # Trim common trailing metadata labels
        t = re.sub(r"\s*作者\s*[:：].*$", "", t)
        t = re.sub(r"\s*DOI\s*[:：].*$", "", t, flags=re.IGNORECASE)
        return t.strip()

    def is_degree_label(t: str) -> bool:
        t = t.strip()
        return bool(
            re.fullmatch(r"[\(（].{1,20}[\)）]", t)
            or any(h in t for h in THESIS_HEADERS)
            or "学位" in t and len(t) < 20
        )

    # Pattern 1: "题目： xxx" (CNKI preprint cover)
    for i, ln in enumerate(lines):
        m = TITLE_LABEL_RE.match(ln)
        if m:
            head = m.group(1).strip()
            if head and len(head) >= 6:
                return clean(head)
            # Label alone — title is the next non-empty line
            for j in range(i + 1, min(i + 4, len(lines))):
                nxt = lines[j]
                if len(nxt) >= 6 and not is_degree_label(nxt):
                    follow = lines[j + 1] if j + 1 < len(lines) else ""
                    if (follow and len(follow) < 40 and CJK_RE.search(follow)
                            and not HEADER_NOISE.search(follow)
                            and "作者" not in follow and not is_degree_label(follow)):
                        return clean(f"{nxt} {follow}")
                    return clean(nxt)

    # Pattern 2: thesis cover — first CJK line(s) after the "硕/博 士 学 位 论 文" banner,
    # skipping degree-label lines like "(学术学位)".
    for i, ln in enumerate(lines):
        if any(h in ln for h in THESIS_HEADERS):
            for j in range(i + 1, min(i + 8, len(lines))):
                cand = lines[j]
                if is_degree_label(cand):
                    continue
                if len(cand) >= 6 and CJK_RE.search(cand):
                    follow = lines[j + 1] if j + 1 < len(lines) else ""
                    if (follow and len(follow) < 40 and CJK_RE.search(follow)
                            and "单位" not in follow and "专业" not in follow
                            and not is_degree_label(follow)):
                        return clean(f"{cand} {follow}")
                    return clean(cand)

    # Pattern 3: first substantial CJK line that's not header noise
    for ln in lines:
        if len(ln) >= 12 and CJK_RE.search(ln) and not HEADER_NOISE.search(ln):
            return clean(ln)
    return ""


def extract_doi(page_text: str) -> str:
    m = DOI_RE.search(page_text)
    return m.group(0).rstrip(".,;)") if m else ""


def line_is_noise(text: str) -> bool:
    t = text.strip()
    if len(t) < 6:
        return True
    if DOI_RE.search(t):
        return True
    if HEADER_NOISE.search(t):
        return True
    # Pure numbers / author-name patterns (short + comma-heavy + digits)
    if re.fullmatch(r"[\d\s,.\-–—]+", t):
        return True
    return False


def extract_title(pdf_path: Path) -> tuple[str, str]:
    """Return (title, doi). Empty strings on failure."""
    try:
        doc = fitz.open(str(pdf_path))
    except Exception as exc:
        return ("", f"OPEN_ERROR: {exc}")

    if doc.page_count == 0:
        return ("", "")
    page = doc[0]
    page_h = page.rect.height

    try:
        data = page.get_text("dict")
    except Exception:
        data = {"blocks": []}

    # Collect lines: (y_top, font_size, text)
    lines: list[tuple[float, float, str]] = []
    for block in data.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for ln in block.get("lines", []):
            spans = ln.get("spans", [])
            if not spans:
                continue
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            # Use the max span size as the line's effective size
            size = max(s.get("size", 0) for s in spans)
            y = ln.get("bbox", [0, 0, 0, 0])[1]
            lines.append((y, size, text))

    plain_text = page.get_text() or ""
    # DOI often isn't on page 1 for theses / CNKI preprints — scan first 3 pages.
    doi_scan_text = plain_text
    for i in range(1, min(3, doc.page_count)):
        doi_scan_text += "\n" + (doc[i].get_text() or "")
    doi = extract_doi(doi_scan_text)

    # High-confidence label paths (CNKI preprint "题目：" / thesis covers)
    # run BEFORE the font-size heuristic because those pages often have the
    # label in a large font that would otherwise win.
    has_label = ("题目" in plain_text) or any(h in plain_text for h in THESIS_HEADERS)
    if has_label:
        scan_pages = []
        for i in range(min(3, doc.page_count)):
            scan_pages.append(doc[i].get_text() or "")
        for pt in scan_pages:
            cand = extract_title_from_plaintext(pt)
            if cand and not looks_garbled(cand):
                doc.close()
                return (cand, doi)

    if not lines:
        doc.close()
        return ("", doi)

    # Exclude the top 8% (journal banner) and bottom 30% (footers, refs).
    # Most article titles land in the upper-middle of the first page.
    upper = [ln for ln in lines if page_h * 0.08 < ln[0] < page_h * 0.70]
    if not upper:
        upper = lines

    # Rank font sizes descending
    sizes = sorted({round(ln[1], 1) for ln in upper}, reverse=True)

    for target_size in sizes[:4]:  # try top-4 size buckets
        group = [ln for ln in upper if abs(ln[1] - target_size) < 0.3]
        group.sort(key=lambda x: x[0])
        # fitz often splits a line into span-level entries (one word per "line");
        # regroup by y-coordinate first so noise checks apply to real lines.
        merged: dict[int, list[str]] = {}
        for y, _, t in group:
            key = int(round(y))
            merged.setdefault(key, []).append(t)
        combined_lines = [" ".join(ws) for _, ws in sorted(merged.items())]
        combined_lines = [ln for ln in combined_lines if not line_is_noise(ln)]
        candidate = " ".join(combined_lines)
        candidate = re.sub(r"\s+", " ", candidate).strip()
        if len(candidate.split()) <= 4 and HEADER_NOISE.search(candidate):
            continue
        if looks_garbled(candidate):
            continue
        if 10 <= len(candidate) <= 400:
            doc.close()
            return (candidate, doi)

    # Fallback 1: plaintext-based title on page 1 (CNKI preprint / thesis covers).
    # Scan pages 1-3 because thesis covers sometimes split label and title.
    scan_pages = []
    for i in range(min(3, doc.page_count)):
        scan_pages.append(doc[i].get_text() or "")
    for pt in scan_pages:
        cand = extract_title_from_plaintext(pt)
        if cand and not looks_garbled(cand):
            doc.close()
            return (cand, doi)

    # Fallback 2: first non-noise line in the font-size layout
    for _, _, t in sorted(upper, key=lambda x: x[0]):
        if not line_is_noise(t) and len(t) >= 10 and not looks_garbled(t):
            doc.close()
            return (t.strip(), doi)

    doc.close()
    return ("", doi)


def load_existing_index() -> dict[int, dict]:
    if not INDEX_CSV.exists():
        return {}
    out = {}
    with INDEX_CSV.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                out[int(row["id"])] = row
            except (KeyError, ValueError):
                continue
    return out


def main() -> None:
    existing = load_existing_index()
    rows: list[dict] = []
    today = date.today().isoformat()

    pdfs = sorted(
        PAPERS_DIR.glob("*.pdf"),
        key=lambda p: int(re.match(r"(\d+)", p.stem).group(1))
        if re.match(r"(\d+)", p.stem)
        else 0,
    )

    for pdf in pdfs:
        m = re.fullmatch(r"(\d+)", pdf.stem)
        if not m:
            continue
        pid = int(m.group(1))

        if pid in existing:
            rows.append(existing[pid])
            continue

        title, doi = extract_title(pdf)
        if not title:
            sys.stderr.write(f"[warn] no title extracted: {pdf.name}\n")
        rows.append({
            "id": str(pid),
            "title": title,
            "doi": doi,
            "source": "legacy",
            "added_date": today,
        })

    INDEX_CSV.parent.mkdir(parents=True, exist_ok=True)
    with INDEX_CSV.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["id", "title", "doi", "source", "added_date"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {INDEX_CSV}")


if __name__ == "__main__":
    main()
