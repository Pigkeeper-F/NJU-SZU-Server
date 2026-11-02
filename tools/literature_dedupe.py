"""Dedupe stage of the literature pipeline: N-way cross-source / cross-batch merge.

Reads the cumulative ``candidates.json`` (stage-2 design doc §3.3) and groups
duplicate records that describe the same paper. Signal priority is frozen by
``docs/literature-mining-stage2-design.md`` §2.4.2 / §3.4 and reuses the SOC
``scripts/papers_index.py`` pure functions (A-tier reuse, D1a card 3):

    DOI/native ID/full bibliography exact > title similarity (manual review only)

Outputs ``dedupe/dedupe.json`` + ``dedupe/dedupe.csv`` (design §3.4) with an
NDJSON event stream (``stage`` -> ``result``) on stdout.

Semantics frozen by the contract:

- ``merge_confidence="exact"`` groups (every member reachable through exact
  links): non-canonical members are annotated ``auto_excluded_duplicate`` with
  ``screening_reason`` pointing at the canonical id; the canonical record keeps
  ``pending_review``. All original fields of every member are retained.
- ``merge_confidence="probable"`` groups (Jaccard-only links involved):
  ``needs_review=true`` and every member keeps ``pending_review`` -- probable
  duplicates are never silently dropped/merged.
- Processing order is deterministic: batch index ascending, then original
  order inside the batch; running twice on the same input yields the same
  groups. Versioned indexes reuse unchanged prefixes; edits rebuild safely.
"""
from __future__ import annotations

import argparse
import math
from collections import Counter, defaultdict
import literature_identity as _identity
import copy
import csv
import importlib
import io
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):  # §8.2 second line of defence
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = Path(__file__).resolve().parent
SOC_SCRIPTS = ROOT / "SOC-database-pipeline-clean" / "scripts"

DEFAULT_THRESHOLD = 0.55
OUTPUT_FILES = ("dedupe/dedupe.json", "dedupe/dedupe.csv")
CSV_COLUMNS = (
    "canonical_id", "title", "year", "doi", "sources", "merged_count",
    "merge_confidence", "merge_reason", "max_score", "needs_review",
)
_REASON_RANK = {"doi_exact": 4, "source_id_exact": 3, "title_year_authors_exact": 2, "title_substring": 1, "title_jaccard": 0}
INDEX_VERSION = "strong-identity-index-v2"

_CANDIDATES_FILE = "candidates.json"


class CandidatesMissingError(RuntimeError):
    """candidates.json is absent -- the discover stage has not produced data yet."""


# ---------------------------------------------------------------------------
# Shared helpers: prefer I1's tools/literature-common.py (design §9.1 "引用"),
# fall back to local equivalents with identical semantics so this stage script
# stays runnable while the parallel task lands.
# ---------------------------------------------------------------------------

def _load_literature_common():
    tools = str(TOOLS_DIR)
    if tools not in sys.path:
        sys.path.insert(0, tools)
    for name in ("literature_common", "literature-common"):
        try:
            module = importlib.import_module(name)
        except Exception:
            continue
        if callable(getattr(module, "emit", None)):
            return module
    return None


_COMMON = _load_literature_common()


def _shared(name: str, fallback):
    function = getattr(_COMMON, name, None) if _COMMON is not None else None
    return function if callable(function) else fallback


def _fallback_emit(kind: str, **values: object) -> None:
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


def _fallback_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fallback_safe_csv_cell(value: object) -> str:
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def _fallback_atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _fallback_atomic_write_json(path: Path, obj: object, *, indent: int = 2) -> None:
    _fallback_atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=indent) + "\n")


emit = _shared("emit", _fallback_emit)
now_iso = _shared("now_iso", _fallback_now_iso)
safe_csv_cell = _shared("safe_csv_cell", _fallback_safe_csv_cell)
atomic_write_text = _shared("atomic_write_text", _fallback_atomic_write_text)
atomic_write_json = _shared("atomic_write_json", _fallback_atomic_write_json)


# ---------------------------------------------------------------------------
# papers_index reuse (A tier): normalize / tokens / jaccard
# ---------------------------------------------------------------------------

_papers_index_module = None


def _papers_index():
    global _papers_index_module
    if _papers_index_module is None:
        scripts = str(SOC_SCRIPTS)
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        try:
            _papers_index_module = importlib.import_module("papers_index")
        except Exception as error:  # pragma: no cover - depends on checkout layout
            raise RuntimeError(f"无法导入 SOC scripts/papers_index.py：{error}") from error
    return _papers_index_module


def normalize(text: str) -> str:
    """Lowercase, strip punctuation/whitespace (SOC papers_index.normalize)."""
    return _papers_index().normalize(text)


