import { beforeEach, describe, expect, it, vi } from 'vitest';

// What is under test is the reward's own definition — who is paid, in what
// currency, keyed on what, and against which cap. `base.reward` pulls a live
// client out of the two modules below, so both are hand-written rather than
// spread from `importOriginal`: the spread loads the real graph, which is the
// client construction the mock exists to avoid (1.8s → 15.6s of import here).
//
// What makes a hand-written factory safe is `base.reward.mock-surface.test.ts`,
// which reads `base.reward`'s imports as source and fails if either module's
// surface grows past what these factories provide. Without that guard this
// shape breaks the whole FILE — 0 collected, nothing red — the first time it
// drifts. Change either factory only together with that file's
// `MOCKED_MODULE_SURFACE`.
//
// `~/server/prom/client` needs nothing here: `src/__tests__/setup.ts` already
// stubs it, and hand-listing three of its ~40 exports narrowed that stub.
const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  createBuzzTransactionMany: vi.fn(async () => undefined),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));
const { createBuzzTransactionMany, getMultipliersForUser } = h;

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: (...args: unknown[]) => h.insert(...args) },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: h.createBuzzTransactionMany,
  getMultipliersForUser: h.getMultipliersForUser,
}));

import { remixAcceptReward } from '~/server/rewards/active/remixAccept.reward';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/** Distinct, so a value reaching the wrong field cannot pass by colliding. */
const OWNER = 41;
const PLACER = 52;
const PLACEMENT = 96;

const AWARD = 20;
const DAILY_CAP = 100;

const accept = (over: Partial<Parameters<typeof remixAcceptReward.apply>[0]> = {}) =>
  remixAcceptReward.apply({
    placementId: PLACEMENT,
    ownerId: OWNER,
    placerId: PLACER,
    ...over,
  });

/** The Lua call's ARGV, which is where the award and the cap are actually decided. */
const lastEvalArgs = () => {
  const [, options] = redisMock.redis.eval.mock.calls.at(-1) as [unknown, { arguments: string[] }];
  return options.arguments;
};

const lastTransaction = () => createBuzzTransactionMany.mock.calls.at(-1)?.[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
  // What the Lua script returns when the accept is inside the day's cap.
  redisMock.redis.eval.mockResolvedValue(AWARD);
});

describe('remixAcceptReward', () => {
  it('pays the owner in blue buzz, with the submitter recorded as the cause', async () => {
    await accept();

    expect(lastTransaction()).toMatchObject({
      toAccountId: OWNER,
      toAccountType: 'blue',
      amount: AWARD,
      details: { forId: PLACEMENT, byUserId: PLACER },
    });
  });

  // The ledger key is the double-pay backstop under the caller's once-ever gate,
  // and it is built from (forId, toUserId, byUserId). Keyed on anything the owner
  // can produce twice — the host image, the submitted image — a second accept on
  // the same host would be refused as a duplicate and pay nothing.
  it('keys the ledger on the placement, not on either image', async () => {
    await accept();

    expect(lastTransaction()?.externalTransactionId).toBe(
      `remixAccept:${PLACEMENT}-${OWNER}-${PLACER}`
    );
  });

  // 20 × 5 = 100. At a cap equal to the award the first accept of the day would
  // exhaust it and every later one would pay nothing, which is a different reward
  // from the one that was designed.
  it('asks redis for a cap of five accepts a day, not one', async () => {
    await accept();

    const [, , award, cap] = lastEvalArgs();
    expect(award).toBe(String(AWARD));
    expect(cap).toBe(String(DAILY_CAP));
  });

  // Rewards multiply with membership tier here as everywhere else, and the cap has
  // to move with the award: multiplying one alone silently changes how many
  // accepts a member is paid for.
  it('scales the award and the cap together by the membership multiplier', async () => {
    getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 4 });
    await accept();

    const [, , award, cap] = lastEvalArgs();
    expect(award).toBe(String(AWARD * 4));
    expect(cap).toBe(String(DAILY_CAP * 4));
  });

  // The multiplier is the OWNER's — they are the one being paid. Reading the
  // submitter's would let a gold-tier submitter mint four times the reward into a
  // free account, and would pay two owners differently for the same accept.
  it('reads the multiplier for the owner being paid', async () => {
    await accept();

    expect(getMultipliersForUser).toHaveBeenCalledWith(OWNER);
  });

  // Redis returns 0 once the day's cap is spent. The event is still recorded, so
  // the dashboard can show the cap was reached, but no buzz moves.
  it('records a capped accept without paying for it', async () => {
    redisMock.redis.eval.mockResolvedValue(0);
    await accept();

    expect(h.insert).toHaveBeenCalled();
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  // The Blue Buzz minting path. Refused here rather than left to the submission
  // path's `space.ownerId === placerId` refusal two layers up: that one is a
  // product rule about who may submit, and this one is about who may be paid.
  it('pays nothing for an owner accepting their own submission', async () => {
    await accept({ placerId: OWNER });

    expect(redisMock.redis.eval).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  // -1 is the Lua dedup hit: this placement already paid today. Nothing is
  // recorded and nothing is paid.
  it('does nothing for a placement already rewarded today', async () => {
    redisMock.redis.eval.mockResolvedValue(-1);
    await accept();

    expect(h.insert).not.toHaveBeenCalled();
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
