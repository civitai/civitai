import { clickhouse } from '~/server/clickhouse/client';
import { createJob } from './job';

/**
 * Keeps `default.user_activity_rollup` current for the Creator Studio audience panels. The table, the
 * backfill, the engine choice and why re-running a window is safe are all in
 * src/server/clickhouse/migrations/2026-09-04-user-activity-rollup.sql.
 *
 * The part local to this file: the overlap has to absorb the whole gap. A source row older than the
 * window is not picked up by a later run, it is simply never picked up — so shrinking LOOKBACK_HOURS
 * below the length of a plausible outage loses rows silently, and recovering needs the backfill re-run
 * for the affected range.
 */

// Four consecutive missed runs still leave no gap (4 × 30 min < 3 h), which covers a deploy
// window or a stuck lock without anyone having to notice.
const LOOKBACK_HOURS = 3;

// All four are ORDER BY time first (checked in `system.tables`, 2026-09-04), so every arm is a
// primary-key range scan over a few hundred thousand rows rather than anything table-wide.
const SOURCES = ['pageViews', 'views', 'reactions', 'userActivities'] as const;

function insertSql(source: (typeof SOURCES)[number]) {
  // Only `pageViews` carries a country. The others stamp theirs at the epoch so it can never win the argMax.
  const country =
    source === 'pageViews'
      ? 'argMaxState(CAST(country AS String), time)'
      : `argMaxState(CAST('' AS String), toDateTime(0))`;
  return `
    INSERT INTO default.user_activity_rollup
    SELECT userId, max(time) AS lastSeen, ${country} AS country
    FROM default.${source}
    WHERE userId > 0 AND time > now() - INTERVAL ${LOOKBACK_HOURS} HOUR
    GROUP BY userId
  `;
}

export const userActivityRollupJob = createJob(
  'user-activity-rollup',
  '*/30 * * * *',
  async () => {
    if (!clickhouse) return { skipped: 'clickhouse-unavailable' };

    // Serially, not Promise.all: four concurrent GROUP BYs against the busiest tables on the
    // cluster buys nothing on a job with a 30-minute period.
    const refreshed: string[] = [];
    for (const source of SOURCES) {
      await clickhouse.$exec(insertSql(source));
      refreshed.push(source);
    }

    return { sources: refreshed, lookbackHours: LOOKBACK_HOURS };
  },
  { dedicated: true, lockExpiration: 10 * 60 }
);
