# ClickHouse `entityMetricCurrentTotals_v2` — point-lookup current-totals table

## Problem
The image feed / SSR hot path reads the aggregating VIEW `entityMetricDailyAgg_v2`
for current totals of a small set of entity ids. That view is **~86% of all
ClickHouse traffic (~28 q/s)**. Each query is cheap on CPU (~67ms, no I/O) but the
CH Cloud service is small (`max_threads=6`) and saturated, so every request queues
**2–5s**. The Redis cache in front of it is healthy (~88% hit, no eviction) — the
misses are an irreducible cold long-tail.

## Fix
Stop using the heavy aggregating view for hot-path point lookups. Serve cold cache
misses from a cheap point-lookup table keyed `ORDER BY (entityType, entityId,
metricType)` that holds the already-rolled-up running total per entity/metric.

Read path becomes (no GROUP BY / argMax / UNION at read time):
```sql
SELECT entityId, metricType, total
FROM entityMetricCurrentTotals_v2
WHERE entityType='Image' AND entityId IN (...) AND metricType IN (...)
```

## Semantics (must equal `entityMetricDailyAgg_v2`)
```
current_total(entityType, entityId, metricType_remapped) =
    sum(today rows where day >= today()-1)                       -- 1 row/key/day already
  + sum(argMax(total, sealedAt) per day for history, day < today()-1)
```
with the reaction remap `ReactionLike->Like, ReactionHeart->Heart,
ReactionLaugh->Laugh, ReactionCry->Cry, else metricType`.

A naive `sum(total)` over raw history is **wrong** — history is a
`SharedReplacingMergeTree ORDER BY (entityType,entityId,metricType,day)` deduped on
`sealedAt`; un-merged rows would double count. The `argMax(total, sealedAt)`
GROUP BY day picks the latest sealed value per day, matching the view exactly.

**Validated (read-only, re-audit 2026-06-22):** bounded deterministic Image sample
`entityId % 9973 = 0` — the single-table recompute SELECT (today+history, single
`today()`) summed per key vs `entityMetricDailyAgg_v2` summed per key →
**21,388 keys, 0 mismatches.**

## Maintenance — single table, single refreshable MV (matches existing repo pattern)
`entityMetricCurrentTotals_v2_mv` is `REFRESH EVERY 1 HOUR OFFSET 1 MINUTE
... TO entityMetricCurrentTotals_v2` — the same `REFRESH … TO` atomic-swap pattern
the existing `entityMetricDaily_today_v2_mv` and `entityMetricDailySeal_v2_mv`
already use. It fully recomputes the today+history union **in one pass under a
single `today()` evaluation** and swaps the result in.

### Why single-table, NOT a staggered split
A re-audit rejected the tempting optimization of splitting into two SummingMergeTree
tables — history recomputed once daily, today recomputed every few minutes — UNIONed
by a view. **That split under-counts the seam day.** The two MVs evaluate `today()`
at *different* refresh times, so around the day rollover the seam day `today()-2`
falls in **neither** table for ~3h/night (e.g. 00:00–03:00) → the view drops ~1 full
day of metrics on every recently-active entity. The single MV avoids this entirely:
there is exactly **one `today()` per recompute**, so today and history partition the
day axis with no gap or overlap at the boundary. Do **not** re-split without an
incremental seal-triggered history MV (see below).

### Tradeoff
Current totals are up to **~1h stale** (the refresh cadence). Acceptable for the
display counts this serves on the feed/SSR hot path.

### Cost
The full recompute scans the **~685M-row** history table (~159s, >8 GiB) once per
refresh = **24×/day** at the 1-hour cadence. Still a large net win: flipping the
civitai consumer flag to read this point table removes **~28 q/s** of expensive
`entityMetricDailyAgg_v2` view reads (~86% of CH traffic). The recompute cadence is
**tunable** — raise/lower the `REFRESH EVERY` interval if 24×/day proves too heavy.

> Future (cheap **and** fresh, NOT in this PR): an **incremental seal-triggered
> history MV** — maintain the history total incrementally as days seal (history only
> changes once/day at the ~01:00 seal) and keep only the tiny today branch
> recomputing frequently, *without* the staggered-`today()` seam bug above. That is
> the path to both low recompute cost and low staleness. The single-table hourly
> full-recompute is the simplest provably-correct version and is what ships here.

## Files
- `scripts/sql/entity-metric-current-totals.sql` — DDL + backfill + teardown (canonical).
- `scripts/setup-clickhouse-current-totals.ts` — runnable twin (mirrors `setup-clickhouse-rollup-view.ts`).

## Runbook (HUMAN-GATED — do NOT auto-run; CH is saturated)
1. **Create table + MV** (light — MV starts empty):
   ```bash
   CLICKHOUSE_URL=... tsx scripts/setup-clickhouse-current-totals.ts
   ```
   or run sections 1 + 2 of `scripts/sql/entity-metric-current-totals.sql`.
2. **Populate.** Either:
   - Let the hourly refresh fill it (zero extra load decision; first refresh within ~1 h), **or**
   - Force the first refresh: `SYSTEM REFRESH VIEW default.entityMetricCurrentTotals_v2_mv`, **or**
   - Run the one-time backfill **off-peak** (heavy ~685M-row scan):
     `tsx scripts/setup-clickhouse-current-totals.ts --backfill`
     or uncomment/run section 3 of the SQL file.
3. **Verify equivalence** before flipping the civitai read flag — run the civitai
   correctness harness (PR 2: `scripts/check-image-metrics-equivalence.ts`) over a
   sample of real Image ids; require **0 mismatches**.
4. **Rollback:** section 4 of the SQL file (`DROP VIEW … ; DROP TABLE …`). The civitai
   flag is OFF by default, so dropping these objects has no effect on the live read
   path unless someone has already flipped `image-metrics-use-current-totals` on.

## Ordering note
This table is independent of the civitai read change — it can be created and
populated first while the civitai flag stays OFF, then the flag is flipped only
after the harness confirms 0 mismatches. The two PRs are **not** stacked.
