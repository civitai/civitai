import { clickhouse } from '~/server/clickhouse/client';
import { createJob } from './job';
import {
  ARMS,
  DAILY_ROLL_DAYS,
  LOOKBACK_HOURS,
  dailyRollSql,
  hourlyInsertSql,
} from './user-population-snapshot.sql';

/**
 * Keeps `default.user_population_hourly` and `default.user_population_daily` current for the
 * business dashboards' user-population panels. The tables, the engine choice, the seven-column
 * split, why HLL states rather than counts and why re-running a bucket is safe are all in
 * src/server/clickhouse/migrations/2026-09-25-user-population-snapshot.sql. Read that first.
 *
 * The parts local to this file:
 *
 * 1. Every arm writes ALL SEVEN state columns — its own via `-State`, the other six via
 *    `-StateIf(..., 0)`, which builds an empty state. Empty is the identity under merge, so the
 *    arms compose without any arm knowing about the others, and nothing here depends on how
 *    ClickHouse fills an omitted AggregateFunction column.
 *
 * 2. The overlap has to absorb the whole gap. A source row older than the window is not picked
 *    up by a later run, it is simply never picked up — so shrinking LOOKBACK_HOURS below the
 *    length of a plausible outage loses rows silently, and recovering needs the backfill re-run
 *    for the affected range. Same property, and same warning, as user-activity-rollup.ts.
 *
 * 3. A bucket is only COMPLETE once a run has happened after that hour closed. At :15 the run
 *    covers the previous LOOKBACK_HOURS, so the hour that just ended is finished by the next
 *    run, and the current hour is a partial that fills in as later runs re-cover it. Re-covering
 *    is free of consequence because the merge is a set union — this is the same property that
 *    makes catch-up safe, seen from the other end.
 */

export const userPopulationSnapshotJob = createJob(
  'user-population-snapshot',
  // Hourly at :15 rather than on the hour, to stay out of the top-of-hour crowd. More often
  // than hourly would only refine the in-progress bucket, at a full re-scan of every source.
  '15 * * * *',
  async (jobContext) => {
    if (!clickhouse) return { skipped: 'clickhouse-unavailable' };

    // Serially, not Promise.all: seven concurrent GROUP BYs against the busiest tables on the
    // cluster buys nothing on a job with an hourly period, and `views` alone is 7.95B rows.
    const refreshed: string[] = [];
    for (const arm of ARMS) {
      jobContext.checkIfCanceled();
      await clickhouse.$exec(hourlyInsertSql(arm));
      refreshed.push(arm.column);
    }

    // After the arms, so the roll sees this run's hours. Safe to re-run: the daily table is
    // AggregatingMergeTree and re-merging the same states is the identity.
    jobContext.checkIfCanceled();
    await clickhouse.$exec(dailyRollSql());

    return { columns: refreshed, lookbackHours: LOOKBACK_HOURS, dailyRollDays: DAILY_ROLL_DAYS };
  },
  // 🔴 No `dedicated` flag: job.ts documents it as INERT — nothing reads it, and setting it
  // would read as a duplicate-run mitigation that does not exist. The lock is what serialises
  // runs. Seven scans plus the roll, so the lock outlives a slow run rather than freeing it
  // for a competing one.
  { lockExpiration: 20 * 60 }
);