def tokens(text: str) -> set[str]:
    """Latin word tokens (stopword filtered) + CJK bigrams (SOC implementation)."""
    return _papers_index().tokens(text)


def jaccard(left: set[str], right: set[str]) -> float:
    return _papers_index().jaccard(left, right)


def normalize_doi(value: object) -> str:
    """Lowercase, strip, and drop common https://doi.org/ / doi: prefixes."""
    if not isinstance(value, str):
        return ""
    doi = value.strip().lower()
    changed = True
    while changed:
        changed = False
        for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/",
                       "http://dx.doi.org/", "doi:"):
            if doi.startswith(prefix):
                doi = doi[len(prefix):].strip()
                changed = True
    return doi


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

def load_candidates(job_dir: Path) -> tuple[dict, list[dict]]:
    """Return ``(报告头, 累计记录)`` from ``<job_dir>/candidates.json``.

    Raises ``CandidatesMissingError`` (frozen message 尚未完成候选检索) when the
    discover stage output is absent.
    """
    path = Path(job_dir) / _CANDIDATES_FILE
    if not path.is_file():
        raise CandidatesMissingError("尚未完成候选检索")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("candidates.json 结构无效")
    raw = data.get("records")
    if not isinstance(raw, list):
        # v1 files may carry the records under "results" (design §3.3 兼容规则).
        raw = data.get("results")
    if not isinstance(raw, list):
        raise ValueError("candidates.json 缺少记录数组")
    header = {key: value for key, value in data.items() if key not in ("records", "results")}
    return header, [item for item in raw if isinstance(item, dict)]


# ---------------------------------------------------------------------------
# Grouping (N-way merge)
# ---------------------------------------------------------------------------

class _UnionFind:
    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, index: int) -> int:
        parent = self._parent
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(self, left: int, right: int) -> None:
        root_left, root_right = self.find(left), self.find(right)
        if root_left == root_right:
            return
        # Keep the smaller index as root so the canonical record stays stable.
        if root_left < root_right:
            self._parent[root_right] = root_left
        else:
            self._parent[root_left] = root_right


def _batch_index(record: dict) -> int:
    value = record.get("batch_index")
    if value is None:
        return 1
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def _record_id(record: dict, position: int) -> str:
    raw = record.get("candidate_id")
    text = str(raw).strip() if raw is not None else ""
    return text or f"row-{position + 1:03d}"


def _match(left: dict, right: dict, threshold: float):
    """Strong identity merges; similar titles only nominate manual review."""
    if _identity.conflicts(left["identity"], right["identity"]):
        return None
    reason = _identity.exact_match(left["identity"], right["identity"])
    if reason:
        return (reason, 1.0, True)
    score = jaccard(left["tokens"], right["tokens"])
    if left["norm_title"] and left["norm_title"] == right["norm_title"]:
        return ("title_substring", 0.95, False)
    if score >= threshold:
        return ("title_jaccard", round(score, 3), False)
    return None


def _indexed_links(prepared, threshold, prior=None):
    """Inverted token/identity lookup; unchanged prefixes reuse prior match edges."""
    strong, titles, postings, unknown_postings = defaultdict(set), defaultdict(set), defaultdict(set), defaultdict(set)
    prefix = len(prior.get("fingerprints", [])) if prior else 0
    links = [tuple(link) for link in prior.get("links", [])] if prior else []
    evaluated = 0
    for right, current in enumerate(prepared):
        keys = _identity.index_keys(current["identity"])
        if right >= prefix:
            possible = set()
            for key in keys:
                possible.update(strong.get(key, ()))
            possible.update(titles.get(current["norm_title"], ()))
            # Different known DOIs cannot match. Their title pairs need not even
            # be enumerated; title-only records remain eligible for comparison.
            applicable = unknown_postings if current["doi"] else postings
            overlap = Counter(left for token in current["tokens"] for left in applicable.get(token, ()))
            for left, shared in overlap.items():
                # Exact necessary bound for Jaccard >= threshold. No high-frequency
                # token or candidate cutoff silently discards a possible match.
                needed = math.ceil(threshold * (len(current["tokens"]) + len(prepared[left]["tokens"])) / (1 + threshold) - 1e-12)
                if shared >= needed:
                    possible.add(left)
            for left in sorted(possible):
                evaluated += 1
                match = _match(prepared[left], current, threshold)
                if match:
                    reason, score, exact = match
                    links.append((left, right, reason, score, exact))
        for key in keys:
            strong[key].add(right)
        if current["norm_title"]:
            titles[current["norm_title"]].add(right)
        for token in current["tokens"]:
            postings[token].add(right)
            if not current["doi"]:
                unknown_postings[token].add(right)
    return links, {"reused_prefix_records": prefix, "new_pair_checks": evaluated}


