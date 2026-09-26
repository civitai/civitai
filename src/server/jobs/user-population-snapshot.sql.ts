/**
 * Pure SQL builders for the user-population snapshot job. No imports, no client, no side
 * effects — which is what lets the tests assert the generated SQL without mocking ClickHouse.
 * Same split as src/server/metrics/appListing.metrics.sql.ts.
 *
 * The job that runs these is src/server/jobs/user-population-snapshot.ts; the tables, the
 * engine choice and the reasoning are in
 * src/server/clickhouse/migrations/2026-09-25-user-population-snapshot.sql.
 */

// How far back each run re-covers.
//
// THE RULE, so it survives a change to either number: a run at time T covers (T − LOOKBACK, T].
// Consecutive successes therefore UNION into contiguous coverage, and no gap opens while
//
//     (missed + 1) × period  ≤  LOOKBACK_HOURS
//
// At the current hourly period and 3 h lookback that is missed ≤ 2. The THIRD consecutive miss
// opens a gap, losing the oldest bucket silently and permanently — recoverable only by a manual
// backfill of the range, into a daily table that has no TTL.
//
// ⚠️ TWO IS A BOUNDARY, NOT A CUSHION. At exactly two misses the surviving runs' windows abut at
// a single instant, so ordinary scheduler jitter — or the ~3 s of `now()` drift across the seven
// serially-executed arms, each evaluating its own `now()` — can still drop rows there. Treat two
// as the point where loss BEGINS, not as slack to spend.
//
// 🔴 Do NOT copy the margin from user-activity-rollup.ts. Its comment reads "four consecutive
// missed runs still leave no gap (4 × 30 min < 3 h)" and that is true THERE because it runs every
// 30 minutes — the same rule above, at half the period, giving double the margin. Two earlier
// drafts of this comment got this wrong in different ways: the first restated the precedent's
// number without its cadence, and the second stated the right number from a derivation that does
// not produce it (it described a single run's window, which alone tolerates only ONE miss). The
// union across runs is the part that must not be dropped again.
export const LOOKBACK_HOURS = 3;

// How far back the daily roll-up re-derives on each run. Cheap — it reads the hourly table
// (a few thousand rows), not the raw sources — and re-deriving is idempotent, so the only
// reason not to make it larger is row churn before the background merge collapses it.
//
// 🔴 Bounded above by the hourly table's 90-day TTL: a day whose hourly rows have expired can
// never be rolled up, only re-derived from raw tables. 7 against 90 leaves ~83 days of margin.
// Do not raise this toward 90 or lower the TTL toward this without re-reading the other.
export const DAILY_ROLL_DAYS = 7;

const HOURLY_TABLE = 'default.user_population_hourly';
export const DAILY_TABLE = 'default.user_population_daily';

export const STATE_COLUMNS = [
  'views_state',
  'pageviews_state',
  'reactions_state',
  'useractivities_state',
  'generators_state',
  'buyers_state',
  'signups_state',
] as const;

export type StateColumn = (typeof STATE_COLUMNS)[number];

// `signups_state` is uniqExact, the rest uniqCombined — see the migration header. The
// combinator must match the column's declared AggregateFunction exactly or the INSERT is
// rejected, which is the loud failure we want rather than a silent coercion.
export const COMBINATOR: Record<StateColumn, 'uniqCombined' | 'uniqExact'> = {
  views_state: 'uniqCombined',
  pageviews_state: 'uniqCombined',
  reactions_state: 'uniqCombined',
  useractivities_state: 'uniqCombined',
  generators_state: 'uniqCombined',
  buyers_state: 'uniqCombined',
  signups_state: 'uniqExact',
};

export type Arm = {
  /** The one column this arm populates; the other six are written empty. */
  column: StateColumn;
  table: string;
  /** Int32 on every source — checked in `system.columns`, 2026-09-25. */
  idColumn: string;
  timeColumn: string;
  /**
   * Extra WHERE guards. 🔴 These are BYTE-IDENTICAL to the ones in the civitai-business-pulse
   * dashboard (panels 15/16/17/21, talos-infra). Any drift here makes the re-pointed panel
   * disagree with the historical numbers for a reason nobody will find by reading either side.
   */
  guards?: string;
};

