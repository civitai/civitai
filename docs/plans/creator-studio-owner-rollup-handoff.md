# Handoff — Owner-keyed earnings/usage rollup in ClickHouse (Creator Studio)

**Status:** design handoff, NOT built. Build when the Creator Studio analytics/earnings pages need real
owner-scoped data at scale.
**Owner of the decision:** Justin. **Executing agent:** TBD.
**Source questions:** [creator-studio/QUESTIONS-ROUNDUP.md](../creator-studio/QUESTIONS-ROUNDUP.md) EARN-2 (+ ANALYTICS-2,
DASH-3). **Plan context:** [creator-studio-plan.md §7.6](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views).

---

## 1. Why

Creator Studio needs to answer "**how much has creator X earned / how much is X's catalog being used**", scoped to a
single creator, fast, at any catalog size.

Every earnings + usage aggregate in ClickHouse is keyed by **`modelVersionId`**, never the creator's **`userId`**.
The `userId` columns that exist (`daily_user_resource`, `userModelDownloads`) are the *generator/downloader*, not the
*creator*. So there is no owner dimension to group on.

Today's workaround (used elsewhere): when an owner reviews their data, the app knows all of their `modelVersionId`s
and queries `WHERE modelVersionId IN (…)`. This balloons and gets slow for prolific creators (hundreds/thousands of
versions). We want a point lookup by `ownerUserId` instead.

The missing piece is a **`modelVersion → ownerUserId` mapping inside ClickHouse**, plus rollups that use it.

---

## 2. Decision already made (Justin)

- Get the mapping into ClickHouse via **ClickPipe / CDC**, same pattern as the **existing ClickPipes connected to the
  Buzz database**. The prod app DB is not publicly exposed and reaches CH over **Bastion**, so a direct
  ClickHouse→Postgres connection isn't viable — **CDC is the path**.
- Use a **dictionary** for the lookup (not a runtime JOIN — CH joins are weak for this; a dictionary is an O(1) hash
  lookup).
- Build an **owner-keyed aggregating MV** so owner review is a point lookup.

This doc turns that into a concrete build plan.

---

## 3. Source data (Postgres → ClickHouse)

The mapping is a 2-table join in the app DB:

- `Model (id, "userId")` — `userId` is the creator/owner.
- `ModelVersion (id, "modelId")` — `modelId → Model.id`.

So `modelVersionId → ownerUserId` = `ModelVersion.modelId = Model.id`, take `Model.userId`.

**CDC scope:** replicate **`Model`** and **`ModelVersion`** (id/modelId/userId columns are enough; replicate full
rows if simpler) into CH as **`ReplacingMergeTree`** mirrors, e.g. `default.pg_model` and `default.pg_model_version`,
`ORDER BY id`, with a version/`_peerdb`/`updatedAt` column as the ReplacingMergeTree version so updates + deletes
collapse correctly. Match whatever convention the existing Buzz ClickPipe uses (soft-delete handling, `_peerdb_*`
metadata columns, etc.) — **inspect an existing pipe first and mirror its conventions.**

> ⚠️ Ownership can change (model transfers, merges). CDC keeps the mirror current; the dictionary reload (below) then
> picks it up. If a downstream MV resolved owner **at insert time**, historical rows keep the owner as-of-insert —
> see §4 option A vs B for whether that matters to you.

---

## 4. The mapping: dictionary

Create a CH **dictionary** keyed on `modelVersionId`, returning `ownerUserId`.

Source = a query over the two mirror tables (final/collapsed):

```sql
-- conceptual dictionary source query
SELECT mv.id AS modelVersionId, m.userId AS ownerUserId
FROM default.pg_model_version FINAL AS mv
INNER JOIN default.pg_model FINAL AS m ON m.id = mv.modelId
```

Dictionary definition (adjust names/creds to our CH conventions):

```sql
CREATE DICTIONARY default.mv_owner_dict (
  modelVersionId UInt32,
  ownerUserId    UInt32
)
PRIMARY KEY modelVersionId
SOURCE(CLICKHOUSE(QUERY '<the SELECT above>'))
LAYOUT(HASHED())
LIFETIME(MIN 300 MAX 600);   -- reload every 5-10 min; CDC keeps the source fresh
```

Lookup in any query/MV: `dictGet('default.mv_owner_dict', 'ownerUserId', toUInt32(modelVersionId))`.

New model versions appear in the dict within one `LIFETIME` window after CDC lands them. That lag is fine for
analytics; it only matters for the resolve-at-insert option below.

---

## 5. The rollups — two options

### Source of truth for earnings

`orchestration.resourceCompensations` (SummingMergeTree, keyed `modelVersionId, date`, with `accountType`, `source`
where source ∈ comp / licenseFee / tip). Mirror: `default.buzz_resource_compensation`. Generations:
`default.daily_resource_generation_counts`. Downloads: `default.daily_downloads*`.

### Option A (recommended) — owner-keyed aggregating MV (point lookup)

Target table:

```sql
CREATE TABLE default.owner_earnings_daily (
  ownerUserId UInt32,
  date        Date,
  source      LowCardinality(String),
  amount      AggregateFunction(sum, Int64)   -- or SummingMergeTree with a plain sum column
)
ENGINE = AggregatingMergeTree
ORDER BY (ownerUserId, date, source);
```

MV that populates it, resolving owner via the dictionary **on insert**:

