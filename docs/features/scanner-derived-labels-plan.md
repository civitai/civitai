# Plan: Derived Labels for Scanner Callbacks

Pre-write transform that takes raw XGuard label results and produces a derived set — suppressing redundant labels and synthesizing computed ones — before any of them are written to ClickHouse or surfaced to moderators.

Status: **proposal**. Not yet implemented. Owner pending.

Related context:
- [scanner-policy-changes-2026-05.md](scanner-policy-changes-2026-05.md) — original pass with the `csam = young AND sexual` decomposition decision.
- [scanner-policy-changes-2026-05-pass2.md](scanner-policy-changes-2026-05-pass2.md) — pass 2, which introduced Suggestive + Explicit (hierarchical), Incest, NonConsent, Gore.
- [wildcard-category-audit.service.ts](../../src/server/services/wildcard-category-audit.service.ts) — existing per-consumer synthetic-CSAM derivation; this proposal generalizes/replaces it.

## Why

Two unrelated problems share the same solution shape:

1. **Hierarchical labels emit redundant rows.** Suggestive is a superset of Explicit by design. When both trigger, the moderator queue gets two rows for the same content. Mods verdict both. Analytics double-counts. The Suggestive row is noise — Explicit already represents the stronger signal.
2. **Synthetic labels need to live somewhere consistent.** `csam = young AND (suggestive OR explicit)` is currently re-implemented per-consumer (today: wildcard-category-audit). A second consumer needing the same derivation duplicates the logic, drifts, and the wildcard version becomes the "real" one by accident.

Doing both in one place — the moderation callback, before the CH write — keeps the audit log clean and makes downstream consumers read derived labels uniformly.

## What the derived-labels function does

Pure transform: takes the raw XGuard label-result array, returns a possibly-different array. Two operations:

**Suppression**: drop a row when another row makes it redundant.
**Derivation**: append a synthesized row when a combination of rows implies a new concept.

Suppression and derivation run after each other in deterministic order (suppress first, derive second — derivation reads the original triggered set, not the suppressed set, so a synthetic label can fire even when one of its inputs is itself being suppressed).

### Initial rule set

Suppression rules (prompt mode):

| Suppress | When also triggered | Why |
| --- | --- | --- |
| `suggestive` | `explicit` | Hierarchical — Explicit ⊂ Suggestive by design. |

Derivation rules (prompt mode):

| Synthesize | When triggered | Why |
| --- | --- | --- |
| `csam` | `young` AND (`sexual` OR `suggestive` OR `explicit`) | Operational CSAM signal; replaces standalone CSAM label dropped pass 1. |

Text mode rules — identical to prompt where the same labels exist (Young, Suggestive, Explicit are all in text mode after pass 2). The wildcard-audit consumer also derives synthetic CSAM today; once this lands, the wildcard-audit logic can read the derived row instead of recomputing.

### Why "derive after suppress doesn't matter here" — but might later

For the current rule set:
- Suppressing `suggestive` doesn't change the `csam` derivation result because the derivation reads `(sexual OR suggestive OR explicit)`. If `explicit` triggered, `csam` fires regardless of whether `suggestive` was suppressed.

But the order will matter if we add rules like "synthesize `extreme_nsfw` when `suggestive` AND `gore` co-trigger" — there, suppressing `suggestive` first would silently kill the synthesis. **Decision: derivation always reads the pre-suppression result set.** Document this invariant in the function.

## Where it goes in the pipeline

The XGuard webhook callback is [src/pages/api/webhooks/text-moderation-result.ts](../../src/pages/api/webhooks/text-moderation-result.ts), which calls `recordXGuardScanFromWorkflow` (in `scanner-audit.service.ts`). The transform lives between the workflow-result parse and the ClickHouse write:

```
webhook hit
  ↓
parse XGuard workflow result → XGuardLabelResult[]
  ↓
[NEW] applyDerivedLabels(results, mode) → XGuardLabelResult[]
  ↓
recordXGuardScanFromWorkflow → ClickHouse insert
  ↓
entity-moderation / wildcard-audit dispatch
```

The transform happens upstream of every downstream consumer. ClickHouse, the focused-review UI, the entity-moderation handlers, and the wildcard-audit pipeline all see the derived set — there's no "raw view" anywhere.

Implication: this is **destructive**. Once shipped, we can't recover the suppressed Suggestive rows for historical analysis from ClickHouse alone. If we ever need to validate the suppression rule itself, we'd need either:
- A flag-out / dry-run mode that logs both raw and derived sets for an A/B period
- A separate `scanner_label_results_raw` audit table during the validation window

**Recommended approach**: run in dry-run mode for the first week (log both raw and derived, but only the derived set drives CH writes; the raw set goes to a parallel telemetry path or Axiom). After validation, drop dry-run and run derived-only.

