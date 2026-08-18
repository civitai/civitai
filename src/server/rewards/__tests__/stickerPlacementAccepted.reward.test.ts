import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.reward builds a ClickHouse client, redis handles and prom collectors at
// import time. Mocked to the surface it touches so this suite can collect.
const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
  eval: vi.fn(async () => 0 as number),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: (...args: unknown[]) => h.insert(...(args as [])) },
}));
// Prom is NOT mocked here: setup.ts stubs it globally, including the
// `clickhouseFailSoftCounter` this branch needs — which it was missing until
// this PR added it, so a local three-item factory here would have been the
// wider surface, not the narrower one. Neither ClickHouse nor buzz.service is
// stubbed globally, and spreading either would build a real client at import,
// so those two stay hand-written and base.reward.mock-surface.test.ts checks
// them against what base.reward actually imports.
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => h.createBuzzTransactionMany(...(args as [])),
  getMultipliersForUser: (...args: unknown[]) => h.getMultipliersForUser(...(args as [])),
}));

import { stickerPlacementAcceptedReward } from '~/server/rewards/active/stickerPlacementAccepted.reward';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: unknown[]) => h.eval(...(args as [])));

const OWNER = 10;
const PLACER = 20;
const PLACEMENT = 777;

/** The award and cap the Lua script was handed, both already multiplied. */
const luaBudget = () => {
  const [, options] = h.eval.mock.calls.at(-1) as unknown as [string, { arguments: string[] }];
  const [, , award, cap] = options.arguments;
  return { award: Number(award), cap: Number(cap) };
};

const grant = () =>
  (h.createBuzzTransactionMany.mock.calls.at(-1) as unknown as [Record<string, unknown>[]])[0];

beforeEach(() => {
  vi.clearAllMocks();
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
  // The award landed rather than hitting the cap, unless a test says otherwise.
  h.eval.mockResolvedValue(10);
});

const accept = (overrides: Partial<Record<'placementId' | 'ownerId' | 'placerId', number>> = {}) =>
  stickerPlacementAcceptedReward.apply({
    placementId: PLACEMENT,
    ownerId: OWNER,
    placerId: PLACER,
    ...overrides,
  });

describe('the sticker accept reward', () => {
  it('pays the owner ten Blue Buzz, from the placer', async () => {
    await accept();

    expect(grant()).toEqual([
      expect.objectContaining({
        toAccountId: OWNER,
        toAccountType: 'blue',
        amount: 10,
        details: expect.objectContaining({ byUserId: PLACER, forId: PLACEMENT }),
      }),
    ]);
  });

  // The ledger's own idempotency key. It is what makes a re-presented placement
  // silently pay nothing rather than pay twice — and therefore what the caller's
  // once-per-settle guard exists to keep out of reach.
  it('keys the transaction on the placement', async () => {
    await accept();

    expect(grant()[0]).toMatchObject({
      externalTransactionId: `stickerPlacementAccepted:${PLACEMENT}-${OWNER}-${PLACER}`,
    });
  });

  // An auto-accept space performs no accept: the placement settles inline in the
  // placer's request. Copy about accepting is false there, and the intent doc
  // expects auto to become the majority path. Justin's framing is "10 Buzz for
  // each image sticker you get each day".
  it('describes the reward as getting a sticker, never as accepting one', async () => {
    const details = await stickerPlacementAcceptedReward.getUserRewardDetails(OWNER);

    expect(details.description).toBe('You got a sticker on your content');
    expect(details.triggerDescription).toBe(
      'For each sticker you get on your content, up to 10 a day'
    );
  });

  it('caps the day at ten accepted stickers', async () => {
    await accept();

    expect(luaBudget()).toEqual({ award: 10, cap: 100 });
  });

  // Every other reward multiplies both halves with the membership tier, so a
  // gold member's ten a day is forty. Deliberate, and confirmed with Justin.
  it('multiplies the award and the cap together with membership', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 4 });

    await accept();

    expect(luaBudget()).toEqual({ award: 40, cap: 400 });
  });

  it('moves no Buzz once the day is spent', async () => {
    h.eval.mockResolvedValue(0);

    await accept();

    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  // A capped accept is still a thing that happened, and the buzzEvents row is
  // what the cap is later read back from. Dropping it would make the day look
  // less spent than it was.
  it('records a capped accept without paying for it', async () => {
    h.eval.mockResolvedValue(0);

    await accept();

    expect(h.insert).toHaveBeenCalled();
  });

  // -1 is the Lua dedup hit: this placement already paid today. Nothing further
  // is written — no audit row, no grant — so a retry is inert rather than noisy.
  it('writes nothing at all when the placement already paid today', async () => {
    h.eval.mockResolvedValue(-1);

    await accept();

    expect(h.insert).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  // Accepting your own sticker is minting Blue Buzz out of nothing. Both
  // placement paths already refuse self-placement, and this is what stops the
  // reward relying on that.
  it('pays nothing when the owner is the placer', async () => {
    await accept({ placerId: OWNER });

    expect(h.eval).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
