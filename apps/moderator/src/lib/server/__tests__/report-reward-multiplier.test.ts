import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '@civitai/axiom';
import { REDIS_KEYS } from '@civitai/redis';

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
/**
 * The axiom PACKAGE is mocked, not `../axiom`, so both `logToAxiom` and `logAxiomError` run for real
 * over one spy. That is the only level at which the defect this file now pins is visible: the bug was
 * `logAxiomError`'s own composition — `safeError` spreads LAST, so a `name`/`message` passed by a
 * caller is silently overwritten by the Error's. A mocked `logAxiomError` cannot see that, and did
 * not: the marker was clobbered for a full commit with the suite green.
 */
const axiom = vi.fn(async (_data: Record<string, unknown>, _datastream?: string) => {});
vi.mock('@civitai/axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  createAxiomLogger: () => ({ logToAxiom: axiom }),
}));

vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
vi.mock('../redis', () => ({ getRedis: () => ({ packed: { get: redisGet } }) }));
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
function chain(resolve: (calls: { wheres: unknown[][]; selects: unknown[][] }) => unknown) {
  const wheres: unknown[][] = [];
  const selects: unknown[][] = [];
  const builder: Record<string, unknown> = {
    select: (...args: unknown[]) => {
      selects.push(args);
      return builder;
    },
    where: (...args: unknown[]) => {
      wheres.push(args);
      return builder;
    },
    execute: async () => resolve({ wheres, selects }),
  };
  return builder;
}

/** Deep-equal for the recorded argument arrays, which hold primitives and id arrays only. */
const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => same(v, b[i]))
    : a === b;

/** Exact clause count, so an ADDED restrictive clause is visible too, not just a changed one. */
const wheresAre = (wheres: unknown[][], count: number) => wheres.length === count;

const has = (wheres: unknown[][], ...expected: unknown[]) => wheres.some((w) => same(w, expected));

vi.mock('../db', () => ({
  dbRead: {
    selectFrom: (table: string) =>
      table === 'User'
        ? chain(({ wheres, selects }) =>
            wheresAre(wheres, 2) &&
            has(wheres, 'id', 'in', reporterIds) &&
            has(wheres, 'rewardsEligibility', '=', 'Ineligible') &&
            // The rows are keyed by `id` downstream; selecting anything else yields a Set of
            // `undefined` and bars nobody.
            has(selects, ['id'])
              ? ineligibleRows()
              : []
          )
        : table === 'RewardsBonusEvent'
        ? chain(({ wheres }) =>
            wheresAre(wheres, 1) && has(wheres, 'enabled', '=', true) ? bonusEvents() : []
          )
        : chain(() => []),
  },
  dbWrite: {},
}));

const { rewardReportReporters } = await import('../rewards');

/** The cached shape written by the main app's userMultipliersCache. */
const cached = (rewardsMultiplier: number) => ({ rewardsMultiplier, notFound: false });

/** `RewardsBonusEvent.multiplier` is stored x10, so 50 is a 5x event. */
const bonus = (stored: number) => [{ multiplier: stored, startsAt: null, endsAt: null }];

const HOUR = 60 * 60 * 1000;
/** An event whose window has closed but whose `enabled` was never flipped — the schema permits it. */
const expiredBonus = (stored: number) => [
  {
    multiplier: stored,
    startsAt: new Date(Date.now() - 2 * HOUR),
    endsAt: new Date(Date.now() - HOUR),
  },
];

async function rowsFor({
  tiers,
  storedBonus,
  ineligible = [],
  events,
}: {
  /** Ordered [reporterId, cached tier] pairs — an object would reorder integer keys. */
  tiers: [number, unknown][];
  storedBonus: number;
  ineligible?: number[];
  /** Raw RewardsBonusEvent rows, when a case needs a window rather than a plain multiplier. */
  events?: unknown[];
}) {
  reporterIds = tiers.map(([id]) => id);
  redisGet.mockImplementation(async (key: string) => {
    const id = Number(key.split(':').pop());
    return tiers.find(([tierId]) => tierId === id)?.[1];
  });
  bonusEvents.mockReturnValue(events ?? bonus(storedBonus));
  ineligibleRows.mockReturnValue(ineligible.map((id) => ({ id })));
  await rewardReportReporters({ reportId: 1, reporterIds });
  expect(insert).toHaveBeenCalledTimes(1);
  // The destination is as load-bearing as the values: a wrong table or format writes nowhere
  // process-rewards reads, and every reporter is silently never paid.
  expect(insert.mock.calls[0][0]).toMatchObject({
    table: 'buzzEvents',
    format: 'JSONEachRow',
  });
  const values = insert.mock.calls[0][0].values;
  expect(values).toHaveLength(reporterIds.length);
  return values;
}

