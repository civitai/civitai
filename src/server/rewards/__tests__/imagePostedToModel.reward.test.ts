import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `imagePostedToModelReward` pays the GALLERY TARGET'S MODEL OWNER — a party who
 * is neither the post's author nor anyone the author interacted with. Which model
 * version a post attaches to is therefore a choice about who gets paid.
 *
 * On the App Blocks post path that choice is made by the calling app rather than
 * by the person whose byline the post carries, so the reward declines the call
 * outright. `viaAppId` is the signal, it is server-derived at every call site (the
 * verified block token's `appId`), and `getKey` returning `false` is the
 * framework's existing per-call suppression — `apply` reads it as
 * `if (!definedKey) return null`.
 *
 * 🔴 WHY THE ASSERTIONS ARE "NO LOOKUP HAPPENED" RATHER THAN "NO BUZZ MOVED".
 * `apply` has TWO gates BEFORE `getKey` — a falsy `clickhouse`, and a disabled
 * reward config — and either one produces a silent early return that looks exactly
 * like a working suppression. An assertion that only watched the money would pass
 * with the suppression deleted, on a fixture those gates had already rejected. So
 * every case here is paired with a POSITIVE CONTROL running the IDENTICAL fixture
 * with `viaAppId` absent: the control proves the call reaches `getKey` at all, and
 * only then does the suppressed case's silence mean anything.
 *
 * The discriminator is the OWNER LOOKUP (`dbWrite.$queryRaw`) plus the multiplier
 * read. Both sit strictly after this guard and strictly before the self-post guard
 * resolves, so a suppression that fired for the WRONG reason — the self-post guard,
 * an unresolvable owner — would still show the lookup.
 */

const h = vi.hoisted(() => ({
  insertImpl: vi.fn(async () => undefined),
  queryImpl: vi.fn(async () => [] as unknown[]),
  evalImpl: vi.fn(async () => 0 as number),
  hGetImpl: vi.fn(async () => '{}'),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: unknown[]) => h.insertImpl(...(args as [])),
    $query: (...args: unknown[]) => h.queryImpl(...(args as [])),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
}));

vi.mock('~/server/prom/client', () => ({
  rewardFailedCounter: { inc: vi.fn() },
  rewardGivenCounter: { inc: vi.fn() },
  clickhouseFailSoftCounter: { inc: vi.fn() },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => h.createBuzzTransactionMany(...(args as [])),
  getMultipliersForUser: (...args: unknown[]) => h.getMultipliersForUser(...(args as [])),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { imagePostedToModelReward } from '~/server/rewards/passive/imagePostedToModel.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';

redisMock.redis.eval.mockImplementation((...args: unknown[]) => h.evalImpl(...(args as [])));
redisMock.redis.hGet.mockImplementation((...args: unknown[]) => h.hGetImpl(...(args as [])));

/**
 * Fixture ids, all pairwise distinct AND distinct from every constant any
 * assertion names — so a mutant that returned one of them in place of another
 * cannot survive by coincidence.
 */
const POSTER_ID = 4242;
const MODEL_OWNER_ID = 555;
const MODEL_VERSION_ID = 3100;
const MODEL_ID = 800;
const APP_ID = 'appblk-alpha';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  // No override row → the reward runs at its declared config, i.e. ENABLED. This
  // is what keeps `apply`'s pre-`getKey` config gate from silently swallowing
  // every case below.
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  // The owner lookup `getKey` issues when `modelOwnerId` was not supplied.
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ userId: MODEL_OWNER_ID }]);
  h.insertImpl.mockResolvedValue(undefined);
  h.queryImpl.mockResolvedValue([]);
  h.evalImpl.mockResolvedValue(0);
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

/** The native shape: no app composed this post. */
function nativeEvent(over: Record<string, unknown> = {}) {
  return {
    modelId: MODEL_ID,
    modelVersionId: MODEL_VERSION_ID,
    posterId: POSTER_ID,
    ...over,
  };
}

describe('🔴 imagePostedToModelReward — an app-composed post pays the model owner NOTHING', () => {
  it('POSITIVE CONTROL: the identical event WITHOUT `viaAppId` reaches getKey and resolves a key', async () => {
    // Without this, every assertion below is a claim about `apply`'s config gate
    // rather than about the suppression: a reward that never reaches `getKey`
    // looks identical to one that reached it and declined.
    await imagePostedToModelReward.apply(nativeEvent());

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalled();
    expect(h.getMultipliersForUser).toHaveBeenCalledWith(MODEL_OWNER_ID);
  });

  it('SUPPRESSES the reward when the post was composed by an app', async () => {
    await imagePostedToModelReward.apply(nativeEvent({ viaAppId: APP_ID }));

    // No key was resolved, so nothing downstream of `getKey` ran. Paired with the
    // control above, this is a claim about THIS guard.
    expect(h.getMultipliersForUser).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(redisMock.redis.eval).not.toHaveBeenCalled();
  });

  it('declines BEFORE the model-owner lookup — a suppressed call costs no query', async () => {
    // The ordering claim, and the assertion that separates this guard from the
    // self-post guard below it: that one can only decline AFTER the lookup has
    // run, so a lookup here would mean a different guard fired.
    await imagePostedToModelReward.apply(nativeEvent({ viaAppId: APP_ID }));

    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('suppresses even when the model owner is a genuine third party', async () => {
    // The case the guard exists for, spelled out: owner resolved, owner ≠ poster,
    // so BOTH existing conditions in `getKey` would have returned a key. Nothing
    // but this guard can be taking credit for the refusal.
    await imagePostedToModelReward.apply(
      nativeEvent({ modelOwnerId: MODEL_OWNER_ID, viaAppId: APP_ID })
    );

    expect(h.getMultipliersForUser).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: that same third-party event DOES resolve a key natively', async () => {
    await imagePostedToModelReward.apply(nativeEvent({ modelOwnerId: MODEL_OWNER_ID }));

    expect(h.getMultipliersForUser).toHaveBeenCalledWith(MODEL_OWNER_ID);
  });

  it('an EMPTY `viaAppId` is not a suppression signal', async () => {
    // Pins the predicate's shape. Every call site supplies a real token `appId` or
    // nothing at all, so this case is unreachable in production — it is here so a
    // future rewrite to `viaAppId !== undefined` fails rather than silently
    // turning a falsy value into an app post.
    await imagePostedToModelReward.apply(nativeEvent({ viaAppId: '' }));

    expect(h.getMultipliersForUser).toHaveBeenCalledWith(MODEL_OWNER_ID);
  });

  it('leaves the pre-existing self-post decline intact, and it is distinguishable', async () => {
    // A NATIVE post whose author owns the model still resolves no key — that guard
    // is untouched. It is also observably a DIFFERENT guard: it can only decide
    // after resolving the owner, so it PAYS FOR THE LOOKUP where this file's guard
    // does not. That asymmetry is what stops either decline being mistaken for the
    // other in any case above.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ userId: POSTER_ID }]);

    await imagePostedToModelReward.apply(nativeEvent());

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalled();
    expect(h.getMultipliersForUser).not.toHaveBeenCalled();
  });
});