def _first_non_empty(members: list[int], records: list[dict], key: str) -> str:
    for index in members:
        value = records[index].get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def group_records(records: list[dict], *, threshold: float = DEFAULT_THRESHOLD,
                  cache: dict | None = None, cache_out: dict | None = None) -> list[dict]:
    """Group records into the §3.4 ``groups`` structure (deterministic order)."""
    if not records:
        return []

    order = sorted(range(len(records)), key=lambda i: (_batch_index(records[i]), i))
    fingerprints = [_identity.digest([_record_id(r, i), _batch_index(r), _identity.identity(r)])
                    for i, r in enumerate(records)]
    usable = (isinstance(cache, dict) and cache.get("version") == INDEX_VERSION
              and cache.get("threshold") == threshold and isinstance(cache.get("fingerprints"), list)
              and fingerprints[:len(cache["fingerprints"])] == cache["fingerprints"]
              and len(cache.get("prepared", [])) == len(cache["fingerprints"]))
    prior = cache if usable else None
    prepared = copy.deepcopy(prior["prepared"]) if prior else []
    for value in prepared:
        value["tokens"] = set(value["tokens"])
    for record in records[len(prepared):]:
        title = str(record.get("title") or "")
        prepared.append({"doi": normalize_doi(record.get("doi")),
                         "norm_title": normalize(title) if title else "",
                         "tokens": tokens(title) if title else set(), "identity": _identity.identity(record)})
    total = len(records)
    union_all, union_exact = _UnionFind(total), _UnionFind(total)
    matched_links, statistics = _indexed_links(prepared, threshold, prior)
    links = []
    # Prevent an incomplete-identity bridge from joining incompatible DOIs/IDs.
    component_identity = [{"doi": {p["identity"]["doi"]} - {""},
                           "ids": {k: {v} for k, v in p["identity"]["source_ids"].items()}}
                          for p in prepared]
    for left, right, reason, score, exact in matched_links:
        a, b = union_exact.find(left), union_exact.find(right)
        if exact and a != b:
            first, second = component_identity[a], component_identity[b]
            compatible = len(first["doi"] | second["doi"]) <= 1 and all(
                len(first["ids"][key] | second["ids"][key]) <= 1 for key in first["ids"].keys() & second["ids"].keys())
            if compatible:
                union_exact.union(left, right)
                component_identity[union_exact.find(left)] = {"doi": first["doi"] | second["doi"],
                    "ids": {key: first["ids"].get(key, set()) | second["ids"].get(key, set())
                            for key in first["ids"].keys() | second["ids"].keys()}}
            else:
                exact = False
        union_all.union(left, right)
        links.append((left, right, reason, score))
    if cache_out is not None:
        cache_out.update(version=INDEX_VERSION, threshold=threshold, fingerprints=fingerprints,
                         prepared=[{**p, "tokens": sorted(p["tokens"])} for p in prepared],
                         links=matched_links, statistics=statistics)

    order_rank = {value: rank for rank, value in enumerate(order)}
    members_by_root: dict[int, list[int]] = {}
    for index in order:  # walk in canonical order -> canonical is members[0]
        members_by_root.setdefault(union_all.find(index), []).append(index)

    links_by_root: dict[int, list[tuple[int, int, str, float]]] = {}
    for link in links:
        links_by_root.setdefault(union_all.find(link[0]), []).append(link)

    groups: list[dict] = []
    prior_ids = prior.get("canonical_ids", []) if prior else []
    existing_canonicals = {value: rank for rank, value in enumerate(prior_ids)}
    for root, members in members_by_root.items():
        members.sort(key=lambda i: (0, existing_canonicals[_record_id(records[i], i)])
                     if _record_id(records[i], i) in existing_canonicals else (1, order_rank[i]))
        canonical = members[0]
        canonical_id = _record_id(records[canonical], canonical)
        exact_connected = all(
            union_exact.find(member) == union_exact.find(canonical) for member in members
        )
        confidence = "exact" if exact_connected else "probable"
        group_links = links_by_root.get(root, [])
        if group_links:
            best = max(group_links, key=lambda link: (link[3], _REASON_RANK[link[2]]))
            merge_reason, max_score = best[2], best[3]
        else:
            merge_reason, max_score = "", 0.0

        sources: list[str] = []
        for member in members:
            value = records[member].get("source_key") or records[member].get("source") or ""
            value = str(value).strip()
            if value and value not in sources:
                sources.append(value)

        group_records_list = []
        for member in members:
            copied = copy.deepcopy(records[member])
            if confidence == "exact" and member != canonical:
                copied["screening_status"] = "auto_excluded_duplicate"
                copied["screening_reason"] = f"duplicate of {canonical_id}"
            group_records_list.append(copied)

        groups.append({
            "canonical_id": canonical_id,
            "title": str(records[canonical].get("title") or ""),
            "year": records[canonical].get("year"),
            "doi": _first_non_empty(members, records, "doi"),
            "sources": sources,
            "candidate_ids": [_record_id(records[member], member) for member in members],
            "merge_confidence": confidence,
            "merge_reason": merge_reason,
            "max_score": max_score,
            "needs_review": confidence == "probable",
            "records": group_records_list,
        })
    if cache_out is not None:
        cache_out["canonical_ids"] = [group["canonical_id"] for group in groups]
    return groups