```sql
CREATE MATERIALIZED VIEW default.owner_earnings_daily_mv TO default.owner_earnings_daily AS
SELECT
  dictGet('default.mv_owner_dict','ownerUserId', toUInt32(modelVersionId)) AS ownerUserId,
  date,
  source,
  sumState(amount) AS amount
FROM <the raw insert source that feeds resourceCompensations>
GROUP BY ownerUserId, date, source;
```

Owner review query = a point lookup:

```sql
SELECT date, source, sumMerge(amount) AS earned
FROM default.owner_earnings_daily
WHERE ownerUserId = {ownerId:UInt32} AND date BETWEEN {from:Date} AND {to:Date}
GROUP BY date, source ORDER BY date;
```

> ⚠️ **Critical confirm:** a ClickHouse MV fires on **INSERTs to its FROM table**, not on background merges. If
> `resourceCompensations` is itself the target of an MV fed by some raw table, hang `owner_earnings_daily_mv` off that
> **same raw source**, not off `resourceCompensations`. Trace the insert path before writing the MV
> ([§7 confirm list](#7-confirm-before-building)).

Trade-off: owner is resolved as-of-insert. If a model transfers later, past earnings stay with the old owner unless
you also re-key history (a one-off backfill). For creator earnings that's usually the correct behavior (you earned it
while you owned it), but confirm with Justin.

### Option B (simpler v1 fallback) — resolve at query time

Keep earnings keyed by `modelVersionId` (as today) and resolve owner in the **query**:

```sql
SELECT date, source, sum(amount) AS earned
FROM orchestration.resourceCompensations
WHERE dictGet('default.mv_owner_dict','ownerUserId', toUInt32(modelVersionId)) = {ownerId:UInt32}
  AND date BETWEEN {from:Date} AND {to:Date}
GROUP BY date, source;
```

Better than app-side `IN (…)` (no giant id list, always current owner), but it still scans the resourceCompensations
partitions for the window rather than a point lookup. Fine for launch / low traffic; graduate to Option A when it
gets slow. **Recommendation:** ship B if the MV insert-path wiring in A is uncertain at build time, then move to A.

### Per-model breakdown (ANALYTICS-2 / DASH-3)

For the per-model table and "top-earning models" widget, add `modelVersionId` to the Option A key:

```sql
ORDER BY (ownerUserId, modelVersionId, date, source)
```

Then top-models = `WHERE ownerUserId = ? GROUP BY modelVersionId ORDER BY sum DESC LIMIT N`.

---

## 6. Gap #2 — access-sale + cosmetic-sale earnings (only if v1 needs them)

EARN-1 / PLAN-3 want **all** earnings sources day 1, including model-access purchases and cosmetic sales. Those are
buzz **transactions**, not in `resourceCompensations`. `buzz.transactions_daily_stats` is platform-wide (no account
dimension). This needs a **per-`toAccountId` daily buzz-earnings-by-type MV** off the buzz-transactions stream:

```sql
-- target: (toAccountId, date, type) -> sum(amount)
ORDER BY (toAccountId, date, type)
```

`toAccountId` for a creator's earnings *is* their `userId` (buzz account), so this one does **not** need the
dictionary — it's already owner-keyed. Confirm the buzz-transactions source table/stream in CH and the `type` values
that correspond to access-sale vs cosmetic-sale vs tip.

---

## 7. Confirm before building

1. **Existing Buzz ClickPipe config** — find it, copy its conventions (soft-delete/`_peerdb_is_deleted`, version
   column, naming, Bastion/network setup). Don't invent a new pattern.
2. **Insert path into `resourceCompensations`** — is it written directly, or via an MV from a raw table? Option A's MV
   must hang off the actual insert source. (Blocker for Option A.)
3. **ID types** — confirm `modelVersionId` / `userId` widths in CH (UInt32 vs UInt64) so the dictionary + dictGet
   casts match.
4. **Owner-as-of-insert vs current-owner** for historical earnings after a model transfer (§5 Option A trade-off) —
   Justin's call.
5. **buzz-transactions source in CH** + the `type` enum values for gap #2 (§6).
6. **Refresh lag tolerance** — is a 5-10 min dictionary `LIFETIME` acceptable for brand-new versions showing earnings?
   (Almost certainly yes.)
7. **Does v1 actually need gap #2 and the per-model breakdown**, or do those trail? (Drives how much of this ships
   first — see EARN-1 / ANALYTICS-2 / DASH-3.)

---

## 8. Suggested build order

1. Stand up the CDC ClickPipe for `Model` + `ModelVersion` → CH mirrors (reuse Buzz pipe pattern).
2. Create `mv_owner_dict`; validate `dictGet` returns correct owners on a sample of known versions.
3. Ship **Option B** query path so the earnings/analytics pages have real owner-scoped data immediately.
4. Trace the `resourceCompensations` insert path; build **Option A** (`owner_earnings_daily` + MV) and cut the app
   read over to it; backfill from history.
5. Add the per-model key variant (ANALYTICS-2 / DASH-3) if in scope.
6. Add gap #2 buzz-transactions MV (§6) if access/cosmetic sales are v1.

## 9. Validation

- Pick 3-5 creators (one tiny, one huge catalog). Compare owner-keyed totals vs the legacy app-side
  `modelVersionId IN (…)` sum (`getDailyCompensationRewardByUser`) for the same window — they must match.
- Check a just-created model version earns correctly once CDC + dict reload land it (measure the actual lag).
- Confirm a transferred model behaves per the §7.4 decision.
