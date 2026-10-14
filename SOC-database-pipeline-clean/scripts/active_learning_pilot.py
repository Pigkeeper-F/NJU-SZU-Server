"""Active-learning pilot utilities for candidate screening and extraction workflows.

The module is intentionally project-neutral.  A project supplies a candidate
inventory (CSV or JSONL) and a JSON configuration describing score weights,
keyword signals, and stratification fields.  The commands create immutable
round manifests and review templates; they do not modify existing source or
extraction outputs.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


ALLOWED_DECISIONS = {"include", "exclude", "needs_review"}
ALLOWED_SUPERVISOR_DECISIONS = {"pass", "revise", "stop", "needs_review"}
DEFAULT_WEIGHTS = {
    "uncertainty": 0.35,
    "boundary_risk": 0.35,
    "format_risk": 0.15,
    "impact": 0.15,
}


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _new_session_id(prefix: str, round_id: str) -> str:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{round_id}_{stamp}"


def _as_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return max(0.0, min(1.0, number))


def normalize_candidate(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a stable candidate record without discarding source metadata."""
    candidate = dict(raw)
    candidate_id = candidate.get("candidate_id", candidate.get("id", candidate.get("No.")))
    if candidate_id in (None, ""):
        raise ValueError("candidate requires candidate_id, id, or No.")
    candidate["candidate_id"] = str(candidate_id)
    candidate["title"] = str(candidate.get("title", "")).strip()
    candidate["status"] = str(candidate.get("status", "candidate") or "candidate").strip()
    signals = candidate.get("signals", {})
    if isinstance(signals, str):
        try:
            signals = json.loads(signals)
        except json.JSONDecodeError:
            signals = {}
    candidate["signals"] = dict(signals) if isinstance(signals, dict) else {}
    return candidate


def _candidate_text(candidate: dict[str, Any]) -> str:
    parts = []
    for key in ("title", "abstract", "source", "keywords", "snippet"):
        value = candidate.get(key, "")
        if isinstance(value, list):
            parts.extend(str(item) for item in value)
        elif value not in (None, ""):
            parts.append(str(value))
    return " ".join(parts).lower()


def _keyword_signal(candidate: dict[str, Any], signal: str, config: dict[str, Any]) -> float:
    phrases = config.get("keyword_signals", {}).get(signal, [])
    if not isinstance(phrases, list) or not phrases:
        return 0.0
    text = _candidate_text(candidate)
    hits = sum(1 for phrase in phrases if str(phrase).lower() in text)
    return min(1.0, hits / max(1, min(2, len(phrases))))