# ---------------------------------------------------------------------------
# Output (§3.4)
# ---------------------------------------------------------------------------

def _csv_text(groups: list[dict]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)
    for group in groups:
        cells = {
            "canonical_id": group["canonical_id"],
            "title": group["title"],
            "year": "" if group["year"] is None else group["year"],
            "doi": group["doi"],
            "sources": "|".join(group["sources"]),
            "merged_count": len(group["candidate_ids"]) - 1,
            "merge_confidence": group["merge_confidence"],
            "merge_reason": group["merge_reason"],
            "max_score": group["max_score"],
            "needs_review": "true" if group["needs_review"] else "false",
        }
        writer.writerow([safe_csv_cell(cells[column]) for column in CSV_COLUMNS])
    return buffer.getvalue()


def _atomic_write_csv(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8-sig", newline="") as stream:
            stream.write(text)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def write_outputs(job_dir: Path, groups: list[dict], meta: dict) -> dict:
    """Atomically write ``dedupe/dedupe.json`` + ``dedupe/dedupe.csv``; return counts."""
    dedupe_dir = Path(job_dir) / "dedupe"
    merged = sum(len(group["candidate_ids"]) - 1 for group in groups)
    counts = {
        "records_in": len(groups) + merged,
        "groups": len(groups),
        "merged": merged,
        "needs_review_groups": sum(1 for group in groups if group.get("needs_review")),
    }
    document = {
        "version": 1,
        "generated_at": now_iso(),
        "threshold": meta.get("threshold", DEFAULT_THRESHOLD),
        "candidate_input_hash": meta.get("candidate_input_hash", ""),
        "candidate_file_sha256": meta.get("candidate_file_sha256", ""),
        "counts": counts,
        "groups": groups,
    }
    atomic_write_json(dedupe_dir / "dedupe.json", document)
    _atomic_write_csv(dedupe_dir / "dedupe.csv", _csv_text(groups))
    return counts


# ---------------------------------------------------------------------------
# Stage entry
# ---------------------------------------------------------------------------

def run(config: dict, output_dir: Path, *, threshold: float = DEFAULT_THRESHOLD,
        resume: bool = False) -> int:
    """Use a versioned identity index; only new records need pair comparisons."""
    _ = (config, resume)  # dedupe is source-agnostic; --resume keeps CLI symmetry (§2.4.2)
    _, records = load_candidates(output_dir)  # missing input -> error only, no stage event
    emit("stage", stage="dedupe", message="对累计候选执行跨来源归并去重")
    index_path = Path(output_dir) / "dedupe" / "identity_index.json"
    try:
        cache = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = None
    cache_out = {}
    groups = group_records(records, threshold=threshold, cache=cache, cache_out=cache_out)
    atomic_write_json(index_path, cache_out)
    counts = write_outputs(output_dir, groups, {"threshold": threshold, "candidate_input_hash": _identity.digest(records),
        "candidate_file_sha256": hashlib.sha256((Path(output_dir) / _CANDIDATES_FILE).read_bytes()).hexdigest()})
    emit(
        "result",
        stage="dedupe",
        count=counts["groups"],
        message=(
            f"去重完成：{counts['groups']} 组（合并 {counts['merged']} 条，待复核组 "
            f"{counts['needs_review_groups']}）"
        ),
        counts=counts,
        files=list(OUTPUT_FILES),
    )
    return 0


def _validate_config(config: object) -> dict:
    if not isinstance(config, dict):
        raise ValueError("运行配置无效")
    if not isinstance(config.get("query"), str) or not config["query"].strip():
        raise ValueError("运行配置缺少检索式")
    return config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献去重阶段：跨来源/跨批次归并重复候选")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="标题相似度 Jaccard 阈值（默认 0.55）")
    parser.add_argument("--resume", action="store_true", help="复用未改变题录的身份索引；新题录增量匹配")
    args = parser.parse_args(argv)
    try:
        config = _validate_config(json.loads(args.config.read_text(encoding="utf-8")))
        if not 0 < args.threshold <= 1:
            raise ValueError("相似度阈值需在 (0, 1] 之间")
        return run(config, args.output_dir, threshold=args.threshold, resume=args.resume)
    except CandidatesMissingError as error:
        emit("error", message=str(error))
        return 1
    except Exception as error:
        emit("error", message=f"去重失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
