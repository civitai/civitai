import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Buzz dashboard chart must not draw cash-outs.
 *
 * A cash-out is a debit like any other, so it landed in the same `spent` series as a generation:
 * at creator volume one bar was thousands of times the next and every other bar rendered under a
 * pixel. Measured across the 89 creators who cashed out in a 30-day window, tallest bar over median
 * day falls 39.5x -> 4.1x once `bank` and `withdrawal` are out.
 *
 * Two types reach a creator's chart, on opposite sides: `bank` debits yellow/green (the Spent bar,
 * 2,174 rows / 180d, max 10,477,563) and `extract` credits them back out of the program bank (the
 * GAINED bar, 79 rows / 180d, max 500,000). `withdrawal` credits account 0 rather than a creator and
 * reaches neither today; it debited yellow until 2025-02-27 and is kept for that.
 */

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as BuzzClient from '@civitai/buzz';

const { $query, getUserTransactionsReport } = vi.hoisted(() => ({
  $query: vi.fn(),
  getUserTransactionsReport: vi.fn(),
}));

// Spread the real package and override only the client factory, so this file is not coupled to every
// export buzz.service happens to import from it.
vi.mock('@civitai/buzz', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzClient>()),
  createBuzzClient: () => ({ getUserTransactionsReport }),
}));

// Spread the real module and override only the client. It re-exports the package surface plus the
// app Tracker, and a hand-listed mock would couple this file to all of it.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query },
}));

import { getTransactionsReport } from '~/server/services/buzz.service';

const USER = 1557068;