## Function contract

```ts
// scanner-derived-labels.service.ts (new file)

export type DerivedLabelsMode = 'text' | 'prompt';

export type DerivedLabelMetadata = {
  /** True when this row was synthesized by a derivation rule rather than
   * emitted by XGuard. Downstream consumers (analytics, focused-review)
   * may want to distinguish synthetic from model-emitted signals. */
  synthetic: boolean;
  /** For synthetic rows: which input labels triggered the derivation.
   * Empty array for non-synthetic rows. */
  derivedFrom?: string[];
};

export function applyDerivedLabels(
  results: XGuardLabelResult[],
  mode: DerivedLabelsMode
): Array<XGuardLabelResult & DerivedLabelMetadata>;
```

Behavior:
- Each input row passes through with `synthetic: false, derivedFrom: undefined` unless dropped by a suppression rule.
- Suppression rules drop matching rows entirely (no row in output).
- Derivation rules append new rows with `synthetic: true, derivedFrom: [<contributing label names>]`.
- Function is pure, deterministic, idempotent — running it twice on the same input yields the same output.
- Function is mode-scoped — rule sets differ per mode (the rules above are prompt-mode; text-mode rules would be defined in the same file).

## Schema impact

Add two columns to `scanner_label_results` to mark synthetic rows and record their lineage:

- `synthetic UInt8` — `0` for model-emitted rows, `1` for derivation-synthesized rows. Analytics queries that want only "real" XGuard signals filter `WHERE synthetic = 0`.
- `derivedFrom Array(String)` — empty for model-emitted rows, list of contributing label names for synthetic rows (e.g. `['young', 'explicit']` on a synthetic `csam` row).

Both wrapped in `SimpleAggregateFunction(anyLast, ...)` to match the column convention of every other non-key column in the AggregatingMergeTree table. The values are deterministic per `(contentHash, version, label)` so `anyLast` is fine — there's nothing to aggregate across re-scans.

Migration is a metadata-only ALTER in CH (`ADD COLUMN` with a `DEFAULT` is constant-time, no data rewrite, regardless of table size). Existing rows acquire the default values lazily on read.

```sql
ALTER TABLE scanner_label_results
  ADD COLUMN IF NOT EXISTS synthetic SimpleAggregateFunction(anyLast, UInt8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS derivedFrom SimpleAggregateFunction(anyLast, Array(String)) DEFAULT [];
```

If the table is on a Replicated engine, run as `ALTER TABLE scanner_label_results ON CLUSTER '<cluster_name>' ADD COLUMN ...` so the change propagates to every replica.

Verify after migration:

```sql
DESCRIBE TABLE scanner_label_results FORMAT Vertical;
-- Confirm both columns appear with the expected default expressions.

SELECT count(), countIf(synthetic = 0) AS real, countIf(synthetic = 1) AS synth
FROM scanner_label_results;
-- Pre-rollout: synth should be 0. real should equal total.
```

The new columns are also written by any code path that inserts into `scanner_label_results` — the ClickHouse client wrapper that builds the insert row will need a one-line update to include `synthetic` and `derivedFrom` (defaulting to `0` and `[]` for non-synthetic rows). Skipping that update is benign because of the column-level `DEFAULT`, but explicit is better than implicit.

For the synthetic row's `score`, `threshold`, and `triggered` fields:
- `triggered`: always `1` (a synthetic row is only created when its derivation rule fired)
- `score`: `min(scores of contributing labels)` — represents the weakest input signal that fired
- `threshold`: `NULL` (no model threshold; the derivation rule itself is the threshold)

For the synthetic row's matched-term fields:

- `matchedText`: union of `matchedText` arrays across all contributing input labels
- `matchedPositivePrompt`: union of `matchedPositivePrompt` across all contributing input labels (deduplicated)
- `matchedNegativePrompt`: union of `matchedNegativePrompt` across all contributing input labels (deduplicated)

This gives moderators a complete view of what fired the derived signal. For a synthetic `csam` derived from `young` + `explicit`, the matched-prompt arrays show both the youth signals from `young` and the explicit-content signals from `explicit` in one row, instead of forcing the mod to cross-reference two separate rows.

Implementation note: matched-term arrays in `XGuardLabelResult` are `SimpleAggregateFunction(anyLast, Array(String))` — a single row per `(contentHash, version, label)`. The derived row uses the same field type. The CH AggregatingMergeTree dedup-by-key behavior collapses re-scans naturally, but within the derived array itself we should explicitly deduplicate before insert (the contributing labels may overlap on common matched terms).

## Moderator review impact

`ScannerLabelReview` is keyed `(contentHash, version, label)`. Synthetic rows show up there exactly like real ones — moderators can verdict `csam` as TruePositive/FalsePositive without knowing it's derived. The focused-review UI doesn't need to special-case synthetic rows for verdict capture, but should display the `derivedFrom` lineage for context ("synthetic, derived from young + explicit").

