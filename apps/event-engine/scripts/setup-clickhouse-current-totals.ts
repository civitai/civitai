/**
 * setup-clickhouse-current-totals.ts
 *
 * Creates the `entityMetricCurrentTotals_v2` point-lookup table + its refreshable
 * materialized view, and (optionally) runs the one-time backfill.
 *
 * This mirrors `setup-clickhouse-rollup-view.ts`. The DDL here is the runnable
 * twin of `scripts/sql/entity-metric-current-totals.sql` (keep the two in sync).
 *
 * The current-total per (entityType, entityId, metricType) is, exactly as the
 * read VIEW `entityMetricDailyAgg_v2` computes it:
 *   sum(today rows, day>=today()-1)  +  sum(argMax(total,sealedAt)-per-day history rows, day<today()-1)
 * with the reaction remap (ReactionLike->Like, etc.). Validated against the view
 * for 100 sample Image ids: 0 mismatches.
 *
 * Usage:
 *   CLICKHOUSE_URL=... tsx scripts/setup-clickhouse-current-totals.ts            # create table + MV only
 *   CLICKHOUSE_URL=... tsx scripts/setup-clickhouse-current-totals.ts --backfill # also run the heavy one-time backfill
 *   CLICKHOUSE_URL=... tsx scripts/setup-clickhouse-current-totals.ts --drop-existing
 *
 * SINGLE-TABLE design (one SummingMergeTree + one refreshable MV that recomputes
 * today+history atomically under a SINGLE today() evaluation). A re-audit proved
 * a split into two staggered tables under-counts the seam day for ~3h/night
 * (the two MVs evaluate today() at different times) — see the .sql header. The
 * MV refreshes EVERY 1 HOUR: current totals are up to ~1h stale (fine for display
 * counts), costing one ~685M-row recompute/hour (24×/day) but removing ~28 q/s of
 * expensive view reads. Cadence is tunable; future cheap-AND-fresh path is an
 * incremental seal-triggered history MV.
 *
 * ⚠️ The backfill scans the full ~685M-row history table. On the saturated CH
 * Cloud service this is a HUMAN-GATED op — run it deliberately (off-peak), or
 * skip it and let the hourly refresh populate the table on its own schedule
 * (you can force the first one with `SYSTEM REFRESH VIEW
 * entityMetricCurrentTotals_v2_mv`).
 */
import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

const TABLE = 'entityMetricCurrentTotals_v2';
const MV = 'entityMetricCurrentTotals_v2_mv';

// Reaction remap — identical to entityMetricDailyAgg_v2.
const REMAP =
  "multiIf(metricType = 'ReactionLike', 'Like', metricType = 'ReactionHeart', 'Heart', metricType = 'ReactionLaugh', 'Laugh', metricType = 'ReactionCry', 'Cry', metricType)";

// The recompute SELECT — same body the MV uses and the same semantics as the read view.
const RECOMPUTE_SELECT = `
SELECT
    entityType,
    entityId,
    metricType,
    sum(total) AS total,
    now() AS refreshedAt
FROM
(
    SELECT
        entityType,
        entityId,
        ${REMAP} AS metricType,
        total
    FROM default.entityMetricDailyAgg_today_v2
    WHERE day >= (today() - 1)
    UNION ALL
    SELECT
        entityType,
        entityId,
        ${REMAP} AS metricType,
        t AS total
    FROM
    (
        SELECT
            entityType,
            entityId,
            metricType,
            day,
            argMax(total, sealedAt) AS t
        FROM default.entityMetricDailyAgg_history_v2
        WHERE day < (today() - 1)
        GROUP BY entityType, entityId, metricType, day
    )
)
GROUP BY entityType, entityId, metricType
SETTINGS max_bytes_before_external_group_by = 6000000000`;

async function setup(runBackfill: boolean) {
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) throw new Error('CLICKHOUSE_URL is not defined');

  const client = createClient({ url: clickhouseUrl, request_timeout: 30 * 60 * 1000 });

  try {
    console.log('Creating point-lookup current-totals table...');
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS default.${TABLE}
        (
            entityType  LowCardinality(String),
            entityId    Int32,
            metricType  LowCardinality(String),
            total       Int64,
            refreshedAt DateTime DEFAULT now()
        )
        ENGINE = SummingMergeTree(total)
        ORDER BY (entityType, entityId, metricType)
        SETTINGS index_granularity = 8192
      `,
    });
    console.log(`  ✓ Table ${TABLE} created\n`);

    console.log('Creating refreshable materialized view (every 1 hour)...');
    await client.exec({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS default.${MV}
        REFRESH EVERY 1 HOUR OFFSET 1 MINUTE
        TO default.${TABLE}
        (
            entityType  LowCardinality(String),
            entityId    Int32,
            metricType  LowCardinality(String),
            total       Int64,
            refreshedAt DateTime
        )
        DEFINER = default SQL SECURITY DEFINER
        AS ${RECOMPUTE_SELECT}
      `,
    });
    console.log(`  ✓ Materialized view ${MV} created (REFRESH EVERY 1 HOUR)\n`);

    if (runBackfill) {
      console.log('Running one-time backfill (heavy — scans full history)...');
      const t0 = Date.now();
      await client.exec({
        query: `INSERT INTO default.${TABLE} (entityType, entityId, metricType, total, refreshedAt) ${RECOMPUTE_SELECT}`,
      });
      console.log(`  ✓ Backfill complete in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    } else {
      console.log('Skipping backfill. Force the first population with:');
      console.log(`  SYSTEM REFRESH VIEW default.${MV}\n`);
    }

    console.log('Verifying...');
    const res = await client.query({
      query: `SELECT count() AS rows, uniqExact(entityType) AS entityTypes, uniqExact(metricType) AS metricTypes, sum(total) AS totalValue FROM default.${TABLE}`,
      format: 'JSONEachRow',
    });
    const [stats] = (await res.json()) as Array<{ rows: string; entityTypes: string; metricTypes: string; totalValue: string }>;
    console.log(`  rows=${Number(stats.rows).toLocaleString()} entityTypes=${stats.entityTypes} metricTypes=${stats.metricTypes} totalValue=${Number(stats.totalValue).toLocaleString()}`);
  } finally {
    await client.close();
  }
}

async function dropExisting() {
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) throw new Error('CLICKHOUSE_URL is not defined');
  const client = createClient({ url: clickhouseUrl });
  try {
    console.log('Dropping existing current-totals MV + table...');
    await client.exec({ query: `DROP VIEW IF EXISTS default.${MV}` });
    await client.exec({ query: `DROP TABLE IF EXISTS default.${TABLE}` });
    console.log('  ✓ Dropped\n');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    try {
      if (args.includes('--drop-existing')) await dropExisting();
      await setup(args.includes('--backfill'));
    } catch (error) {
      console.error('Failed to setup current-totals table:', error);
      process.exit(1);
    }
  })();
}

export { setup as setupClickhouseCurrentTotals, dropExisting as dropCurrentTotalsTables };
