# Creator Studio — owner-keyed earnings rollup (build handoff)

> **Status:** design locked (Justin + review, 2026-07-09), **not built**. Ready to hand to an implementer.
> Answers backend question **A1** in [questions-koen-backend.md](questions-koen-backend.md). Pair with Koen on
> the final schema before building.

## The problem

Every ClickHouse earnings/usage aggregate is keyed by `modelVersionId`, never the creator's `userId`. The
`userId` columns that exist (`daily_user_resource`, `userModelDownloads`) are the **generator/downloader**, not
the **creator** who owns the resource. So "creator X's earnings/usage" has no direct key, and the only way to
answer it today is to look up all of a creator's `modelVersionId`s and query `WHERE modelVersionId IN (…)` —
which balloons for prolific creators and is too slow for the dashboard / `/earnings` / per-model `/analytics`
table.

## The design — dictionary + owner-keyed MV (not a join)

ClickHouse is poor at large joins but excellent at **dictionaries** (in-memory hash lookups). Use one.

### 1. `modelVersionId → ownerUserId` dictionary

- **Key:** `modelVersionId` (UInt/Int).
- **Attribute:** `ownerUserId` (the `Model.userId` of the version's parent model).
- **Source:** production Postgres (`ModelVersion` joined to `Model` for `userId`), reached via **CDC / ClickPipe**
  — CH cannot reach the Bastion-gated prod DB directly, and we already run ClickPipes against the Buzz DB, so
  reuse that pattern. CDC-mirror `Model` + `ModelVersion` into CH as `ReplacingMergeTree` tables, and back the
  dictionary with the mirror (or source the dictionary from Postgres directly with `LIFETIME(300)` auto-refresh
  if a direct connection is ever available — CDC is the realistic path here).
- **Usage in queries/MVs:** `dictGet('mv_owner_dict', 'ownerUserId', modelVersionId)` — O(1), no join.
- **Why a dictionary, not a refreshable MV:** this is a pure lookup. A refreshable MV is only warranted if we
  need to re-key historical rows.

### 2. Owner-keyed earnings MV

- **Engine:** `AggregatingMergeTree`.
- **Key:** `(ownerUserId, date, source)`.
- **Value:** `sum(amount)` (via `sumState` / `sumMerge`).
- **Source rows:** `orchestration.resourceCompensations` (comp + license fee), resolving `ownerUserId` via
  `dictGet` on the row's `modelVersionId` at insert time.
- **Result:** owner review becomes a point lookup on `(ownerUserId, …)` instead of an `IN (…)` over every version
  the creator owns. Kills the slow-for-big-catalogs problem.

> **Scope note.** This MV covers `resourceCompensations`-sourced earnings (comp, license fee). **Access-sale +
> cosmetic-sale** earnings are buzz *transactions* paid directly to the creator's `toAccountId` and are handled
> by a **separate** per-`toAccountId` MV — see backend question **A5**, not this doc.

## Launch fallback (Option B)

Until the dictionary + MV land, the app-side `WHERE modelVersionId IN (…)` query is an acceptable stopgap for
**small creators**. For launch we'd ship with top-earners hidden and a version-count cap on the per-model table,
then remove the cap once this rollup is live. Prefer landing the rollup before v1 if the schedule allows.

## Confirm-before-building checklist

- [ ] Confirm the CDC/ClickPipe path to prod Postgres for `Model` + `ModelVersion` (reuse the Buzz ClickPipe
      setup; verify Bastion/networking).
- [ ] Confirm dictionary source + refresh model (CDC-mirror `ReplacingMergeTree` vs. direct Postgres
      `LIFETIME(300)`).
- [ ] Confirm the exact `source` enum values on the owner-keyed MV (comp / license / tip …) and that they match
      the dashboard/`/earnings` filters.
- [ ] Confirm `amount` units/precision line up with the A2 fractional-fee migration (`licensingFee` → numeric at
      0.01) so sub-buzz amounts aggregate correctly.
- [ ] Backfill plan for existing `resourceCompensations` history into the owner-keyed MV.
- [ ] Pair with Koen on final column types + partitioning/TTL.

## References

- Backend question this answers: [questions-koen-backend.md](questions-koen-backend.md) §A1.
- Related product calls: B3 (which earnings sources ship v1), A5 (access/cosmetic MV), A2 (fractional fee).
