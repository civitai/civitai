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
- **Key:** `(ownerUserId, date, source)` — **open (D1 below): almost certainly needs `accountType`/currency too.**
- **Value:** `sumState(amount)` / `sumMerge` — **must NOT `FLOOR`.** Verified (CH audit 2026-07-14): `amount` is
  fractional (sub-buzz, e.g. `0.0234`); the current comp query `FLOOR`s it, which would drop 0.01-fee precision.
- **Source rows:** `orchestration.resourceCompensations`, filtered to `source IN ('compensation','licenseFee')
  AND amount > 0` (those are the only real `source` values; the table also holds a few corrupt rows), resolving
  `ownerUserId` via `dictGet` on the row's `modelVersionId` at insert time.
- **Result:** owner review becomes a point lookup on `(ownerUserId, …)` instead of an `IN (…)` over every version
  the creator owns. Kills the slow-for-big-catalogs problem.

> **Scope note.** This MV covers `resourceCompensations`-sourced earnings — **comp + license fee only** (verified:
> those are the only real `source` values). **Tips, access-sale, and cosmetic-sale** are NOT here: tips appear in
> `default.buzz_resource_compensation`, and access/cosmetic are buzz *transactions* paid directly to the creator's
> `toAccountId` (backend question **A5**). See D2 below — the `/earnings` source filter spans this MV *plus* those.

## Launch fallback (Option B)

Until the dictionary + MV land, the app-side `WHERE modelVersionId IN (…)` query is an acceptable stopgap for
**small creators**. For launch we'd ship with top-earners hidden and a version-count cap on the per-model table,
then remove the cap once this rollup is live. Prefer landing the rollup before v1 if the schedule allows.

## Questions for Koen (build agenda)

> Grounded in a live ClickHouse audit (2026-07-14): `orchestration.resourceCompensations.source` has only
> **`compensation`** and **`licenseFee`** (plus a few corrupt rows to filter out); `amount` is **fractional**
> (sub-buzz, e.g. `0.0234`), and the current comp query `FLOOR`s it.

**Two of these are design decisions, not just confirmations — settle them first:**

- **D1 — the MV key must carry currency.** Rows have an `accountType` (buzz color: Yellow/User, Blue, Green) and
  license fees can settle to **cash**. B8 says show earnings in the currency received with **no conversion** — so
  the proposed key `(ownerUserId, date, source)` can't separate green vs yellow vs cash.
  **Decide:** key on `(ownerUserId, date, source, accountType)` (or a normalized `currency` dimension)?
- **D2 — the `source` filter spans more than this MV.** This MV yields **comp + license only**. The `/earnings`
  source filter also wants **tip, access-sale, cosmetic-sale** — none of which are in `resourceCompensations`
  (tips look to live in `default.buzz_resource_compensation`; access/cosmetic are direct buzz txns → **A5**).
  **Decide:** the single canonical `source` label set, and how reads **union** A1 (comp/license) with the tip +
  A5 sources so the filter is one consistent list. (A1 and A5 must share a source vocabulary.)

**Build-confirm checklist:**

- [ ] **CDC/ClickPipe path** — can we clone the Buzz-DB ClickPipe for prod `Model` + `ModelVersion` (Bastion /
      networking OK? CDC enabled on those tables)? Mirror **full tables, or just** `ModelVersion.id/modelId` +
      `Model.id/userId`?
- [ ] **Dictionary source/refresh** — CDC-mirror `ReplacingMergeTree` vs. direct-Postgres `LIFETIME(300)` (is a
      direct CH→prod-Postgres connection even possible through the Bastion?). Staleness tolerance for the owner
      lookup (ownership rarely changes)? On ownership transfer / version delete, we attribute *historical*
      earnings to the **current** owner and drop rows whose `modelVersionId` isn't in the dict — OK?
- [ ] **Amount precision** — MV aggregates **raw fractional** `amount` (no `FLOOR`); confirm the CH state type
      (`sumState` of Float64 vs Decimal) and display rounding line up with the `Decimal(10,2)` fee (A2).
- [ ] **Backfill** — `INSERT … SELECT … dictGet(...)` over history: all-time or from a cutoff? Handle versions
      missing from the dictionary.
- [ ] **Layout** — column types (`ownerUserId` UInt32, `source` LowCardinality, `accountType` if added), ordering
      key, `PARTITION BY toYYYYMM(date)`, TTL (likely none — financial history).

## References

- Backend question this answers: [questions-koen-backend.md](questions-koen-backend.md) §A1.
- Related product calls: B3 (which earnings sources ship v1), A5 (access/cosmetic MV), A2 (fractional fee).
