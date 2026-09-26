import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Arm } from '~/server/jobs/user-population-snapshot.sql';
import {
  ARMS,
  COMBINATOR,
  DAILY_ROLL_DAYS,
  DAILY_TABLE,
  LOOKBACK_HOURS,
  STATE_COLUMNS,
  dailyRollSql,
  hourlyInsertSql,
} from '~/server/jobs/user-population-snapshot.sql';

/**
 * The hourly table's TTL, READ OUT OF THE MIGRATION rather than restated here.
 *
 * 🔴 An earlier version of this was a literal `90` with a comment claiming it made "shrinking the
 * TTL toward the lookback a failure rather than a surprise". It did not: an audit changed the DDL
 * to `INTERVAL 10 DAY` and the suite stayed fully GREEN, because nothing connected the constant
 * to the file it claimed to track. A guard whose description claims coverage it does not provide
 * is worse than none — it stops the next person looking.
 *
 * Parsing the DDL text is what makes the coupling real. Note it matches the SOURCE spelling
 * `INTERVAL 90 DAY`; ClickHouse normalises that to `toIntervalDay(90)` once applied, so a check
 * written against a LIVE `create_table_query` needs the other pattern (see the migration's own
 * warning about exactly that trap).
 */
const MIGRATION_PATH = join(
  __dirname,
  '../../clickhouse/migrations/2026-09-25-user-population-snapshot.sql'
);

function hourlyTtlDaysFromMigration(): number {
  const ddl = readFileSync(MIGRATION_PATH, 'utf8');
  const match = ddl.match(/TTL bucket \+ INTERVAL (\d+) DAY/);
  if (!match) throw new Error(`no hourly TTL found in ${MIGRATION_PATH}`);
  return Number(match[1]);
}

const HOURLY_TTL_DAYS = hourlyTtlDaysFromMigration();

/**
 * These tests exist for ONE failure mode that no type and no ClickHouse error can catch: the
 * snapshot's filters drifting away from the dashboard panels they replace. If that happens the
 * new panels keep working and keep rendering plausible numbers that quietly disagree with the
 * historical ones, and there is nothing to find by reading either side alone.
 *
 * So the expectations below are NOT derived from the implementation. They are transcribed from
 * the live dashboard SQL —
 * talos-infra clusters/production/apps/prometheus-stack/grafana-dashboards/civitai-business-pulse.json,
 * panels 15/16/17 (generators) and 21 (the viewers → generators → buyers funnel), read
 * 2026-09-25. If a panel's definition legitimately changes, change it HERE first, then make the
 * builder match.
 */

