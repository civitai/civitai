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

const { mockGetStored, mockSetConfig, mockDescribeConfig } = vi.hoisted(() => ({
  mockGetStored: vi.fn(async () => ({ rewards: {} })),
  mockSetConfig: vi.fn(async (config: unknown) => config),
  mockDescribeConfig: vi.fn(async () => ({
    type: 'testReward',
    visible: true,
    onDemand: true,
    capOverridable: true,
    defaults: { awardAmount: 10, cap: 30 },
    effective: { enabled: true, awardAmount: 10, cap: 30 },
    rejected: [] as string[],
  })),
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

    expect(result.stored).toEqual({ rewards: {} });
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards[0]).toMatchObject({ type: 'testReward', rejected: [] });
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
});
