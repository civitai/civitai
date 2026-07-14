# CDC work for Koen — Creator Studio per-model earnings

Standalone ask, extracted from [owner-rollup-handoff.md](owner-rollup-handoff.md) Part 2 (the full spec + the
ClickHouse audit basis live there). Reflects Justin's D1/D2/attribution answers (2026-07-14), so this is the
**narrowed** scope, not the original.

Answers backend question **A1** (and narrows **A5**) in [questions-koen-backend.md](questions-koen-backend.md).

---

## TL;DR

Build a `modelVersionId → ownerUserId` **dictionary in ClickHouse**, backed by a **CDC/ClickPipe mirror** of prod
Postgres `Model` + `ModelVersion`. It's the only remaining backend blocker for Creator Studio's **per-model**
earnings views, and it's **on the v1 critical path**.

## Scope — what needs it, what doesn't

- **Does NOT need CDC:** earnings *by source* (`/earnings` page + dashboard headline totals). Those read
  `default.buzzTransactions`, which is **already owner-keyed** (`toAccountId` = the creator's `userId`, verified
  1:1; a `byToAccount` projection makes the read cheap). This half ships today with no dictionary. *(This is the
  part that used to be assumed to need CDC — Justin's D2 answer removed that dependency.)*
- **NEEDS CDC (this doc):** **per-model** breakdowns —
  - the **per-model earnings/usage table** on `/analytics`, and
  - the dashboard **"top-earning models"** tile.

  Both are genuinely `modelVersionId`-keyed: they read `orchestration.resourceCompensations`, where a
  compensation/licenseFee row is a **daily per-creator aggregate with no owner column**. Justin confirmed both
  tiles ship, so the dictionary is required, not optional.

## The build (3 pieces)

1. **CDC/ClickPipe mirror** of prod Postgres `Model` + `ModelVersion` → ClickHouse as `ReplacingMergeTree` tables.
   Reuse the existing **Buzz-DB ClickPipe** pattern — CH can't reach the Bastion-gated prod DB directly.
2. **Dictionary `mv_owner_dict`** — key `modelVersionId` (UInt/Int), attribute `ownerUserId` (the parent
   `Model.userId`), **backed by the CDC mirror**.
3. **Read path:** per-model queries hit `resourceCompensations` and resolve owner with
   `dictGet('mv_owner_dict', 'ownerUserId', modelVersionId)` — O(1), no join. "Creator X's models" becomes a point
   lookup instead of `WHERE modelVersionId IN (…)` over the whole catalog.

## 🔴 Hard constraint — do NOT source the dictionary from Postgres directly

The two existing Postgres-sourced dictionaries (`default.model_names`, `default.model_file_sizes`) have
**hardcoded IPs**, and `model_names` is **dead in prod right now** — `dictGet` on it returns `Connection refused`.
Back `mv_owner_dict` with the **CDC mirror** so there's no read-time network dependency. (A dead dict on an
insert-path MV halts ingestion; this one is read-path only, which is safer — but the lesson stands.)

## Open confirmations (the actual asks)

- [ ] **CDC/ClickPipe path** — can we clone the Buzz-DB ClickPipe for prod `Model` + `ModelVersion`? Bastion /
      networking OK? CDC/replication enabled on those tables? Mirror **full tables, or just** the needed columns
      (`ModelVersion.id`, `ModelVersion.modelId`, `Model.id`, `Model.userId`)?
- [ ] **Dictionary refresh + staleness** — CDC-mirror `ReplacingMergeTree` backing (per the constraint above).
      Ownership rarely changes — what staleness is tolerable for the owner lookup?
- [ ] **Table/layout** — `ownerUserId` UInt32, ordering key, `PARTITION BY toYYYYMM(date)`, TTL (likely none —
      financial history).
- [ ] **Corrupt-row filter is mandatory** on anything reading `resourceCompensations`: 11 all-time garbage rows
      (binary-junk `accountType`, absurd dates, amounts up to `~2e+267`) will swamp a `sum()`. Filter
      `match(accountType, '^[A-Za-z]+$')` + a sane amount bound. (Written by the external .NET orchestrator;
      reported upstream separately — nothing in this repo inserts into that table.)

## Already settled (no need to re-decide)

- **Attribution on model transfer:** historical earnings **follow the new owner** (Justin, 2026-07-14). A
  point-in-time `dictGet` does this for free — no extra work. Side effect: a creator's past totals shift when a
  model moves. Rows whose `modelVersionId` isn't in the dictionary are dropped.
- **Currency dimension:** per-model reads keep `accountType` in the grouping so buzz colors / cash stay separate
  (B8, no conversion). Note the `resourceCompensations.accountType` **label history** — only matters if the
  window is widened past 90 days (see the handoff doc); v1's 90-day cap sidesteps it.
- **Launch fallback:** until the dictionary lands, the `/analytics` per-model table ships the
  `WHERE modelVersionId IN (…)` stopgap for **small creators** (version-count cap, top-earners hidden), then drops
  the cap once CDC is live. `/earnings` + dashboard totals need no fallback (they read `buzzTransactions`).

## References

- Full spec + audit basis: [owner-rollup-handoff.md](owner-rollup-handoff.md) Part 2 + the ⚠️ warnings.
- Backend question: [questions-koen-backend.md](questions-koen-backend.md) §A1.