// Fixed so the bucket sequence is a known length rather than whatever day the suite runs on.
const NOW = new Date('2026-08-31T18:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  $query.mockReset();
  $query.mockResolvedValue([]);
  getUserTransactionsReport.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const sqlOf = () => String($query.mock.calls[0][0]);

// The two halves of the UNION, separated so an assertion can name which branch it is about.
const branches = (sql: string) => {
  const [gained, spent] = sql.split('UNION ALL');
  return { gained, spent };
};

describe('getTransactionsReport', () => {
  // 🔴 BOTH branches, deliberately, and the gained one is not redundant: `extract` credits yellow or
  // green out of the creator program bank, so a cash-out returning reaches the chart through GAINED
  // and no other filter would remove it. The first version of this fix guarded only the spend branch
  // and its worked example was July 2024, when a cash-out still debited yellow — the control passed
  // over a live case it could not see. If you are here to drop the gained-branch filter, check
  // `extract`'s direction in production first.
  it('excludes cash-out plumbing from the spent series', async () => {
    await getTransactionsReport({ userId: USER, window: 'day', accountType: 'yellow' });

    // The whole predicate, operator included: an assertion on the type names alone passes just as
    // well against `type IN (...)`, which would draw ONLY cash-outs.
    expect(branches(sqlOf()).spent).toContain("AND type NOT IN ('bank','withdrawal','extract')");
  });

  it('excludes cash-out plumbing from the gained series too', async () => {
    await getTransactionsReport({ userId: USER, window: 'day', accountType: 'yellow' });

    expect(branches(sqlOf()).gained).toContain("AND type NOT IN ('bank','withdrawal','extract')");
  });

  it('scopes both branches to the requested account and account type', async () => {
    await getTransactionsReport({ userId: USER, window: 'day', accountType: 'green' });

    const { gained, spent } = branches(sqlOf());
    expect(gained).toContain(`toAccountId = ${USER}`);
    expect(gained).toContain("toAccountType = 'green'");
    expect(spent).toContain(`fromAccountId = ${USER}`);
    expect(spent).toContain("fromAccountType = 'green'");
  });

  it('emits every bucket in the window, including the ones with no rows', async () => {
    // Two real days out of the eight the `day` window covers (7 days back through today).
    $query.mockResolvedValue([
      { bucket: '2026-08-26', gained: '2115', spent: '1075' },
      { bucket: '2026-08-31', gained: '1977', spent: '0' },
    ]);

    const report = await getTransactionsReport({
      userId: USER,
      window: 'day',
      accountType: 'yellow',
    });

    expect(report).toHaveLength(8);
    expect(report.map((bucket) => bucket.date.slice(0, 10))).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
    ]);
    // The two populated days land on their own buckets, not on the first or on a neighbour.
    expect(report[2].accounts[0]).toEqual({ accountType: 'yellow', gained: 2115, spent: 1075 });
    expect(report[7].accounts[0]).toEqual({ accountType: 'yellow', gained: 1977, spent: 0 });
    // And the quiet days are present and flat rather than missing.
    expect(report[3].accounts[0]).toEqual({ accountType: 'yellow', gained: 0, spent: 0 });
  });

  it('returns a flat chart, not an empty one, for an account with no activity', async () => {
    $query.mockResolvedValue([]);

    const report = await getTransactionsReport({
      userId: USER,
      window: 'day',
      accountType: 'yellow',
    });

    expect(report).toHaveLength(8);
    expect(report.every((bucket) => bucket.accounts[0].gained === 0)).toBe(true);
    expect(report.every((bucket) => bucket.accounts[0].spent === 0)).toBe(true);
  });

  // The chart keys each dataset by a `MMM-DD` label, so two buckets that format alike overwrite each
  // other. A year-back start spans thirteen months and both ends render as `Aug-01`.
  it('emits twelve month buckets, not thirteen', async () => {
    const report = await getTransactionsReport({
      userId: USER,
      window: 'month',
      accountType: 'yellow',
    });

    expect(report).toHaveLength(12);
    expect(report[0].date.slice(0, 7)).toBe('2025-09');
    expect(report[11].date.slice(0, 7)).toBe('2026-08');
    // The label the chart actually keys on has to be unique across the window.
    const labels = report.map((bucket) => bucket.date.slice(5, 10));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('falls back to the buzz service when the ClickHouse query fails', async () => {
    $query.mockRejectedValue(new Error('clickhouse is down'));
    getUserTransactionsReport.mockResolvedValue([
      {
        date: '2026-08-31T00:00:00',
        start: '2026-08-31T00:00:00',
        end: '2026-09-01T00:00:00',
        accounts: [{ accountType: 'User', spent: 10, gained: 20 }],
      },
    ]);

    const report = await getTransactionsReport({
      userId: USER,
      window: 'day',
      accountType: 'yellow',
    });

    // Degrades to the chart's previous behaviour — which draws the cash-out — rather than to an empty
    // result, which the client renders as "no data on the provided timeframe" over real activity.
    expect(getUserTransactionsReport).toHaveBeenCalledOnce();
    expect(report).toHaveLength(1);
    // Both fields the chart keys on, not just the value: it looks the bucket up by a formatted `date`
    // and picks the account by `accountType`, so a fallback returning either in an unexpected shape
    // draws every bar at zero while an assertion on `gained` alone stays green.
    //
    // The format, not the instant. This path runs the buzz service's payload through
    // `getTransactionsReportResultSchema`, whose `z.coerce.date()` reads a bare timestamp as LOCAL and
    // then formats it as UTC — so the value shifts by the host's offset (nothing on a UTC server, six
    // hours on the box this was written on). Pre-existing on this path; pinning the literal would make
    // the test fail by timezone rather than by defect.
    expect(report[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(report[0].accounts[0]).toEqual({ accountType: 'yellow', spent: 10, gained: 20 });
  });

  it('maps a non-yellow account type through the fallback', async () => {
    $query.mockRejectedValue(new Error('clickhouse is down'));
    getUserTransactionsReport.mockResolvedValue([
      {
        date: '2026-08-31T00:00:00',
        start: '2026-08-31T00:00:00',
        end: '2026-09-01T00:00:00',
        accounts: [{ accountType: 'Green', spent: 0, gained: 5 }],
      },
    ]);

    const report = await getTransactionsReport({
      userId: USER,
      window: 'day',
      accountType: 'green',
    });

    expect(report[0].accounts[0].accountType).toBe('green');
  });

  it('surfaces a handled error when the fallback fails too', async () => {
    $query.mockRejectedValue(new Error('clickhouse is down'));
    getUserTransactionsReport.mockRejectedValue(new Error('buzz service is down'));

    await expect(
      getTransactionsReport({ userId: USER, window: 'day', accountType: 'yellow' })
    ).rejects.toThrow('Could not load the Buzz report right now. Please try again shortly.');
  });

  it('buckets weeks on Monday, matching ClickHouse toMonday', async () => {
    // 2026-08-31 is a Monday; the `week` window reaches back five whole weeks.
    $query.mockResolvedValue([{ bucket: '2026-08-31', gained: '500', spent: '0' }]);

    const report = await getTransactionsReport({
      userId: USER,
      window: 'week',
      accountType: 'yellow',
    });

    expect(sqlOf()).toContain('toMonday(date)');
    // Six, the same span a calendar `subtract(1, 'month')` covered before the sequence was rewritten.
    // Nothing else pins the week window's length, and it lost a period once already.
    expect(report).toHaveLength(6);
    expect(report[0].date.slice(0, 10)).toBe('2026-07-27');
    const last = report[report.length - 1];
    expect(last.date.slice(0, 10)).toBe('2026-08-31');
    expect(last.accounts[0].gained).toBe(500);
    // Every bucket boundary is a Monday, so a locale-Sunday sequence would fail here rather than
    // silently keying off by a day and reporting every bucket as zero.
    expect(report.every((bucket) => new Date(`${bucket.date}Z`).getUTCDay() === 1)).toBe(true);
  });
});
