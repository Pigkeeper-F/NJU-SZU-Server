# Active Learning Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portable, manifest-driven active-learning pilot layer for ranking candidates, selecting stratified batches, recording human reviews, and measuring round progress without changing existing SOC outputs.

**Architecture:** A standalone stdlib Python module reads CSV/JSONL candidate inventories, computes configurable uncertainty/boundary/diversity/impact scores, selects a batch with exploration and stratum quotas, and writes a round manifest plus review template. A second command summarizes reviewed decisions and compares them to optional gold labels. Existing discovery, extraction, merge, and endpoint scripts remain unchanged; projects provide a JSON config and candidate inventory.

**Tech Stack:** Python 3.10+ standard library, argparse, csv, json, pathlib, unittest/pytest-compatible tests.

---

### Task 1: Define the pilot data contract and configuration

**Files:**
- Create: `configs/active_learning_pilot.example.json`
- Create: `tests/test_active_learning_pilot.py`

- [ ] **Step 1: Write failing tests for candidate normalization and score components**

```python
def test_normalize_candidate_defaults_missing_fields():
    candidate = normalize_candidate({"candidate_id": "7", "title": "Field trial"})
    assert candidate["candidate_id"] == "7"
    assert candidate["status"] == "candidate"
    assert candidate["signals"] == {}

def test_score_candidate_uses_configured_signal_weights():
    config = {"weights": {"uncertainty": 2.0, "boundary_risk": 1.0, "impact": 1.0}}
    candidate = {"candidate_id": "x", "signals": {"uncertainty": 0.5, "boundary_risk": 0.25, "impact": 0.25}}
    assert score_candidate(candidate, config)["total"] == 1.5
```

- [ ] **Step 2: Run the focused tests and verify they fail because the module is absent**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "normalize_candidate or score_candidate"`

Expected: collection/import failure for `scripts.active_learning_pilot`.

- [ ] **Step 3: Add the example configuration**

The config must define `version`, `batch_size`, `exploration_fraction`, `strata_fields`, `weights`, and `keyword_signals`, with comments represented as ordinary JSON-free prose in the accompanying CLI help rather than invalid JSON comments.

- [ ] **Step 4: Add minimal data-contract helpers**

Implement `normalize_candidate` and `score_candidate` in `scripts/active_learning_pilot.py` with deterministic defaults and no filesystem side effects.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "normalize_candidate or score_candidate"`

Expected: all selected tests pass.

### Task 2: Implement configurable scoring and stratified batch selection

**Files:**
- Modify: `scripts/active_learning_pilot.py`
- Modify: `tests/test_active_learning_pilot.py`

- [ ] **Step 1: Write failing tests for diversity and exploration behavior**

```python
def test_select_batch_keeps_strata_represented():
    candidates = [
        {"candidate_id": "a1", "score": 10, "stratum": "table"},
        {"candidate_id": "a2", "score": 9, "stratum": "table"},
        {"candidate_id": "b1", "score": 1, "stratum": "figure"},
    ]
    selected = select_batch(candidates, batch_size=2, exploration_fraction=0.5, seed=1)
    assert {item["stratum"] for item in selected} == {"table", "figure"}

def test_select_batch_is_deterministic_with_seed():
    candidates = [{"candidate_id": str(i), "score": i, "stratum": "same"} for i in range(5)]
    first = [x["candidate_id"] for x in select_batch(candidates, 3, 0.0, seed=42)]
    second = [x["candidate_id"] for x in select_batch(candidates, 3, 0.0, seed=42)]
    assert first == second
```

- [ ] **Step 2: Run the tests and verify the new selection tests fail**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "select_batch"`

Expected: failure because selection functions are not implemented.

- [ ] **Step 3: Implement scoring and selection**

Support explicit numeric signals, configurable keyword signals, a deterministic random seed, an exploration fraction, and one-per-stratum coverage where the requested batch size permits it. Exclude candidates whose status is already `selected`, `reviewed`, or `excluded`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "select_batch or score_candidate"`

