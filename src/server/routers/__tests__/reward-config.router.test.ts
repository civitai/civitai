import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as RewardConfig from '~/server/rewards/reward-config';

/**
 * The reward config decides what every Buzz reward pays, so `moderatorProcedure`
 * on both procedures is the whole access boundary. Drives the REAL router through
 * `createCaller` so the middleware wiring decides, not an assertion about how the
 * procedures were declared.
 */

const storedView = (value: unknown) => ({ value, malformed: false, hash: 'hash-of-loaded-row' });

const { mockGetStored, mockSetConfig, mockDescribeConfig } = vi.hoisted(() => ({
  mockGetStored: vi.fn(async () => ({ value: { rewards: {} }, malformed: false, hash: 'h0' })),
  mockSetConfig: vi.fn(async (config: unknown) => config),
  // Reads the switch out of the config it is HANDED, so an assertion about what
  // the router reports is an assertion about which config it passed down. A stub
  // returning a fixed row would pass for a router that resolved from anything at
  // all, including the per-pod memo this design exists to keep out.
  mockDescribeConfig: vi.fn(
    async (config: Record<string, { override?: { enabled?: boolean } }>) => ({
      type: 'testReward',
      visible: true,
      onDemand: true,
      capOverridable: true,
      defaults: { awardAmount: 10, cap: 30 },
      effective: {
        enabled: config?.testReward?.override?.enabled ?? true,
        awardAmount: 10,
        cap: 30,
      },
      rejected: [] as string[],
    })
  ),
}));

vi.mock('~/server/rewards/reward-config', async (importOriginal) => ({
  ...(await importOriginal<typeof RewardConfig>()),
  getStoredRewardConfig: mockGetStored,
  setRewardConfig: mockSetConfig,
}));

vi.mock('~/server/rewards', () => ({
  testReward: { describeConfig: mockDescribeConfig },
}));

import { rewardConfigRouter } from '~/server/routers/reward-config.router';
import { storedViewOf } from '~/server/rewards/reward-config';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const user = { id: 2, isModerator: false, tier: 'free', username: 'user', onboarding: 0x1f };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStored.mockResolvedValue({ value: { rewards: {} }, malformed: false, hash: 'h0' });
});

describe('rewardConfig router authz', () => {
  const cases = [
    { name: 'get', call: (c: ReturnType<typeof rewardConfigRouter.createCaller>) => c.get() },
    {
      name: 'set',
      call: (c: ReturnType<typeof rewardConfigRouter.createCaller>) =>
        c.set({ rewards: { testReward: { enabled: false } } }),
    },
  ];

  for (const { name, call } of cases) {
    it(`refuses a signed-in non-moderator on ${name}`, async () => {
      const caller = rewardConfigRouter.createCaller(fakeCtx(user) as never);

      await expect(call(caller)).rejects.toBeInstanceOf(TRPCError);
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockGetStored).not.toHaveBeenCalled();
    });

    it(`refuses an anonymous caller on ${name}`, async () => {
      const caller = rewardConfigRouter.createCaller(fakeCtx(undefined) as never);

      await expect(call(caller)).rejects.toBeInstanceOf(TRPCError);
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(mockGetStored).not.toHaveBeenCalled();
    });

    it(`admits a moderator on ${name}`, async () => {
      const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

      await expect(call(caller)).resolves.toBeDefined();
    });
  }
});

describe('rewardConfig.get', () => {
  it('returns the stored row beside what the grant path resolved', async () => {
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    const result = await caller.get();

    expect(result.stored).toMatchObject({ value: { rewards: {} }, malformed: false });
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards[0]).toMatchObject({ type: 'testReward', rejected: [] });
  });

  // 🔴 `resolveRewardConfig` memoises per pod for a minute and only the pod that
  // served a write clears it, so an operator screen resolving through it reports a
  // stale answer on ~99 pods out of 100. Both halves of the response come from the
  // one row this call read.
  it('resolves the rewards from the row it just read', async () => {
    mockGetStored.mockResolvedValue(
      storedView({ rewards: { testReward: { enabled: false } } }) as never
    );
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    const result = await caller.get();

    expect(result.rewards[0].effective.enabled).toBe(false);
    expect(mockDescribeConfig).toHaveBeenCalledWith({
      testReward: { override: { enabled: false }, rejected: [] },
    });
  });
});

describe('rewardConfig.set', () => {
  it('rejects an out-of-bounds override before it reaches the service', async () => {
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    await expect(
      caller.set({ rewards: { testReward: { awardAmount: 999_999 } } })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  // A base-procedure middleware adds `browsingLevel` to every input, and it must
  // not end up in the stored row: `set` has replace semantics, so junk written
  // now is junk an editor reads back and saves again later.
  it('passes the row through without the middleware-injected fields', async () => {
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    await caller.set({ rewards: { testReward: { enabled: false, awardAmount: 4 } } });

    expect(mockSetConfig).toHaveBeenCalledWith(
      { rewards: { testReward: { enabled: false, awardAmount: 4 } } },
      1,
      { expectedHash: undefined, force: undefined }
    );
  });

  // Dropping either on the way through disables a guard while every other test
  // here still passes — the write succeeds, it just stops being checked.
  it('forwards both guards to the service', async () => {
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    await caller.set({ rewards: {}, expectedHash: 'abc123', force: true });

    expect(mockSetConfig).toHaveBeenCalledWith({ rewards: {} }, 1, {
      expectedHash: 'abc123',
      force: true,
    });
  });

  // 🔴 The response is built from the value just WRITTEN. Re-reading here instead
  // reaches `dbRead` — the replica — and under lag hands back the pre-write row,
  // which is the "my save did nothing" bug again with a fresh cause. The stored
  // row is deliberately left saying the opposite of what is written.
  it('answers from what it wrote, never from a read', async () => {
    mockGetStored.mockResolvedValue(
      storedView({ rewards: { testReward: { enabled: false } } }) as never
    );
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    const result = await caller.set({ rewards: { testReward: { enabled: true } } });

    expect(result.rewards[0].effective.enabled).toBe(true);
    expect(result.stored.value).toEqual({ rewards: { testReward: { enabled: true } } });
    expect(mockGetStored).not.toHaveBeenCalled();
  });

  // The panel sends this straight back as `expectedHash` on the next save. The
  // hash of the row that was LOADED describes a row that no longer exists, and
  // the operator's next save is refused as someone else's edit.
  it('hashes what it wrote, not what was loaded', async () => {
    mockGetStored.mockResolvedValue(
      storedView({ rewards: { testReward: { enabled: false } } }) as never
    );
    const caller = rewardConfigRouter.createCaller(fakeCtx(mod) as never);

    const result = await caller.set({ rewards: { testReward: { enabled: true } } });

    expect(result.stored.hash).toEqual(
      storedViewOf({ rewards: { testReward: { enabled: true } } }).hash
    );
    expect(result.stored.hash).not.toEqual('hash-of-loaded-row');
  });
});
