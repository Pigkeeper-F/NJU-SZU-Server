# Active-learning pilot protocol

This layer is a project-neutral pre-experiment for deciding whether a
collection workflow is ready for larger batches. It does not rewrite
`outputs/`, source files, or the final workbook.

## Two Codex sessions

The collector and supervisor are separate Codex tasks. The collector writes a
collection manifest; the supervisor receives a read-only handoff packet and
must write a gate decision before the collector proceeds.

After `rank` creates a round, create the supervisor packet:

```powershell
python scripts/active_learning_pilot.py supervisor-packet `
  --collection-manifest results/pilot/round_01/round_manifest.json `
  --out results/pilot/round_01/supervisor `
  --supervisor-session-id supervise_round_01_001
```

Open `supervisor_prompt.md` in a new Codex task. The supervisor must inspect
the listed artifacts read-only and write `supervisor_decision.json`. Validate
the handoff before allowing the next collection batch:

```powershell
python scripts/active_learning_pilot.py supervisor-gate `
  --collection-manifest results/pilot/round_01/round_manifest.json `
  --decision results/pilot/round_01/supervisor/supervisor_decision.json
```

The gate rejects missing roles, mismatched collection IDs, reused session IDs,
and unsupported decisions. The pipeline does not attempt to create Codex tasks
itself; the packet is the portable boundary between the two Codex sessions.

## Round model

1. Start with a candidate inventory in CSV or JSONL. CSV inventories may use
   the existing `papers_index.csv` columns (`id`, `title`, `doi`, `source`).
2. Configure score weights, keyword signals, batch size, and strata in a JSON
   file. Use `configs/active_learning_pilot.example.json` as the template.
3. Rank candidates and select one diverse batch:

   ```powershell
   python scripts/active_learning_pilot.py rank `
     --candidates papers_index.csv `
     --config configs/active_learning_pilot.example.json `
     --out results/pilot `
     --round-id round_01 `
     --rule-version rules_v0.1
   ```

4. Review `review_template.csv` and fill `decision` with one of
   `include`, `exclude`, or `needs_review`. Record why a sample was uncertain
   in `uncertainty_reason`; do not silently change the selected records.
5. Append completed reviews to the round log:

   ```powershell
   python scripts/active_learning_pilot.py review `
     --reviews results/pilot/round_01/review_template.csv `
     --out results/pilot/reviews.jsonl `
     --round-id round_01 `
     --reviewer analyst_01 `
     --validation-session-id supervise_round_01_001
   ```

6. Summarize the round:

   ```powershell
   python scripts/active_learning_pilot.py report `
     --reviews results/pilot/round_01/review_template.csv `
     --out results/pilot/round_01/round_metrics.json
   ```

## Recommended rounds

- Calibration: 10–20 relatively clear sources to verify the schema and basic
  screening rules.
- Boundary: 20–40 sources with ambiguous trial type, missing metadata, figures,
  multiple layers, or mixed experimental designs.
- Blind validation: a held-out set that is manually labeled before the workflow
  runs. Do not use it to update rules.
- Small production: a larger stratified batch after the rule version is frozen.

Use approximately 70% high-score/uncertain samples and 30% exploration. The
selector always attempts to cover distinct configured strata before filling
remaining slots by score and seeded exploration.

## Versioning and stopping

Increment `--rule-version` whenever screening, classification, extraction, or
normalization rules change. Keep round manifests with the candidate IDs,
configuration version, seed, scores, and input path. Re-run previous calibration
rounds after a rule change to catch regressions.

Freeze a rule version only after two consecutive rounds produce no high-severity
rule changes, the blind-validation agreement is acceptable for the project, and
the `needs_review` rate is stable. The numerical thresholds should be chosen by
the project; the pilot tool only reports the evidence.

## Candidate signals

Explicit numeric signals in a candidate's `signals` object take precedence over
keyword-derived signals. This lets a later screening model or human triage feed
better uncertainty estimates without changing the selection code. Candidate
records with `status` equal to `selected`, `reviewed`, or `excluded` are not
selected again.