/** Collapse whitespace so a re-indent is not a test failure, but a reworded guard is. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function armFor(column: string) {
  const arm = ARMS.find((a: Arm) => a.column === column);
  if (!arm) throw new Error(`no arm for ${column}`);
  return arm;
}

describe('user-population snapshot — guards match the dashboard panels', () => {
  // Transcribed from panel 21 stage 2 / panels 15, 16, 17 — all four carry this identical trio.
  it('generators carry panel 21/15/16/17 three guards verbatim', () => {
    const arm = armFor('generators_state');
    expect(arm.table).toBe('orchestration.jobs');
    expect(arm.idColumn).toBe('userId');
    expect(arm.timeColumn).toBe('createdAt');
    expect(norm(arm.guards ?? '')).toBe(
      "userId > 0 AND match(jobType, '^[A-Za-z0-9_-]{2,40}$') AND cost BETWEEN 0 AND 1000000"
    );
  });

  // Transcribed from panel 21 stage 3. Note it counts `toAccountId`, NOT `userId` — getting
  // that wrong would count the SENDER of every purchase, which is account 0, i.e. one "buyer".
  //
  // 🔴 The spacing is the POINT, not an accident. An earlier version of this assertion read
  // `type = 'purchase' AND fromAccountId = 0` — the IMPLEMENTATION's spacing — while the docblock
  // above claimed the expectations were transcribed from the dashboard. The live panel writes
  // `type='purchase' AND fromAccountId=0` with no spaces around `=`. Same semantics, so no number
  // moved; but the guard was then a spelled string with no provenance, and the drift it exists to
  // catch (someone edits the panel) would have left it green. Byte-identical means byte-identical.
  it('buyers carry panel 21 stage-3 guards verbatim and count toAccountId', () => {
    const arm = armFor('buyers_state');
    expect(arm.table).toBe('default.buzzTransactions');
    expect(arm.idColumn).toBe('toAccountId');
    expect(arm.timeColumn).toBe('date');
    expect(norm(arm.guards ?? '')).toBe(
      "type='purchase' AND fromAccountId=0 AND description LIKE 'Purchase of %'"
    );
  });

  // Transcribed from panel 21 stage 1 — "Logged-in viewers" is `default.views` ALONE.
  it('viewers are default.views alone, not the activity union', () => {
    const arm = armFor('views_state');
    expect(arm.table).toBe('default.views');
    expect(arm.idColumn).toBe('userId');
    expect(arm.timeColumn).toBe('time');
    expect(norm(arm.guards ?? '')).toBe('userId > 0');
  });
});

/**
 * 🔴 EVERY ARM'S FULL SPEC, pinned as one table.
 *
 * Why this exists: the guard tests above covered viewers, generators and buyers only — 3 of 7
 * arms — and the per-arm loops further down read each arm's OWN `idColumn`/`timeColumn`, so they
 * are self-referential and cannot notice a wrong field. An independent mutation sweep found ten
 * mutants surviving the whole green suite, and they were not exotic; they are the ordinary edits
 * someone makes to this file next:
 *   - the pageViews arm losing `userId > 0` (admits the entire anonymous population — `userId`
 *     is `Int32 default 0` in every source table — into a column the documented DAU union reads)
 *   - the reactions or signups arm pointed at the wrong TABLE
 *   - the signups arm counting `userId` instead of `id`
 *   - the userActivities arm bucketing on `createdDate` instead of `time` (a materialized `Date`,
 *     so every row buckets to midnight and the 3 h window returns almost nothing — one of the
 *     four DAU sources silently zeroed)
 * A per-arm ledger kills all of them, and it fails when an arm is ADDED, REMOVED or RETARGETED.
 * Keep it transcribed from the dashboard and the measured column types, never from ARMS itself.
 */
const EXPECTED_ARMS: Record<string, { table: string; idColumn: string; timeColumn: string; guards: string }> = {
  views_state: {
    table: 'default.views',
    idColumn: 'userId',
    timeColumn: 'time',
    guards: 'userId > 0',
  },
  pageviews_state: {
    table: 'default.pageViews',
    idColumn: 'userId',
    timeColumn: 'time',
    guards: 'userId > 0',
  },
  reactions_state: {
    table: 'default.reactions',
    idColumn: 'userId',
    timeColumn: 'time',
    guards: 'userId > 0',
  },
  useractivities_state: {
    table: 'default.userActivities',
    idColumn: 'userId',
    // `time`, NOT `createdDate`. userActivities partitions by toYear(createdDate) and that
    // column is a materialized Date, so bucketing on it collapses every row to midnight.
    timeColumn: 'time',
    guards: 'userId > 0',
  },
  generators_state: {
    table: 'orchestration.jobs',
    idColumn: 'userId',
    // DateTime64(3) — the only non-DateTime time column in the set.
    timeColumn: 'createdAt',
    guards: "userId > 0 AND match(jobType, '^[A-Za-z0-9_-]{2,40}$') AND cost BETWEEN 0 AND 1000000",
  },
  buyers_state: {
    table: 'default.buzzTransactions',
    // `toAccountId`, NOT `userId` — the sender of every purchase is account 0, so counting
    // `userId` here would report exactly one buyer, forever.
    idColumn: 'toAccountId',
    timeColumn: 'date',
    guards: "type='purchase' AND fromAccountId=0 AND description LIKE 'Purchase of %'",
  },
  signups_state: {
    table: 'civitai_pg.User',
    idColumn: 'id',
    timeColumn: 'createdAt',
    guards: '',
  },
};

