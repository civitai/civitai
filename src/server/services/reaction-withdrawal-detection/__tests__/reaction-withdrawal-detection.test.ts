import { describe, expect, it, vi } from 'vitest';
import type { AbuseReportInput } from '@civitai/moderation';
import { abuseReportInput, MAX_FINDINGS_PER_REPORT } from '@civitai/moderation';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.user.findMany.mockImplementation(async () => dbUsers.rows);

/**
 * Two properties here fail silently, and both fail in the direction of a moderator trusting a page
 * that is wrong.
 *
 * A finding that omits the numbers the rule used renders as a bare accusation the reviewer cannot
 * check. And `actioned: true` on any row of a detector that holds no write client would claim to a
 * moderator that an account had already been dealt with.
 */

const dbUsers = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { runReactionWithdrawalDetection } = await import('../run');
const { describeAccounts, findWithdrawalCandidates } = await import('../detect');
const { confidenceFor, renderReason, toFinding, truncateReason } = await import('../report');

const account = {
  userId: 7,
  cycles: 1_204,
  given: 1_210,
  creators: 88,
  username: 'u7',
  createdAt: new Date('2026-08-28T00:00:00Z'),
  ageDays: 12,
  instantVerify: true,
};

const chReturning = (rows: unknown[]) => ({
  queries: [] as string[],
  $query<T extends object>(sql: string) {
    this.queries.push(sql);
    return Promise.resolve(rows as T[]);
  },
});

describe('findWithdrawalCandidates', () => {
  it('pairs a create with its withdrawal inside the query, bounded by the window', async () => {
    const ch = chReturning([]);
    await findWithdrawalCandidates(ch);

    const q = ch.queries[0];
    // 🔴 The revert: dropping the pairing and counting bare `Image_Delete` rows. That counts a
    // reaction removed a week later — an ordinary change of mind, median 15-29 HOURS on real images —
    // as the same event as one removed in under a second, and the detector loses its whole basis.
    expect(q).toContain("dateDiff('second'");
    expect(q).toContain('secs <= 60');
    // 🔴 Without the lower bound the arithmetic runs backwards at the window edge — a reaction given
    // before the window and withdrawn inside it has no create to pair against, so `secs` is negative
    // and passes `<= 60`. Measured: 162,496 of 725,440 selected rows, a 22% over-count, every one of
    // them a reaction held for weeks — the opposite of what this detector is looking for.
    expect(q).toContain('secs >= 0');
    expect(q).toContain("countIf(type = 'Image_Create') > 0");
    expect(q).toContain("countIf(type = 'Image_Delete') > 0");
    // Unbounded, this reads the whole 844M-row table.
    expect(q).toMatch(/time >= now\(\) - INTERVAL 7 DAY/);
    expect(q).toContain('HAVING cycles >= 10');
  });

  it('does not cap the candidate list anywhere near the number of rows that reach the board', async () => {
    const ch = chReturning([]);
    await findWithdrawalCandidates(ch);

    // 🔴 The ban and age filters run in POSTGRES, after this. Ordered by volume, the head of this
    // list is the accounts that have been at it longest — the ones already banned. Measured
    // 2026-09-09: the top 1,000 by cycles held 9 of the 98 live accounts, so a `LIMIT 1000` here
    // hides 91% of the queue while reporting a healthy-looking 1,000 candidates scanned. Nothing
    // downstream can notice: the report is well-formed and the counters are self-consistent.
    const limit = Number(ch.queries[0].match(/LIMIT\s+(\d+)\s*$/m)?.[1]);
    expect(limit).toBeGreaterThanOrEqual(20 * MAX_FINDINGS_PER_REPORT);
  });
});