Expected: all selected tests pass.

### Task 3: Add round manifest and human-review template commands

**Files:**
- Modify: `scripts/active_learning_pilot.py`
- Modify: `tests/test_active_learning_pilot.py`

- [ ] **Step 1: Write failing tests for manifest and review-template output**

```python
def test_write_round_creates_manifest_and_review_template(tmp_path):
    paths = write_round(tmp_path, "round_01", [{"candidate_id": "7", "score": 2.5}], "rules_v0.2")
    assert paths["manifest"].exists()
    assert paths["review_template"].exists()
    assert "rules_v0.2" in paths["manifest"].read_text(encoding="utf-8")
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "write_round"`

Expected: failure because `write_round` is not implemented.

- [ ] **Step 3: Implement atomic round outputs**

Write `round_manifest.json`, `review_template.csv`, and `ranked_candidates.jsonl` under `<out>/<round_id>/`. The manifest must include the input path, config version, rule version, seed, selected IDs, timestamp, and score-component totals. Use temporary files followed by `Path.replace` for atomic writes.

- [ ] **Step 4: Add CLI subcommands**

Implement:

```text
python scripts/active_learning_pilot.py rank --candidates <csv-or-jsonl> --config <json> --out <dir> --round-id round_01 --rule-version rules_v0.1
python scripts/active_learning_pilot.py review-template --manifest <manifest.json>
```

- [ ] **Step 5: Run focused tests and a CLI smoke test**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "write_round"`

Expected: all selected tests pass.

### Task 4: Add review ingestion and round metrics

**Files:**
- Modify: `scripts/active_learning_pilot.py`
- Modify: `tests/test_active_learning_pilot.py`

- [ ] **Step 1: Write failing tests for review metrics**

```python
def test_summarize_reviews_reports_decision_and_uncertainty_rates():
    reviews = [
        {"candidate_id": "1", "decision": "include", "uncertainty_reason": ""},
        {"candidate_id": "2", "decision": "needs_review", "uncertainty_reason": "layer ambiguity"},
    ]
    summary = summarize_reviews(reviews)
    assert summary["total_reviews"] == 2
    assert summary["needs_review_rate"] == 0.5
    assert summary["decision_counts"]["include"] == 1
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "summarize_reviews"`

Expected: failure because review summarization is not implemented.

- [ ] **Step 3: Implement review ingestion and optional gold comparison**

Add `review` and `report` subcommands. `review` validates allowed decisions and writes an append-only `reviews.jsonl`. `report` emits `round_metrics.json` with counts, uncertainty reasons, review rate, and—when a `gold_decision` column exists—accuracy and disagreement counts.

- [ ] **Step 4: Run focused tests and verify the report format**

Run: `python -m pytest -q tests/test_active_learning_pilot.py -k "summarize_reviews"`

Expected: all selected tests pass.

### Task 5: Add documentation and regression verification

**Files:**
- Create: `docs/active-learning-pilot.md`
- Modify: `README.md`
- Modify: `tests/test_active_learning_pilot.py`

- [ ] **Step 1: Add an integration test using a tiny candidate fixture**

The test must run the public functions or CLI against five candidates, create one round, ingest two reviews, and assert that the resulting metrics and manifest agree on the selected IDs.

- [ ] **Step 2: Run the integration test and the full test suite**

Run: `python -m pytest -q tests/test_active_learning_pilot.py`

Expected: all pilot tests pass. Then run: `python -m pytest -q tests`.

- [ ] **Step 3: Document the recommended pilot protocol**

Document calibration, boundary, and blind-validation rounds; the 70% uncertainty/30% exploration split; rule-version freeze; holdout separation; and stop criteria based on two consecutive rounds with no high-severity rule changes.

- [ ] **Step 4: Run the pipeline validator as a regression check**

Run: `python scripts/validate_output_v2.py outputs`

Expected: the existing output validation result is unchanged; the new pilot layer does not rewrite SOC outputs.

