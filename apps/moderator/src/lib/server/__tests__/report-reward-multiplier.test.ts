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
const logToAxiom = vi.fn().mockResolvedValue(undefined);

vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
vi.mock('../redis', () => ({ getRedis: () => ({ packed: { get: redisGet } }) }));
vi.mock('../axiom', () => ({ logToAxiom }));
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: () => ({ select: () => ({ where: () => ({ execute: bonusEvents }) }) }),
  },
  dbWrite: {},
}));

const { rewardReportReporters } = await import('../rewards');

/** The cached shape written by the main app's userMultipliersCache. */
const cached = (rewardsMultiplier: number) => ({ rewardsMultiplier, notFound: false });

/** `RewardsBonusEvent.multiplier` is stored x10, so 50 is a 5x event. */
const bonus = (stored: number) => [{ multiplier: stored, startsAt: null, endsAt: null }];

async function rowFor({ tier, storedBonus }: { tier: unknown; storedBonus: number }) {
  redisGet.mockResolvedValue(tier);
  bonusEvents.mockResolvedValue(bonus(storedBonus));
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

  it('falls back to the base multiplier when the shared cache has nothing', async () => {
    const row = await rowFor({ tier: null, storedBonus: 10 });
    expect(row.multiplier).toBe(1);
  });

  it('falls back to the base multiplier for a notFound entry', async () => {
    const row = await rowFor({ tier: { notFound: true }, storedBonus: 10 });
    expect(row.multiplier).toBe(1);
  });
});