export const ARMS: Arm[] = [
  // The four activity sources, kept separate so "viewers" (views alone, panel 21 stage 1) and
  // "active" (the union of all four) are both readable off the same rows.
  { column: 'views_state', table: 'default.views', idColumn: 'userId', timeColumn: 'time', guards: 'userId > 0' },
  { column: 'pageviews_state', table: 'default.pageViews', idColumn: 'userId', timeColumn: 'time', guards: 'userId > 0' },
  { column: 'reactions_state', table: 'default.reactions', idColumn: 'userId', timeColumn: 'time', guards: 'userId > 0' },
  {
    column: 'useractivities_state',
    table: 'default.userActivities',
    idColumn: 'userId',
    timeColumn: 'time',
    guards: 'userId > 0',
  },

  // `createdAt` here is DateTime64(3) — the only non-DateTime time column in the set. The
  // bucket expression casts explicitly rather than relying on toStartOfHour's return type.
  {
    column: 'generators_state',
    table: 'orchestration.jobs',
    idColumn: 'userId',
    timeColumn: 'createdAt',
    guards: `userId > 0
      AND match(jobType, '^[A-Za-z0-9_-]{2,40}$')
      AND cost BETWEEN 0 AND 1000000`,
  },

  // Buyers are counted by `toAccountId`, not `userId`, and the time column is `date`.
  {
    column: 'buyers_state',
    table: 'default.buzzTransactions',
    idColumn: 'toAccountId',
    timeColumn: 'date',
    guards: `type='purchase'
      AND fromAccountId=0
      AND description LIKE 'Purchase of %'`,
  },

  // The only arm that leaves ClickHouse — it reads production Postgres through the bridge.
  // Narrow here (a few hours of `createdAt`); the full-history backfill is the expensive one.
  { column: 'signups_state', table: 'civitai_pg.User', idColumn: 'id', timeColumn: 'createdAt' },
];

/** The seven state expressions for an arm: its own column populated, the rest empty. */
export function stateColumns(owned: StateColumn, idColumn: string) {
  return STATE_COLUMNS.map((column) => {
    const fn = COMBINATOR[column];
    return column === owned
      ? `${fn}State(${idColumn}) AS ${column}`
      : `${fn}StateIf(${idColumn}, 0) AS ${column}`;
  }).join(',\n      ');
}

export function hourlyInsertSql({ column, table, idColumn, timeColumn, guards }: Arm) {
  // 🔴 The `<= now()` is not redundant with the lookback. `orchestration.jobs` carries rows with
  // a `createdAt` as far out as 2299 (min/max measured 2026-09-25: 1900-01-01 .. 2299-12-31),
  // and a future-dated row passes a `> now() - INTERVAL n HOUR` filter. One such row would mint
  // a year-2299 bucket and stretch every panel's x-axis by three centuries.
  //
  // Measured the same day: with the guards above applied, orchestration.jobs has ZERO rows
  // outside 2022..now — 1,300,663,007 rows, 1,023 distinct days, all sane — because the junk
  // rows happen to fail `userId > 0` / the jobType regex / the cost bound. That is incidental,
  // not designed, so this bound is what actually pins the property. The other five sources
  // measured zero out-of-range rows too; the bound is uniform so no arm is the exception.
  const bucket = `toDateTime(toStartOfHour(${timeColumn}))`;
  return `
    INSERT INTO ${HOURLY_TABLE} (bucket, ${STATE_COLUMNS.join(', ')})
    SELECT
      ${bucket} AS bucket,
      ${stateColumns(column, idColumn)}
    FROM ${table}
    WHERE ${guards ? `${guards}\n      AND ` : ''}${timeColumn} > now() - INTERVAL ${LOOKBACK_HOURS} HOUR
      AND ${timeColumn} <= now()
    GROUP BY bucket
  `;
}

/**
 * Roll the hourly table down into the daily one. Merging states and re-emitting them as states
 * (`-MergeState`) is what keeps the daily table's columns the same AggregateFunction types as
 * the hourly table's, so both are read with the identical `-Merge` call.
 */
export function dailyRollSql() {
  const columns = STATE_COLUMNS.map(
    (column) => `${COMBINATOR[column]}MergeState(${column}) AS ${column}`
  ).join(',\n      ');
  return `
    INSERT INTO ${DAILY_TABLE} (day, ${STATE_COLUMNS.join(', ')})
    SELECT
      toDate(bucket) AS day,
      ${columns}
    FROM ${HOURLY_TABLE}
    WHERE bucket >= toStartOfDay(now() - INTERVAL ${DAILY_ROLL_DAYS} DAY)
    GROUP BY day
  `;
}