`policyHash` for synthetic rows is the SHA of the derivation rule itself (not a model policy hash). When the rule changes (e.g., we add `incest` to the CSAM derivation), the hash changes and analytics can cleanly bucket pre/post-change.

## Relationship to wildcard-audit synthetic CSAM

[wildcard-category-audit.service.ts](../../src/server/services/wildcard-category-audit.service.ts) currently re-implements `csam = young AND (suggestive OR explicit)` inside `verdictFromWildcardAuditResults`. Once derived labels ship:

1. The synthetic `csam` row appears in the per-label result set the wildcard audit reads.
2. `WILDCARD_AUDIT_FAIL_LABELS` adds `'csam'` (or rather, the existing `incest` etc. entries are joined by `csam`).
3. The custom `youngResult + sexualSignalResult` extraction code can be deleted — the wildcard audit just checks `FAIL_LABEL_SET.has(r.label) && isTriggered(r)` and the derived `csam` is included naturally.

This removes ~15 lines of per-consumer derivation logic and prevents future drift.

## Rollout plan

### Phase 1 — Dry-run (1 week)

1. Implement `applyDerivedLabels` as a pure function in `scanner-derived-labels.service.ts`. Unit tests for each rule (suppress-only, derive-only, both, neither, multi-derive).
2. Wire it into `recordXGuardScanFromWorkflow` in **dry-run mode**: compute derived results, but only write the **raw** results to ClickHouse. Log a diff (`{ added: [...], removed: [...] }`) to Axiom for every scan where the derived set differs from raw.
3. Spot-check Axiom logs for unexpected suppressions or derivations. Verify rule correctness against moderator verdicts (does the derived `csam` rate match what mods consider CSAM?).

### Phase 2 — Enable (production write)

1. Flip the CH write to use the derived set.
2. Add `synthetic` and `derivedFrom` columns to `scanner_label_results` via ALTER TABLE.
3. Update the focused-review UI to display "synthetic (derived from X+Y)" badge on synthetic rows.

### Phase 3 — Refactor wildcard-audit

1. Delete the per-consumer synthetic-CSAM logic in `wildcard-category-audit.service.ts`.
2. Add `'csam'` to `WILDCARD_AUDIT_FAIL_LABELS`.
3. Verify wildcard audits flip Dirty on the derived CSAM signal exactly as they did under the per-consumer logic.

### Phase 4 — Future rules

When the next suppression / derivation rule is needed (e.g., `extreme_nsfw = suggestive AND gore`), it's a one-line addition to the rule set, a unit test, and a `policyHash` bump. No new wiring.

## Open questions

1. **Telemetry on the suppressed rows.** If we silently drop suggestive-when-explicit, we lose visibility into edge cases where the model fired explicit but **not** suggestive (which would be a model-side bug — explicit-without-suggestive shouldn't happen under the hierarchical design). Worth keeping these as an Axiom-only telemetry signal even after dry-run ends? Probably yes — it's diagnostic for the model behavior, not operational.

2. **Should derivations support `NOT` clauses?** E.g., "synthesize `young_only_suggestive` when `young` AND `suggestive` AND NOT `explicit`." The proposed contract supports this naturally (the derivation reads the full pre-suppression triggered set, including negations). Not in initial rules but worth keeping the function shape compatible.

3. **What about cross-mode derivations?** E.g., "synthesize `csam` for an entity when prompt-mode `young` triggered AND text-mode `nsfw` triggered." Out of scope — would require joining results across scans. Different solution shape (entity-level rollup, not per-scan transform).

4. **Per-rule policyHash vs single bundled hash.** A single hash for the whole rule set means any rule change invalidates analytics for all derived labels. Per-rule hashes are cleaner but require more bookkeeping. Probably bundled is fine until the rule set grows past ~5.

## Testing approach

- Unit tests on `applyDerivedLabels` covering:
  - Empty input → empty output
  - Single triggered label, no rules match → unchanged
  - Suppression rule applies when both trigger
  - Suppression rule does NOT apply when only the subsumer triggers (no suggestive to suppress)
  - Suppression rule does NOT apply when only the dominator triggers (suggestive without explicit stays)
  - Derivation rule applies when input combination triggered
  - Derivation rule does NOT apply when only part of combination triggered
  - Combined: suppression + derivation on the same input
  - Idempotence: `apply(apply(x)) === apply(x)`
  - Mode-scoping: same input produces different output if mode rules differ

- Integration test against a sample workflow result with known labels triggered, verifying the CH write contains the expected derived set.

- Backfill test (Phase 1 dry-run telemetry) — does the derived rate match moderator intuition on existing content?
