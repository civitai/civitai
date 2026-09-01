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
/** The ids the chain fake requires the `User` query to have asked for; set by `rowsFor`. */
let reporterIds: number[] = [];
const logToAxiom = vi.fn().mockResolvedValue(undefined);
const logAxiomError = vi.fn();

vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
vi.mock('../redis', () => ({ getRedis: () => ({ packed: { get: redisGet } }) }));
vi.mock('../axiom', () => ({ logToAxiom, logAxiomError }));
/**
 * A stand-in for the two Kysely chains this module builds.
 *
 * 🔴 It must answer from the RECORDED CHAIN, never from the table name alone. The case that forces
 * this: a fake whose `.where` ignores its arguments cannot tell `'Ineligible'` from `'Eligible'`, so
 * INVERTING the eligibility predicate passes every test in this file while paying 13M eligible
 * reporters nothing and paying every barred one in full. The predicate IS the money here, so the
 * `User` chain resolves only when it asked for the reporters AND for Ineligible, and yields nothing
 * otherwise — a query with a clause dropped, flipped or retargeted resolves empty and fails.
 */
function chain(resolve: (wheres: unknown[][]) => unknown) {
  const wheres: unknown[][] = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    where: (...args: unknown[]) => {
      wheres.push(args);
      return builder;
    },
    execute: async () => resolve(wheres),
  };
  return builder;
}

const has = (wheres: unknown[][], ...expected: unknown[]) =>
  wheres.some(
    (w) =>
      w.length === expected.length &&
      expected.every((e, i) => {
        const actual = w[i];
        return Array.isArray(e) && Array.isArray(actual)
          ? e.length === actual.length && e.every((v, j) => v === actual[j])
          : e === actual;
      })
  );

vi.mock('../db', () => ({
  dbRead: {
    selectFrom: (table: string) =>
      table === 'User'
        ? chain((wheres) =>
            has(wheres, 'id', 'in', reporterIds) &&
            has(wheres, 'rewardsEligibility', '=', 'Ineligible')
              ? ineligibleRows()
              : []
          )
        : chain((wheres) => (has(wheres, 'enabled', '=', true) ? bonusEvents() : [])),
  },
  dbWrite: {},
}));

const { rewardReportReporters } = await import('../rewards');

/** The cached shape written by the main app's userMultipliersCache. */
const cached = (rewardsMultiplier: number) => ({ rewardsMultiplier, notFound: false });

/** `RewardsBonusEvent.multiplier` is stored x10, so 50 is a 5x event. */
const bonus = (stored: number) => [{ multiplier: stored, startsAt: null, endsAt: null }];

async function rowsFor({
  tiers,
  storedBonus,
  ineligible = [],
}: {
  /** Ordered [reporterId, cached tier] pairs — an object would reorder integer keys. */
  tiers: [number, unknown][];
  storedBonus: number;
  ineligible?: number[];
}) {
  reporterIds = tiers.map(([id]) => id);
  redisGet.mockImplementation(async (key: string) => {
    const id = Number(key.split(':').pop());
    return tiers.find(([tierId]) => tierId === id)?.[1];
  });
  bonusEvents.mockReturnValue(bonus(storedBonus));
  ineligibleRows.mockReturnValue(ineligible.map((id) => ({ id })));
  await rewardReportReporters({ reportId: 1, reporterIds });
  expect(insert).toHaveBeenCalledTimes(1);
  const values = insert.mock.calls[0][0].values;
  expect(values).toHaveLength(reporterIds.length);
  return values;
}

/** Single-reporter shorthand; reporter 42 throughout. */
async function rowFor({
  tier,
  storedBonus,
  ineligible = false,
}: {
  tier: unknown;
  storedBonus: number;
  ineligible?: boolean;
}) {
  const [row] = await rowsFor({
    tiers: [[42, tier]],
    storedBonus,
    ineligible: ineligible ? [42] : [],
  });
  return row;
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

  it('pays a garbage cached tier exactly what a missing one pays, and says so', async () => {
    // NaN is `typeof 'number'`, so it walks past the tier guard and reaches the column as a value
    // it cannot parse. Letting the clamp catch it instead pays 1 rather than 2, because the clamp
    // never sees the bonus — a garbage entry would quietly be worth less than no entry at all.
    const row = await rowFor({ tier: cached(NaN), storedBonus: 20 });
    expect(row.multiplier).toBe(2);
    // Not reported as a clamp: nothing came near the column's ceiling.
    expect(row.transactionDetails).toBe('{}');
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom.mock.calls[0][0].message).toMatch(/not finite/);
  });

  it('bars only the ineligible reporter in a batch, not the whole report', async () => {
    // Production's normal case: `[updated.userId, ...alsoReportedBy]`. The eligibility branch is the
    // first per-reporter decision in this function, so a batch is the only shape that can tell
    // "this reporter is barred" apart from "someone in this batch is barred".
    const rows = await rowsFor({
      tiers: [
        [42, cached(4)],
        [7, cached(2)],
        [9, cached(1)],
      ],
      storedBonus: 20,
      ineligible: [7],
    });
    expect(
      rows.map((r: { toUserId: number; multiplier: number }) => [r.toUserId, r.multiplier])
    ).toEqual([
      [42, 8],
      [7, 0],
      [9, 2],
    ]);
  });

  it('does not consult the shared cache at all for an ineligible reporter', async () => {
    await rowFor({ tier: cached(4), storedBonus: 20, ineligible: true });
    expect(redisGet).not.toHaveBeenCalled();
  });
});