def score_candidate(candidate: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Calculate deterministic score components in the inclusive range [0, 1]."""
    weights = dict(DEFAULT_WEIGHTS)
    weights.update(config.get("weights", {}))
    signals = candidate.get("signals", {}) if isinstance(candidate.get("signals"), dict) else {}
    components: dict[str, float] = {}
    for name in weights:
        explicit = _as_number(signals.get(name))
        components[name] = explicit if explicit is not None else _keyword_signal(candidate, name, config)
    total = sum(components[name] * float(weight) for name, weight in weights.items())
    return {"components": components, "total": round(total, 8)}


def _stratum(candidate: dict[str, Any], config: dict[str, Any]) -> str:
    direct = candidate.get("stratum")
    if direct not in (None, ""):
        return str(direct)
    metadata = candidate.get("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
    fields = config.get("strata_fields", [])
    values = []
    for field in fields:
        value = candidate.get(field, metadata.get(field, "unknown"))
        values.append(str(value or "unknown"))
    return "|".join(values) if values else "unknown"


def rank_candidates(candidates: Iterable[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    ranked = []
    for raw in candidates:
        candidate = normalize_candidate(raw)
        score = score_candidate(candidate, config)
        candidate["score_components"] = score["components"]
        candidate["score"] = score["total"]
        candidate["stratum"] = _stratum(candidate, config)
        ranked.append(candidate)
    ranked.sort(key=lambda item: (-float(item.get("score", 0)), item["candidate_id"]))
    return ranked


def select_batch(
    candidates: list[dict[str, Any]],
    batch_size: int,
    exploration_fraction: float = 0.3,
    seed: int = 0,
) -> list[dict[str, Any]]:
    """Select a deterministic, diverse batch from already-ranked candidates."""
    if batch_size < 1:
        return []
    exploration_fraction = max(0.0, min(1.0, float(exploration_fraction)))
    eligible = [
        candidate
        for candidate in candidates
        if str(candidate.get("status", "candidate"))
        not in {"selected", "reviewed", "excluded"}
    ]
    eligible.sort(key=lambda item: (-float(item.get("score", 0)), str(item.get("candidate_id", ""))))
    selected: list[dict[str, Any]] = []
    remaining = list(eligible)

    # Use the first slots to cover strata.  This prevents high-scoring common
    # formats from crowding out a rare but important document type.
    for candidate in eligible:
        if len(selected) >= batch_size:
            break
        stratum = candidate.get("stratum", "unknown")
        if all(existing.get("stratum", "unknown") != stratum for existing in selected):
            selected.append(candidate)
            remaining.remove(candidate)

    slots_left = batch_size - len(selected)
    if slots_left <= 0:
        return selected
    rng = random.Random(seed)
    explore_count = min(slots_left, round(slots_left * exploration_fraction))
    explore_count = max(0, explore_count)
    exploit_count = slots_left - explore_count
    selected.extend(remaining[:exploit_count])
    remaining = remaining[exploit_count:]
    if explore_count and remaining:
        selected.extend(rng.sample(remaining, min(explore_count, len(remaining))))
    return selected[:batch_size]


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def write_round(
    out_dir: Path,
    round_id: str,
    selected: list[dict[str, Any]],
    rule_version: str,
    *,
    ranked_count: int | None = None,
    input_path: str | None = None,
    config_version: str | None = None,
    seed: int = 0,
    collection_session_id: str | None = None,
) -> dict[str, Path]:
    round_dir = out_dir / round_id
    manifest_path = round_dir / "round_manifest.json"
    ranked_path = round_dir / "ranked_candidates.jsonl"
    review_path = round_dir / "review_template.csv"
    collection_session_id = collection_session_id or _new_session_id("collect", round_id)
    manifest = {
        "round_id": round_id,
        "session_role": "collector",
        "collection_session_id": collection_session_id,
        "created_at": _utc_now(),
        "rule_version": rule_version,
        "config_version": config_version,
        "input_path": input_path,
        "seed": seed,
        "ranked_count": ranked_count if ranked_count is not None else len(selected),
        "selected_count": len(selected),
        "selected_ids": [item["candidate_id"] for item in selected],
        "selected_score_totals": {
            item["candidate_id"]: item.get("score", 0) for item in selected
        },
    }
    _atomic_write(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    _atomic_write(
        ranked_path,
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in selected),
    )
    fields = ["candidate_id", "decision", "uncertainty_reason", "notes", "reviewer", "gold_decision"]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=round_dir, delete=False) as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in selected:
            writer.writerow({"candidate_id": item["candidate_id"]})
        temp_path = Path(handle.name)
    temp_path.replace(review_path)
    return {"manifest": manifest_path, "ranked": ranked_path, "review_template": review_path}


def summarize_reviews(reviews: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = [dict(row) for row in reviews]
    counts = Counter(str(row.get("decision", "")).strip() for row in rows)
    reasons = Counter(
        str(row.get("uncertainty_reason", "")).strip()
        for row in rows
        if str(row.get("uncertainty_reason", "")).strip()
    )
    total = len(rows)
    gold_rows = [row for row in rows if row.get("gold_decision") not in (None, "")]
    disagreements = sum(
        1 for row in gold_rows if row.get("decision") != row.get("gold_decision")
    )
    result: dict[str, Any] = {
        "created_at": _utc_now(),
        "total_reviews": total,
        "decision_counts": dict(counts),
        "uncertainty_reason_counts": dict(reasons),
        "needs_review_rate": round(counts.get("needs_review", 0) / total, 6) if total else 0.0,
    }
    if gold_rows:
        result["gold_comparison"] = {
            "n": len(gold_rows),
            "accuracy": round((len(gold_rows) - disagreements) / len(gold_rows), 6),
            "disagreements": disagreements,
        }
    return result


def load_candidates(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ValueError(f"invalid JSONL at line {line_number}: {exc}") from exc
    return rows


def load_reviews(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows = [dict(row) for row in csv.DictReader(handle)]
    else:
        with path.open(encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
    reviewed_rows = []
    for row in rows:
        decision = str(row.get("decision", "")).strip()
        if not decision:
            continue
        if decision not in ALLOWED_DECISIONS:
            raise ValueError(f"invalid decision {decision!r}; expected {sorted(ALLOWED_DECISIONS)}")
        reviewed_rows.append(row)
    return reviewed_rows


def ingest_reviews(
    review_path: Path,
    output_path: Path,
    *,
    round_id: str,
    reviewer: str,
    validation_session_id: str | None = None,
) -> int:
    """Append completed review rows to an immutable JSONL review log."""
    rows = load_reviews(review_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("a", encoding="utf-8") as handle:
        for row in rows:
            enriched = dict(row)
            enriched["round_id"] = round_id
            enriched["reviewer"] = reviewer
            enriched["reviewed_at"] = _utc_now()
            if validation_session_id:
                enriched["validation_session_id"] = validation_session_id
            handle.write(json.dumps(enriched, ensure_ascii=False) + "\n")
    return len(rows)


def create_supervisor_packet(
    collection_manifest_path: Path,
    out_dir: Path,
    supervisor_session_id: str,
) -> dict[str, Path]:
    """Create a read-only handoff package for an independent Codex supervisor."""
    collection_manifest = load_json(collection_manifest_path)
    if collection_manifest.get("session_role") != "collector":
        raise ValueError("collection manifest must have session_role='collector'")
    collection_session_id = str(collection_manifest.get("collection_session_id", "")).strip()
    if not collection_session_id or supervisor_session_id == collection_session_id:
        raise ValueError("supervisor session must be distinct from collection session")
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "supervisor_manifest.json"
    prompt_path = out_dir / "supervisor_prompt.md"
    packet = {
        "session_role": "supervisor",
        "supervisor_session_id": supervisor_session_id,
        "collection_session_id": collection_session_id,
        "round_id": collection_manifest.get("round_id"),
        "collection_manifest": str(collection_manifest_path.resolve()),
        "read_only_artifacts": [
            str(collection_manifest_path.resolve()),
            str((collection_manifest_path.parent / "ranked_candidates.jsonl").resolve()),
            str((collection_manifest_path.parent / "review_template.csv").resolve()),
        ],
        "created_at": _utc_now(),
        "status": "awaiting_supervision",
    }
    prompt = f"""# Supervisor session {supervisor_session_id}\n\nYou are the independent supervisor for collection session `{collection_session_id}`.\nRead the manifest and listed artifacts in read-only mode. Do not edit the collector's files.\nCheck screening, classification, extraction, provenance, and rule-version consistency.\nWrite `supervisor_decision.json` in this directory with exactly these fields:\n\n```json\n{{\n  \"session_role\": \"supervisor\",\n  \"supervisor_session_id\": \"{supervisor_session_id}\",\n  \"collection_session_id\": \"{collection_session_id}\",\n  \"decision\": \"pass|revise|stop|needs_review\",\n  \"reasons\": [\"evidence-backed reason\"]\n}}\n```\n"""
    _atomic_write(manifest_path, json.dumps(packet, ensure_ascii=False, indent=2) + "\n")
    _atomic_write(prompt_path, prompt)
    return {"manifest": manifest_path, "prompt": prompt_path}


def validate_supervisor_gate(
    collection_manifest_path: Path,
    decision_path: Path,
) -> dict[str, Any]:
    """Validate an independent supervisor decision before a collector proceeds."""
    collection_manifest = load_json(collection_manifest_path)
    decision = load_json(decision_path)
    collection_session_id = str(collection_manifest.get("collection_session_id", "")).strip()
    supervisor_session_id = str(decision.get("supervisor_session_id", "")).strip()
    if collection_manifest.get("session_role") != "collector":
        raise ValueError("collection manifest must have session_role='collector'")
    if decision.get("session_role") != "supervisor":
        raise ValueError("decision must have session_role='supervisor'")
    if not supervisor_session_id or supervisor_session_id == collection_session_id:
        raise ValueError("supervisor session must be distinct from collection session")
    if decision.get("collection_session_id") != collection_session_id:
        raise ValueError("decision references a different collection session")
    if decision.get("decision") not in ALLOWED_SUPERVISOR_DECISIONS:
        raise ValueError(f"invalid supervisor decision: {decision.get('decision')!r}")
    if not isinstance(decision.get("reasons", []), list):
        raise ValueError("supervisor reasons must be a list")
    return decision


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def cli_rank(args: argparse.Namespace) -> int:
    config = load_json(Path(args.config))
    candidates = rank_candidates(load_candidates(Path(args.candidates)), config)
    selected = select_batch(
        candidates,
        args.batch_size or int(config.get("batch_size", 20)),
        args.exploration_fraction
        if args.exploration_fraction is not None
        else float(config.get("exploration_fraction", 0.3)),
        args.seed if args.seed is not None else int(config.get("seed", 0)),
    )
    paths = write_round(
        Path(args.out),
        args.round_id,
        selected,
        args.rule_version,
        ranked_count=len(candidates),
        input_path=str(Path(args.candidates)),
        config_version=str(config.get("version", "unknown")),
        seed=args.seed if args.seed is not None else int(config.get("seed", 0)),
        collection_session_id=args.collection_session_id,
    )
    print(json.dumps({key: str(value) for key, value in paths.items()}, ensure_ascii=False, indent=2))
    return 0


def cli_report(args: argparse.Namespace) -> int:
    summary = summarize_reviews(load_reviews(Path(args.reviews)))
    output = Path(args.out)
    _atomic_write(output, json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def cli_review(args: argparse.Namespace) -> int:
    count = ingest_reviews(
        Path(args.reviews),
        Path(args.out),
        round_id=args.round_id,
        reviewer=args.reviewer,
        validation_session_id=args.validation_session_id,
    )
    print(json.dumps({"appended_reviews": count, "output": str(Path(args.out))}, ensure_ascii=False, indent=2))
    return 0


def cli_review_template(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    load_json(manifest_path)
    template = manifest_path.parent / "review_template.csv"
    if not template.exists():
        raise FileNotFoundError(f"review template not found: {template}")
    print(str(template))
    return 0


def cli_supervisor_packet(args: argparse.Namespace) -> int:
    paths = create_supervisor_packet(
        Path(args.collection_manifest),
        Path(args.out),
        args.supervisor_session_id,
    )
    print(json.dumps({key: str(value) for key, value in paths.items()}, ensure_ascii=False, indent=2))
    return 0


def cli_supervisor_gate(args: argparse.Namespace) -> int:
    decision = validate_supervisor_gate(Path(args.collection_manifest), Path(args.decision))
    print(json.dumps(decision, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)
    rank = subparsers.add_parser("rank", help="rank candidates and write a pilot round")
    rank.add_argument("--candidates", required=True)
    rank.add_argument("--config", required=True)
    rank.add_argument("--out", required=True)
    rank.add_argument("--round-id", required=True)
    rank.add_argument("--rule-version", required=True)
    rank.add_argument("--batch-size", type=int)
    rank.add_argument("--exploration-fraction", type=float)
    rank.add_argument("--seed", type=int)
    rank.add_argument("--collection-session-id")
    rank.set_defaults(func=cli_rank)
    report = subparsers.add_parser("report", help="summarize a reviewed CSV or JSONL")
    report.add_argument("--reviews", required=True)
    report.add_argument("--out", required=True)
    report.set_defaults(func=cli_report)
    review = subparsers.add_parser("review", help="append completed reviews to a JSONL log")
    review.add_argument("--reviews", required=True)
    review.add_argument("--out", required=True)
    review.add_argument("--round-id", required=True)
    review.add_argument("--reviewer", required=True)
    review.add_argument("--validation-session-id", required=True)
    review.set_defaults(func=cli_review)
    template = subparsers.add_parser("review-template", help="print the review template path for a manifest")
    template.add_argument("--manifest", required=True)
    template.set_defaults(func=cli_review_template)
    packet = subparsers.add_parser("supervisor-packet", help="create a read-only packet for a Codex supervisor session")
    packet.add_argument("--collection-manifest", required=True)
    packet.add_argument("--out", required=True)
    packet.add_argument("--supervisor-session-id", required=True)
    packet.set_defaults(func=cli_supervisor_packet)
    gate = subparsers.add_parser("supervisor-gate", help="validate a supervisor gate decision")
    gate.add_argument("--collection-manifest", required=True)
    gate.add_argument("--decision", required=True)
    gate.set_defaults(func=cli_supervisor_gate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
