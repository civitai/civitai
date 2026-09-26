import { describe, expect, it } from 'vitest';

import type { Arm } from '~/server/jobs/user-population-snapshot.sql';
import {
  ARMS,
  COMBINATOR,
  STATE_COLUMNS,
  dailyRollSql,
  hourlyInsertSql,
} from '~/server/jobs/user-population-snapshot.sql';

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
  it('buyers carry panel 21 stage-3 guards verbatim and count toAccountId', () => {
    const arm = armFor('buyers_state');
    expect(arm.table).toBe('default.buzzTransactions');
    expect(arm.idColumn).toBe('toAccountId');
    expect(arm.timeColumn).toBe('date');
    expect(norm(arm.guards ?? '')).toBe(
      "type = 'purchase' AND fromAccountId = 0 AND description LIKE 'Purchase of %'"
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
    expect(ARMS.map((a) => a.column).sort()).toEqual([...STATE_COLUMNS].sort());
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
      expect(sql).toContain(`${arm.timeColumn} > now() - INTERVAL 3 HOUR`);
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