describe('describeAccounts', () => {
  it('drops accounts that are already banned, deleted, or over the age limit', async () => {
    dbUsers.rows = [];
    const db = await import('~/server/db/client');

    await describeAccounts([{ userId: 7, cycles: 20, given: 25, creators: 5 }], {
      now: new Date('2026-09-09T00:00:00Z'),
    });

    // 🔴 Asserted on the WHERE, not on the returned rows: the mock answers with whatever it is given
    // regardless of the filter, so a result-only assertion stays green through the filter being
    // deleted. Dropping it would report the ~8,400 already-banned accounts the rule also selects and
    // bury the ~77 live ones under a week of work someone already did.
    const where = vi.mocked(db.dbRead.user.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ bannedAt: null, deletedAt: null });
    expect(where?.createdAt).toHaveProperty('gte');
  });

  it('does not invent an account for a candidate Postgres has no row for', async () => {
    dbUsers.rows = [
      { id: 7, username: 'u7', createdAt: new Date('2026-09-01T00:00:00Z'), emailVerified: null },
    ];

    const out = await describeAccounts(
      [
        { userId: 7, cycles: 20, given: 25, creators: 5 },
        { userId: 8, cycles: 99, given: 99, creators: 1 },
      ],
      { now: new Date('2026-09-09T00:00:00Z') }
    );

    expect(out.map((a) => a.userId)).toEqual([7]);
    expect(out[0].ageDays).toBe(8);
    // Null, not false: no verification timestamp is unknown, and rendering it as "not instant" would
    // state something the database never said.
    expect(out[0].instantVerify).toBeNull();
  });
});

describe('the finding a moderator reads', () => {
  it('states every number the rule used, with its denominator', () => {
    const reason = renderReason(account);

    // The count alone is not checkable. The share is what separates a machine from a heavy user with
    // a flaky client, and both clear the volume threshold.
    expect(reason).toContain('1,204');
    expect(reason).toContain('1,210');
    expect(reason).toContain('99%');
    expect(reason).toContain('88 creators');
    expect(reason).toContain('12 day(s) old');
    expect(reason).toContain('98.9%');
  });

  it('never claims an action, because this detector cannot take one', () => {
    const finding = toFinding(account);

    // 🔴 `actioned: true` here would tell a moderator the account had already been dealt with, by a
    // job that holds no write client and no enforcement service.
    expect(finding.actioned).toBe(false);
    expect(finding.action).toBeUndefined();
  });

  it('orders the queue by evidence strength, within a band', () => {
    const weak = confidenceFor({ ...account, cycles: 10, given: 4_000 });
    const strong = confidenceFor(account);

    expect(strong).toBeGreaterThan(weak);
    // The board sorts on this column, so it has to vary — but it is not a probability and the band is
    // deliberately narrow. Widening it would invite reading the spread as meaning.
    expect(weak).toBeGreaterThanOrEqual(0.9);
    expect(strong).toBeLessThanOrEqual(0.99);
  });

  it('truncates a reason rather than losing the whole report', () => {
    // 🔴 One over-long reason 400s the REPORT, not the row — every finding in the batch is lost.
    expect(truncateReason('x'.repeat(2_500))).toHaveLength(2_000);
    expect(truncateReason('short')).toBe('short');
  });
});

describe('runReactionWithdrawalDetection', () => {
  it('files nothing when ClickHouse is unavailable, rather than an empty run', async () => {
    const sendReport = vi.fn(async () => undefined);

    const result = await runReactionWithdrawalDetection({
      ch: null,
      sendReport,
      now: () => new Date('2026-09-09T09:00:00Z'),
    });

    // 🔴 An empty run row reads as "we looked and found nobody" — the opposite of "we could not
    // look". On a board whose whole claim is how current its detectors are, that is the one report
    // that must not be filed.
    expect(sendReport).not.toHaveBeenCalled();
    expect(result.skipped).toBe('clickhouse-unavailable');
  });

  it('emits a report the shared contract accepts', async () => {
    dbUsers.rows = [
      { id: 7, username: 'u7', createdAt: new Date('2026-08-28T00:00:00Z'), emailVerified: null },
    ];
    let sent: AbuseReportInput | undefined;

    await runReactionWithdrawalDetection({
      ch: chReturning([{ userId: '7', cycles: '1204', given: '1210', creators: '88' }]),
      sendReport: async (r) => {
        sent = r;
        return undefined;
      },
      now: () => new Date('2026-09-09T09:00:00Z'),
    });

    // The contract is enforced at the spoke, so a shape error surfaces as a 400 in production and a
    // lost run. Parsing it here is the only place that failure is cheap.
    expect(() => abuseReportInput.parse(sent)).not.toThrow();
    expect(sent?.detector).toBe('reaction-withdrawal');
    expect(sent?.counters).toMatchObject({ matched_pattern: 1, live_accounts: 1 });
  });
});