/** Single-reporter shorthand; reporter 42 throughout. */
async function rowFor({
  tier,
  storedBonus,
  ineligible = false,
  events,
}: {
  tier: unknown;
  storedBonus: number;
  ineligible?: boolean;
  events?: unknown[];
}) {
  const [row] = await rowsFor({
    tiers: [[42, tier]],
    storedBonus,
    ineligible: ineligible ? [42] : [],
    events,
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
    expect(axiom).toHaveBeenCalledTimes(1);
    expect(axiom.mock.calls[0][0]).toMatchObject({ clampedEvents: 1, maxRaw: 20 });
  });

  it('leaves a product the column can hold exactly alone', async () => {
    // The live 2x event against gold is 8 — under the ceiling. A clamp that fired here would
    // underpay every gold reporter today, so this is the control for the case above.
    const row = await rowFor({ tier: cached(4), storedBonus: 20 });
    expect(row.multiplier).toBe(8);
    expect(row.transactionDetails).toBe('{}');
    expect(axiom).not.toHaveBeenCalled();
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
    expect(axiom).toHaveBeenCalledTimes(1);
    expect(axiom.mock.calls[0][0].message).toMatch(/not finite/);
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

  it('ignores a bonus event whose window has closed but whose enabled was never flipped', async () => {
    // Nothing flips `enabled` at expiry — upsertRewardsBonusEvent writes `enabled` and `endsAt`
    // independently. Without the active-window filter a finished 5x promotion keeps multiplying
    // every accepted report forever, and diverges from the main app, which evaluates the window live.
    const row = await rowFor({ tier: cached(4), storedBonus: 50, events: expiredBonus(50) });
    expect(row.multiplier).toBe(4);
  });

  it('caps a mistyped bonus event at MAX_GLOBAL_BONUS', async () => {
    // 200 instead of 20 is the operator typo the cap exists for. Uncapped this pays a tier-1
    // reporter 9.99x — the clamp's ceiling — rather than the intended 5x.
    const row = await rowFor({ tier: cached(1), storedBonus: 200 });
    expect(row.multiplier).toBe(5);
  });

  it('treats a tier whose PRODUCT overflows as a fallback, not as a clamp', async () => {
    // Both factors are finite here — the guard is not about a non-finite tier, which is already
    // rejected where the tier is read. 1e308 x 5 is Infinity, and calling that a clamp writes
    // `{"multiplierRaw":null}` and alerts on a ceiling nothing came near.
    const row = await rowFor({ tier: cached(1e308), storedBonus: 50 });
    expect(row.multiplier).toBe(1);
    expect(row.transactionDetails).toBe('{}');
    expect(axiom).not.toHaveBeenCalled();
  });

  it('records a failed write as a findable event rather than swallowing it', async () => {
    // Nothing retries this: reports.service marks the report Actioned BEFORE calling, and its
    // guarded UPDATE matches nothing on a second attempt. The Axiom line is the only trace that
    // these reporters were never paid, so the marker has to survive serialization —
    // `safeError` spreads LAST inside logAxiomError, which is why the marker cannot be `name` or
    // `message`. It was both, for a whole commit, with this suite green.
    insert.mockRejectedValueOnce(new Error('clickhouse unreachable'));
    redisGet.mockResolvedValue(cached(1));
    bonusEvents.mockReturnValue(bonus(10));
    ineligibleRows.mockReturnValue([]);
    reporterIds = [42, 7];

    await expect(rewardReportReporters({ reportId: 91234, reporterIds })).resolves.toBeUndefined();

    expect(axiom).toHaveBeenCalledTimes(1);
    const payload = axiom.mock.calls[0][0];
    // `type` is the queryable discriminator, and `extra` spreads AFTER it inside logAxiomError —
    // so a caller passing `type` in extra unfindables its own event, one key over from the clobber
    // this test exists for.
    expect(payload.type).toBe('error');
    expect(payload.event).toBe('reportAccepted rewards write failed');
    expect(payload.reportId).toBe(91234);
    expect(payload.reporterIds).toEqual([42, 7]);
    // safeError's fields land alongside the marker rather than instead of it.
    expect(payload.message).toBe('clickhouse unreachable');
    expect(JSON.stringify(payload)).toContain('reportAccepted rewards write failed');
  });

  it('writes the reportAccepted envelope process-rewards expects', async () => {
    const row = await rowFor({ tier: cached(1), storedBonus: 10 });
    // `status: 'pending'` is what makes process-rewards pick the row up at all, and the award must
    // match reportAccepted.reward.ts or the two apps grant inconsistently. Nothing else pins these.
    expect(row).toMatchObject({
      type: 'reportAccepted',
      status: 'pending',
      awardAmount: 50,
      toUserId: 42,
      byUserId: 42,
      forId: 1,
    });
  });

  it('reads the tier from the cache key the main app writes', async () => {
    // The shared key IS the cross-app contract. Point this at any other cache and every reporter
    // misses, falls back to 1x and is quietly underpaid — no error, no empty result to notice.
    await rowFor({ tier: cached(2), storedBonus: 10 });
    expect(redisGet).toHaveBeenCalledWith(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:42`);
  });

  it('distinguishes the clamp alert fields from each other', async () => {
    // At one reporter every field is the same number, so swapping them passes — and TWO must clamp
    // with different raws, or max and min of a one-element array agree and `maxRaw` is still free.
    // 4x5=20 and 3x5=15 both clamp; 1x5=5 does not. All three fields end up distinct.
    await rowsFor({
      tiers: [
        [42, cached(4)],
        [7, cached(3)],
        [9, cached(1)],
      ],
      storedBonus: 50,
    });
    expect(axiom).toHaveBeenCalledTimes(1);
    expect(axiom.mock.calls[0][0]).toMatchObject({
      name: 'buzz-rewards',
      type: 'error',
      clampedEvents: 2,
      batchSize: 3,
      maxRaw: 20,
    });
  });

  it('floors a negative tier to 0 rather than writing it', async () => {
    // A negative fits Decimal(3, 2) only down to -9.99, so a larger one is the same silently
    // dropped row the ceiling guards. 0 is the value process-rewards understands: unqualified,
    // zero award, cap untouched. Justin's call, 2026-09-01.
    const row = await rowFor({ tier: cached(-5), storedBonus: 20 });
    expect(row.multiplier).toBe(0);
  });

  it('does not let a negative past the column even when it would fit', async () => {
    // -2 x 1 = -2 is storable, so a fix that only guarded the unstorable range would leave it.
    // Kept out anyway: recorded `awarded`, it consumes the reporter's cap and is then dropped by
    // sendAward's amount filter — a row claiming a payout that never happened.
    const row = await rowFor({ tier: cached(-2), storedBonus: 10 });
    expect(row.multiplier).toBe(0);
  });

  it('reports a floor as a floor, not as exceeding the column', async () => {
    // Two floored at DIFFERENT raws, or min and max of a one-element array agree and `minRaw` is
    // unpinned — the degeneracy that already let a mutation through this file once.
    await rowsFor({
      tiers: [
        [42, cached(-5)],
        [7, cached(-3)],
        [9, cached(1)],
      ],
      storedBonus: 20,
    });
    expect(axiom).toHaveBeenCalledTimes(1);
    const payload = axiom.mock.calls[0][0];
    expect(payload.message).toMatch(/negative and was floored/);
    expect(payload).toMatchObject({ flooredEvents: 2, batchSize: 3, minRaw: -10 });
  });

  it('keeps the unclamped negative in the audit trail', async () => {
    const row = await rowFor({ tier: cached(-5), storedBonus: 20 });
    expect(JSON.parse(row.transactionDetails)).toEqual({ multiplierRaw: -10 });
  });

  it('floors a negative that overflows, rather than paying it the base multiplier', async () => {
    // -1e308 x 5 is -Infinity. Falling back to the base multiplier by finiteness alone made the
    // floor non-monotone: a tier of -5 paid nothing while a tier of -1e308 paid the FULL award at
    // 1x. The fallback is by sign for that reason.
    const row = await rowFor({ tier: cached(-1e308), storedBonus: 50 });
    expect(row.multiplier).toBe(0);
    // Signalled even though the raw is not finite — a floor with no trace is what this guards.
    expect(axiom).toHaveBeenCalledTimes(1);
    expect(axiom.mock.calls[0][0].message).toMatch(/negative and was floored/);
    // The raw is unrepresentable in JSON, and `{"multiplierRaw":null}` is a worse trail than none.
    expect(row.transactionDetails).toBe('{}');
  });

  it('reports a clamp and a floor in the same batch as two separate signals', async () => {
    // 4x5=20 clamps, -3x5=-15 floors, 1x5=5 does neither. Nothing else drives both at once, so a
    // change collapsing the two alerts into one passes every other test.
    await rowsFor({
      tiers: [
        [42, cached(4)],
        [7, cached(-3)],
        [9, cached(1)],
      ],
      storedBonus: 50,
    });
    expect(axiom).toHaveBeenCalledTimes(2);
    const messages = axiom.mock.calls.map(([payload]) => String(payload.message));
    expect(messages.some((m) => /negative and was floored/.test(m))).toBe(true);
    expect(messages.some((m) => /exceeded the ClickHouse column/.test(m))).toBe(true);
  });

  it('does not treat a legitimately zero multiplier as an adjustment', async () => {
    // The ineligible reporter is the COMMON production case and its multiplier is 0 by intent, not
    // by clamping. Alerting on it would page someone for every barred reporter, and writing a
    // multiplierRaw would claim an adjustment that never happened.
    const row = await rowFor({ tier: cached(4), storedBonus: 20, ineligible: true });
    expect(row.multiplier).toBe(0);
    expect(row.transactionDetails).toBe('{}');
    expect(axiom).not.toHaveBeenCalled();
  });
});