describe('user-population snapshot — every arm is fully pinned', () => {
  it('pins exactly the arms that exist, no more and no fewer', () => {
    expect(ARMS.map((a: Arm) => a.column).sort()).toEqual(Object.keys(EXPECTED_ARMS).sort());
  });

  for (const [column, expected] of Object.entries(EXPECTED_ARMS)) {
    it(`${column}: table, id column, time column and guards`, () => {
      const arm = armFor(column);
      expect(arm.table).toBe(expected.table);
      expect(arm.idColumn).toBe(expected.idColumn);
      expect(arm.timeColumn).toBe(expected.timeColumn);
      expect(norm(arm.guards ?? '')).toBe(expected.guards);
    });
  }

  it('no two arms read the same table — a duplicated source double-counts one population', () => {
    const tables = ARMS.map((a: Arm) => a.table);
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe('user-population snapshot — the column ledger', () => {
  /**
   * A ledger, not a count: this fails when a column is ADDED, REMOVED or RENAMED. Both
   * directions matter — a silently dropped column makes a panel read zero, and a silently
   * added one is a column the migration never created, so every INSERT starts failing.
   */
  it('is exactly the seven columns the migration creates', () => {
    expect([...STATE_COLUMNS]).toEqual([
      'views_state',
      'pageviews_state',
      'reactions_state',
      'useractivities_state',
      'generators_state',
      'buyers_state',
      'signups_state',
    ]);
  });

  it('has exactly one arm per column, and no orphan arms', () => {
    expect(ARMS.map((a: Arm) => a.column).sort()).toEqual([...STATE_COLUMNS].sort());
  });

  /**
   * The combinator must match the column's declared AggregateFunction or ClickHouse rejects
   * the INSERT. `signups_state` is the deliberate exception — uniqExact, for exact signup
   * figures at low cardinality. Pinned so that "make it consistent" is a test failure and
   * not a silent accuracy change to a number people quote.
   */
  it('uses uniqExact for signups and uniqCombined for everything else', () => {
    expect(COMBINATOR).toEqual({
      views_state: 'uniqCombined',
      pageviews_state: 'uniqCombined',
      reactions_state: 'uniqCombined',
      useractivities_state: 'uniqCombined',
      generators_state: 'uniqCombined',
      buyers_state: 'uniqCombined',
      signups_state: 'uniqExact',
    });
  });
});

describe('user-population snapshot — generated SQL shape', () => {
  for (const arm of ARMS) {
    const column = arm.column;
    it(`${column} writes all seven columns: its own populated, the other six empty`, () => {
      const sql = hourlyInsertSql(arm);
      for (const other of STATE_COLUMNS) {
        const fn = COMBINATOR[other];
        const expected =
          other === column
            ? `${fn}State(${arm.idColumn}) AS ${other}`
            : `${fn}StateIf(${arm.idColumn}, 0) AS ${other}`;
        expect(norm(sql)).toContain(expected);
      }
      // Exactly one populated state — a second would mean an arm claiming a column it does
      // not own, double-counting that population by however many arms claim it.
      const populated = [...norm(sql).matchAll(/uniq(?:Combined|Exact)State\(/g)];
      expect(populated).toHaveLength(1);
    });
  }

  /**
   * 🔴 The upper bound is the sentinel guard, and it is load-bearing in a way that reads as
   * redundant. `orchestration.jobs` carries rows dated as far out as 2299-12-31 (measured
   * 2026-09-25), and a future-dated row PASSES a `> now() - INTERVAL n HOUR` filter — it would
   * mint a year-2299 bucket and stretch every panel's x-axis by three centuries. Measured the
   * same day, the panel guards happen to exclude every such row today, which is incidental
   * rather than designed; this bound is what actually pins the property.
   */
  for (const arm of ARMS) {
    it(`${arm.column} bounds the window at both ends, including the future`, () => {
      const sql = norm(hourlyInsertSql(arm));
      expect(LOOKBACK_HOURS).toBe(3);
      expect(sql).toContain(`${arm.timeColumn} > now() - INTERVAL ${LOOKBACK_HOURS} HOUR`);
      expect(sql).toContain(`${arm.timeColumn} <= now()`);
    });
  }

  for (const arm of ARMS) {
    it(`${arm.column} buckets by hour with an explicit DateTime cast`, () => {
      // The cast is only strictly needed for orchestration.jobs' DateTime64(3), but it is
      // uniform so that no arm is the exception nobody remembers to check.
      expect(norm(hourlyInsertSql(arm))).toContain(
        `toDateTime(toStartOfHour(${arm.timeColumn})) AS bucket`
      );
    });
  }

  /**
   * 🔴 The daily roll's TARGET and WINDOW were both unpinned, and each survived a mutation.
   * Writing `${HOURLY_TABLE}` instead of `${DAILY_TABLE}` is TYPE-VALID, so ClickHouse accepts
   * it: midnight rows go back into the hourly table, the next roll re-reads them, and the daily
   * table — the forever history — silently freezes. And `DAILY_ROLL_DAYS` carries a 🔴 coupling
   * warning against the 90-day TTL on the line above its declaration while nothing asserted it,
   * so 7 → 700 passed a green suite.
   */
  it('daily roll writes the DAILY table, bounded by DAILY_ROLL_DAYS', () => {
    const sql = norm(dailyRollSql());
    expect(DAILY_ROLL_DAYS).toBe(7);
    expect(sql).toContain(`INSERT INTO ${DAILY_TABLE}`);
    expect(sql).not.toContain('INSERT INTO default.user_population_hourly');
    expect(sql).toContain('FROM default.user_population_hourly');
    expect(sql).toContain(`WHERE bucket >= toStartOfDay(now() - INTERVAL ${DAILY_ROLL_DAYS} DAY)`);
    // The roll must stay well inside the hourly TTL: a day whose hourly rows have expired can
    // never be rolled up, only re-derived from raw. HOURLY_TTL_DAYS is parsed from the migration,
    // so shrinking the TTL there fails HERE — verified by mutation: 90 → 10 DAY in the DDL turns
    // this suite red, where the literal it replaced stayed green.
    expect(HOURLY_TTL_DAYS).toBe(90);
    // ⚠️ Honest about what this last line is: DOCUMENTATION, not an independent guard. Both of
    // its operands are pinned by exact assertions above, so it can never be the FIRST to fail —
    // any change to either constant trips that constant's own pin. It states the relationship
    // for a reader and would catch a case where both pins were updated together but incoherently.
    // Do not cite it as coverage of the coupling; the parsed TTL above is what provides that.
    expect(DAILY_ROLL_DAYS).toBeLessThan(HOURLY_TTL_DAYS / 2);
  });

  it('every INSERT names its columns explicitly — position is not the contract', () => {
    // ClickHouse matches INSERT ... SELECT by POSITION, and six of the seven state columns are
    // type-identical, so any permutation among them is accepted and silently wrong. The `AS`
    // aliases are inert for INSERT ... SELECT; only an explicit column list binds by name.
    const list = `(bucket, ${STATE_COLUMNS.join(', ')})`;
    for (const arm of ARMS) {
      expect(norm(hourlyInsertSql(arm))).toContain(norm(`INSERT INTO default.user_population_hourly ${list}`));
    }
    expect(norm(dailyRollSql())).toContain(
      norm(`INSERT INTO ${DAILY_TABLE} (day, ${STATE_COLUMNS.join(', ')})`)
    );
  });

  it('daily roll re-emits every column as a state, with the matching combinator', () => {
    const sql = norm(dailyRollSql());
    for (const column of STATE_COLUMNS) {
      expect(sql).toContain(`${COMBINATOR[column]}MergeState(${column}) AS ${column}`);
    }
    // Merge-and-re-emit, never a bare merge: a plain `-Merge` here would write a NUMBER into
    // an AggregateFunction column, which is the one way to break the daily table's readers
    // while the insert still looks right.
    expect(sql).not.toMatch(/uniq(?:Combined|Exact)Merge\((?!State)/);
    expect(sql).toContain('toDate(bucket) AS day');
  });
});
