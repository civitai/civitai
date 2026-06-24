import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-E marketplace REVIEWS — `blocks.upsertReview` router coverage.
 *
 * Pins the MONEY-TOUCHING wiring at the boundary (the gates themselves are
 * covered exhaustively in appBlockReview.service.test.ts; the reward in
 * appBlockReview.reward.test.ts):
 *   - DARK: the appBlocks flag is the gate. A non-mod without the flag → the
 *     mutation throws UNAUTHORIZED, the service is NEVER consulted, the reward
 *     NEVER fires.
 *   - REWARD fires ONLY on the create branch (isFirstReview=true).
 *   - REWARD does NOT fire on an update (isFirstReview=false).
 *   - FAIL-SOFT: a reward throw does NOT fail the review mutation (the review
 *     write already committed).
 */

const { mockIsAppBlocksEnabled, mockUpsert, mockRewardApply } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockUpsert: vi.fn(),
  mockRewardApply: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/appBlockReview.service', () => ({
  upsertAppBlockReview: (...a: unknown[]) => mockUpsert(...a),
  listAppBlockReviews: vi.fn(),
  getMyAppBlockReview: vi.fn(),
  setAppReviewExcluded: vi.fn(),
}));
vi.mock('~/server/rewards/active/appBlockReview.reward', () => ({
  appBlockReviewReward: { apply: (...a: unknown[]) => mockRewardApply(...a) },
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    getAppDetail: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: vi.fn() } },
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(), set: vi.fn() },
  sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  REDIS_KEYS: { BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } },
  REDIS_SYS_KEYS: { BLOCKS: { BUZZ_CAP: 'system:blocks:buzz-cap' } },
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

// guardedProcedure = protected + onboarded + not-muted. onboarding=255 sets all
// steps (incl. Buzz); muted:false; not banned/deleted.
const modUser = {
  id: 1,
  isModerator: true,
  tier: 'free',
  username: 'mod',
  onboarding: 255,
  muted: false,
};

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '1.2.3.4',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset().mockImplementation(fakePerUserFlag);
  mockUpsert.mockReset();
  mockRewardApply.mockReset().mockResolvedValue(undefined);
});

const input = { appBlockId: 'ab_1', rating: 5 };

describe('blocks.upsertReview — dark behind the flag + reward wiring', () => {
  it('DARK: a non-mod without the flag → UNAUTHORIZED, service + reward NOT called', async () => {
    const nonMod = { ...modUser, id: 2, isModerator: false };
    const caller = blocksRouter.createCaller(fakeCtx(nonMod) as never);
    await expect(caller.upsertReview(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRewardApply).not.toHaveBeenCalled();
  });

  it('CREATE branch fires the blue-buzz reward exactly once (isFirstReview=true)', async () => {
    mockUpsert.mockResolvedValue({
      review: { id: 1, appBlockId: 'ab_1', rating: 5, recommended: true },
      isFirstReview: true,
    });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.upsertReview(input);
    expect(res.isFirstReview).toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockRewardApply).toHaveBeenCalledTimes(1);
    expect(mockRewardApply).toHaveBeenCalledWith(
      { appBlockId: 'ab_1', userId: 1, isFirstReview: true },
      { ip: '1.2.3.4' }
    );
  });

  it('UPDATE branch does NOT fire the reward (isFirstReview=false)', async () => {
    mockUpsert.mockResolvedValue({
      review: { id: 1, appBlockId: 'ab_1', rating: 4, recommended: true },
      isFirstReview: false,
    });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.upsertReview({ appBlockId: 'ab_1', rating: 4 });
    expect(res.isFirstReview).toBe(false);
    expect(mockRewardApply).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a reward throw does NOT fail the review mutation', async () => {
    mockUpsert.mockResolvedValue({
      review: { id: 1, appBlockId: 'ab_1', rating: 5, recommended: true },
      isFirstReview: true,
    });
    mockRewardApply.mockRejectedValue(new Error('ClickHouse brownout'));
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    // Resolves (review committed) despite the reward throwing.
    await expect(caller.upsertReview(input)).resolves.toMatchObject({ isFirstReview: true });
  });
});
