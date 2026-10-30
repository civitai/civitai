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
    //
    // 🔴 Each arm is isolated. A bare loop lets ONE failing source truncate every LATER arm and
    // skip the daily roll entirely, and that failure is invisible downstream: the tables carry
    // no per-arm marker, and AggregatingMergeTree collapses a bucket's seven arm-rows into one,
    // so counting rows or buckets cannot tell a one-arm hour from a seven-arm hour. The shape
    // that makes it likely rather than theoretical is a single flaky source — the
    // `civitai_pg.User` bridge, or `orchestration.jobs` — outlasting LOOKBACK_HOURS: arms before
    // it keep succeeding, arms after it are permanently missing, and a panel then shows viewers
    // healthy while generators, buyers and signups collapse.
    const refreshed: string[] = [];
    const failed: { column: string; error: string }[] = [];
    for (const arm of ARMS) {
      jobContext.checkIfCanceled();
      try {
        await clickhouse.$exec(hourlyInsertSql(arm));
        refreshed.push(arm.column);
      } catch (e) {
        failed.push({ column: arm.column, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Rolled from whatever landed, deliberately: a partial hour is still worth carrying into the
    // daily table, and skipping the roll would freeze the FOREVER history for all seven
    // populations because one arm's source was briefly unavailable. Safe to re-run — the daily
    // table is AggregatingMergeTree and re-merging the same states is the identity — so the next
    // successful run re-rolls the same days and repairs the gap on its own, provided the arm
    // recovers within LOOKBACK_HOURS.
    jobContext.checkIfCanceled();
    await clickhouse.$exec(dailyRollSql());

    // Throw AFTER the roll so the failure still reaches `job_errors_total` and the duration
    // histogram (seeded by createJob — see the migration's monitoring section) rather than being
    // swallowed into a success. Returning normally here would make a silently-partial hour
    // indistinguishable from a healthy one in the only telemetry this job has.
    if (failed.length) {
      throw new Error(
        `user-population-snapshot: ${failed.length} of ${ARMS.length} arm(s) failed (` +
          `${failed.map((f) => `${f.column}: ${f.error}`).join('; ')}); ` +
          `${refreshed.length} succeeded and the daily roll ran`
      );
    }

    return { columns: refreshed, lookbackHours: LOOKBACK_HOURS, dailyRollDays: DAILY_ROLL_DAYS };
  },
  // 🔴 No `dedicated` flag: job.ts documents it as INERT — nothing reads it, and setting it would
  // read as a duplicate-run mitigation that does not exist.
  //
  // ⚠️ And `lockExpiration` is NOT one either. It is a HARD CAP on total hold, not a floor: the
  // refresh interval in the run-jobs route calls `release()` once the budget is spent WHILE the
  // job is still running, so a slow run is precisely when the lock is freed. With
  // `keepLockOnDisconnect` absent (the default) a client hang-up also releases, which job.ts
  // documents as producing "a competing second run of the same work".
  //
  // That is acceptable here, and the reason is the design's own idempotency rather than any
  // serialisation: two concurrent runs insert states that merge as a set union, so a duplicate
  // run cannot double a count. An earlier draft of this comment claimed the lock "outlives a slow
  // run rather than freeing it for a competing one", which is the opposite of what the mechanism
  // does. 20 minutes is sized to cover seven scans plus the roll, not to guarantee exclusivity.
  { lockExpiration: 20 * 60 }
);
