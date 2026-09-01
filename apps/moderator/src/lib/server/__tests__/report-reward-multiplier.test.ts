import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `rewardReportReporters` writes the `pending` buzzEvents row that IS the payout: the main app's
 * process-rewards cron reads the multiplier back out of it and pays awardAmount * multiplier. So
 * every value asserted here is money, and a row ClickHouse cannot parse is dropped server-side
 * under async_insert with the app seeing success — the reporter is silently never paid.
 */

const insert = vi.fn().mockResolvedValue(undefined);
const redisGet = vi.fn();
const bonusEvents = vi.fn();
const ineligibleRows = vi.fn();
const logToAxiom = vi.fn().mockResolvedValue(undefined);

vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
vi.mock('../redis', () => ({ getRedis: () => ({ packed: { get: redisGet } }) }));
vi.mock('../axiom', () => ({ logToAxiom }));
/**
 * The two chains this module builds are told apart by table, not by shape: `RewardsBonusEvent` ends
 * at one `.where()`, the `User` eligibility read at two. Dispatching on the table name rather than
 * on arity means a query retargeted at the wrong table resolves to the wrong fixture and the test
 * fails, instead of both chains quietly sharing one answer.
 */
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: (table: string) => {
      const execute = table === 'User' ? ineligibleRows : bonusEvents;
      const builder: Record<string, unknown> = { execute };
      for (const method of ['select', 'where']) builder[method] = () => builder;
      return builder;
    },
  },
  dbWrite: {},
}));

const { rewardReportReporters } = await import('../rewards');

/** The cached shape written by the main app's userMultipliersCache. */
const cached = (rewardsMultiplier: number) => ({ rewardsMultiplier, notFound: false });

/** `RewardsBonusEvent.multiplier` is stored x10, so 50 is a 5x event. */
const bonus = (stored: number) => [{ multiplier: stored, startsAt: null, endsAt: null }];

async function rowFor({
  tier,
  storedBonus,
  ineligible = false,
}: {
  tier: unknown;
  storedBonus: number;
  ineligible?: boolean;
}) {
  redisGet.mockResolvedValue(tier);
  bonusEvents.mockResolvedValue(bonus(storedBonus));
  ineligibleRows.mockResolvedValue(ineligible ? [{ id: 42 }] : []);
  await rewardReportReporters({ reportId: 1, reporterIds: [42] });
  expect(insert).toHaveBeenCalledTimes(1);
  return insert.mock.calls[0][0].values[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rewardReportReporters multiplier', () => {
  it('clamps a gold tier under a 5x bonus to what the Decimal(3, 2) column can hold', async () => {
    // 4 x 5 = 20. The column's ceiling is 9.99; 20 is unparseable, so ClickHouse drops the row and
    // the reporter is never paid.
    const row = await rowFor({ tier: cached(4), storedBonus: 50 });
    expect(row.multiplier).toBe(9.99);
  });

  it('records the unclamped product so a clamped row is still traceable', async () => {
    const row = await rowFor({ tier: cached(4), storedBonus: 50 });
    expect(JSON.parse(row.transactionDetails)).toEqual({ multiplierRaw: 20 });
  });

  it('reports a clamp to Axiom rather than swallowing it', async () => {
    await rowFor({ tier: cached(4), storedBonus: 50 });
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom.mock.calls[0][0]).toMatchObject({ clampedEvents: 1, maxRaw: 20 });
  });

  it('leaves a product the column can hold exactly alone', async () => {
    // The live 2x event against gold is 8 — under the ceiling. A clamp that fired here would
    // underpay every gold reporter today, so this is the control for the case above.
    const row = await rowFor({ tier: cached(4), storedBonus: 20 });
    expect(row.multiplier).toBe(8);
    expect(row.transactionDetails).toBe('{}');
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('writes 0 for a rewards-ineligible reporter instead of paying them the base award', async () => {
    // A rewardsMultiplier of 0 is userMultipliersCache reporting rewardsEligibility='Ineligible'.
    // Read as a missing value it becomes 1, and process-rewards pays the full 50 Buzz — the hole
    // PR #4383 closed on the main app's side of this same table.
    const row = await rowFor({ tier: cached(0), storedBonus: 20 });
    expect(row.multiplier).toBe(0);
  });

  // Both fallback cases run under a 2x bonus deliberately. Asserting 1 under a 1x bonus cannot
  // fail: a guard that returns `undefined` gives `undefined * 1 = NaN`, and the clamp turns a
  // non-finite value into 1 — so the assertion would pass through the clamp rather than through
  // the fallback it names. Under 2x the fallback gives 2 and the broken path still gives 1.
  it('falls back to the base multiplier when the shared cache has nothing', async () => {
    const row = await rowFor({ tier: null, storedBonus: 20 });
    expect(row.multiplier).toBe(2);
  });

  it('falls back to the base multiplier for a notFound entry, ignoring any tier on it', async () => {
    // A real notFound entry carries no multiplier; one is put here so that dropping the
    // `!cached.notFound` half of the guard reads back 4 rather than silently still passing.
    const row = await rowFor({ tier: { notFound: true, rewardsMultiplier: 4 }, storedBonus: 20 });
    expect(row.multiplier).toBe(2);
  });

  it('writes 0 for a reporter Postgres reports ineligible even when the cache is cold', async () => {
    // The shared cache is written only by the main app and expires after a day, so a reporter who
    // has not browsed since filing has no entry at all — and a miss there reads as eligible. Read
    // from the cache alone, this barred user is paid the full award a week after filing.
    const row = await rowFor({ tier: null, storedBonus: 20, ineligible: true });
    expect(row.multiplier).toBe(0);
  });

  it('treats a non-finite cached tier as a fallback, not as a clamp', async () => {
    // NaN is `typeof 'number'`, so it walks past the tier guard. It reaches the column as an
    // unparseable value, which is the dropped row this whole path exists to prevent — so it becomes
    // the base multiplier. Reporting that as a clamp would fire an error alert naming a ceiling
    // nothing came near, and write `{"multiplierRaw":null}` as the audit trail.
    const row = await rowFor({ tier: cached(NaN), storedBonus: 20 });
    expect(row.multiplier).toBe(1);
    expect(row.transactionDetails).toBe('{}');
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('does not consult the shared cache at all for an ineligible reporter', async () => {
    await rowFor({ tier: cached(4), storedBonus: 20, ineligible: true });
    expect(redisGet).not.toHaveBeenCalled();
  });
});
