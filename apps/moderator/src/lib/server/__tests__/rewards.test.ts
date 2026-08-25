import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `rewardReportReporters` writes a `pending` buzzEvents row by hand, bypassing the main app's
// `toClickhouseBuzzEvent`. Two defects followed from that (ClickUp 868kw9b31):
//
//   * `multiplier` was written unclamped against a Decimal(3, 2) column. Inserts run
//     `wait_for_async_insert: 0`, so ClickHouse accepts the request and drops the unparseable row
//     afterwards — no throw, and the `try/catch` in the writer cannot see it. `reportAccepted` is a
//     processable reward, so the dropped `pending` row IS the payment: the reporter is never paid.
//
//   * the cached `rewardsMultiplier` was truthiness-tested, so a rewards-ineligible user's
//     deliberate 0 fell through to 1 and they were paid in full — 868kw9kfk's bug in a second writer.
//
// Both are invisible at the insert boundary, so these tests assert the ROW handed to
// `clickhouse.insert`, not a return value or a call count.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  redisGet: vi.fn(async () => null as unknown),
  bonusEvents: [] as Array<{ multiplier: number; startsAt: Date | null; endsAt: Date | null }>,
}));

vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ insert: h.insert }) }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => ({ packed: { get: h.redisGet } }) }));
vi.mock('$lib/server/db', () => ({
  dbRead: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ execute: async () => h.bonusEvents }) }),
    }),
  },
  dbWrite: {},
}));

const { rewardReportReporters } = await import('../rewards');

const REPORTER = 55;

/** The single row handed to `clickhouse.insert` for the buzzEvents table. */
const insertedRow = () => {
  const call = h.insert.mock.calls.find((args: any[]) => args[0]?.table === 'buzzEvents') as
    | any[]
    | undefined;
  if (!call) throw new Error('no buzzEvents insert was attempted');
  return call[0].values[0];
};

/** A global bonus event as the table stores it: the multiplier is x10. */
const bonus = (times: number) => ({ multiplier: times * 10, startsAt: null, endsAt: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.bonusEvents = [];
  h.redisGet.mockResolvedValue(null);
});

describe('the multiplier written for an accepted report fits the column', () => {
  it('clamps a value past the Decimal(3, 2) ceiling instead of losing the row', async () => {
    // gold's 4x against the largest bonus the clamp allows, 5x, is 20 — against a ceiling of 9.99.
    h.redisGet.mockResolvedValue({ rewardsMultiplier: 4 });
    h.bonusEvents = [bonus(5)];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    const row = insertedRow();
    expect(row.multiplier).toBe(9.99);
    // The value we meant to write survives, so a clamped row is still traceable.
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: 20 });
  });

  it('leaves a multiplier the column can hold alone', async () => {
    // The positive control for the assertion above: without it, a writer that hard-coded 9.99, or
    // one that clamped everything, would pass the clamp test.
    h.redisGet.mockResolvedValue({ rewardsMultiplier: 4 });
    h.bonusEvents = [bonus(2)];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    const row = insertedRow();
    expect(row.multiplier).toBe(8);
    expect(row.transactionDetails).toBe('{}');
  });

  it('is the highest value in play today, so the ceiling is not reachable yet', async () => {
    // Measured on prod 2026-08-25: max Product rewardsMultiplier 4, the one active bonus event 2.0x.
    // 4 x 2.0 = 8.00 against 9.99, so this is latent — it tips above a 2.4975x bonus.
    h.redisGet.mockResolvedValue({ rewardsMultiplier: 4 });
    h.bonusEvents = [bonus(2.5)];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    expect(insertedRow().multiplier).toBe(9.99);
  });
});

describe('a rewards-ineligible reporter is not paid', () => {
  it('writes the cached 0 rather than reading it as a missing value', async () => {
    // `foldUserMultipliers` sets 0 for an Ineligible user. A truthiness check here turned that into
    // 1 and the main app's process() guard — which keys on the multiplier being 0 — never fired.
    h.redisGet.mockResolvedValue({ rewardsMultiplier: 0 });
    h.bonusEvents = [bonus(2)];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    expect(insertedRow().multiplier).toBe(0);
  });

  it('still writes a real multiplier for an eligible reporter', async () => {
    // The control for the 0 above: proves the harness is not simply producing 0 for everything.
    h.redisGet.mockResolvedValue({ rewardsMultiplier: 1.5 });
    h.bonusEvents = [bonus(2)];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    expect(insertedRow().multiplier).toBe(3);
  });

  it('falls back to 1 when the cache says nothing about the user', async () => {
    // A miss is not an eligibility signal, and this path must NOT be confused with the 0 above.
    h.redisGet.mockResolvedValue({ notFound: true });
    h.bonusEvents = [];

    await rewardReportReporters({ reportId: 1, reporterIds: [REPORTER] });

    expect(insertedRow().multiplier).toBe(1);
  });
});
