import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App management (Phase 2) — `blocks.getMyForgejoCloneInfo` router coverage.
 * Backs the read-only `civitai app pull` CLI command. Owner-gated identically to
 * getMyAppRepo; lazily provisions the per-user Forgejo identity + grants READ on
 * the slug repo, and returns the tokened clone URL the CLI assembles its git
 * command from.
 *
 * GATING INVARIANTS pinned here:
 *   - anon → UNAUTHORIZED; nothing provisioned.
 *   - non-owner → FORBIDDEN; nothing provisioned.
 *   - owner, NOT approved → notYetAvailable; nothing provisioned.
 *   - owner, approved (by slug) → provisions identity, grants READ, returns the
 *     tokened cloneUrl + the raw token.
 */

const { mockIsAppBlocksEnabled, mockEnsureForgejoIdentity, mockAddCollaborator } = vi.hoisted(
  () => ({
    mockIsAppBlocksEnabled: vi.fn(),
    mockEnsureForgejoIdentity: vi.fn(),
    mockAddCollaborator: vi.fn(),
  })
);

vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: mockIsAppBlocksEnabled }));
vi.mock('~/env/server', () => ({
  env: { FORGEJO_PUBLIC_URL: 'https://forgejo.civitai.com', APPS_DOMAIN: 'civit.ai', LOGGING: '' },
}));
vi.mock('~/server/services/blocks/dev-git-access.service', () => ({
  ensureForgejoIdentity: mockEnsureForgejoIdentity,
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  addCollaborator: mockAddCollaborator,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    getAppDetail: vi.fn(),
    getFeaturedBlocks: vi.fn(),
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
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: vi.fn(), findFirst: vi.fn() } },
  dbWrite: {},
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
vi.mock('~/server/rewards/active/appBlockReview.reward', () => ({
  appBlockReviewReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/appBlockReview.service', () => ({
  upsertAppBlockReview: vi.fn(),
  listAppBlockReviews: vi.fn(),
  getMyAppBlockReview: vi.fn(),
  setAppReviewExcluded: vi.fn(),
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
import { dbRead } from '~/server/db/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: true } as never,
    track: undefined,
  };
}

const ownerUser = { id: 7, isModerator: false, tier: 'free', username: 'owner' };
const otherUser = { id: 99, isModerator: false, tier: 'free', username: 'intruder' };

const findUnique = dbRead.appBlock.findUnique as ReturnType<typeof vi.fn>;
const findFirst = dbRead.appBlock.findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset().mockResolvedValue(true);
  mockEnsureForgejoIdentity
    .mockReset()
    .mockResolvedValue({ forgejoUsername: 'dev-7', token: 'minted-token-sha1' });
  mockAddCollaborator.mockReset().mockResolvedValue(undefined);
  findUnique.mockReset();
  findFirst.mockReset();
});

describe('blocks.getMyForgejoCloneInfo — Phase 2 CLI pull credential', () => {
  it('anon: UNAUTHORIZED, nothing provisioned', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMyForgejoCloneInfo({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
  });

  it('non-owner: FORBIDDEN, nothing provisioned', async () => {
    findUnique.mockResolvedValue({ blockId: 'my-app', status: 'approved', app: { userId: ownerUser.id } });
    const caller = blocksRouter.createCaller(fakeCtx(otherUser) as never);
    await expect(caller.getMyForgejoCloneInfo({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
  });

  it('owner, NOT approved: notYetAvailable, nothing provisioned', async () => {
    findUnique.mockResolvedValue({ blockId: 'my-app', status: 'pending', app: { userId: ownerUser.id } });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const res = await caller.getMyForgejoCloneInfo({ appBlockId: 'ab_1' });
    expect(res.notYetAvailable).toBe(true);
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
  });

  it('owner, approved, BY SLUG: provisions identity, grants READ, returns tokened cloneUrl + token', async () => {
    findFirst.mockResolvedValue({ blockId: 'my-app', status: 'approved', app: { userId: ownerUser.id } });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const res = await caller.getMyForgejoCloneInfo({ slug: 'my-app' });

    expect(res.notYetAvailable).toBe(false);
    expect(res.slug).toBe('my-app');
    expect(res.forgejoUsername).toBe('dev-7');
    expect(res.token).toBe('minted-token-sha1');
    expect(mockEnsureForgejoIdentity).toHaveBeenCalledWith(7);
    // READ (not write) is enough to pull.
    expect(mockAddCollaborator).toHaveBeenCalledWith({
      slug: 'my-app',
      username: 'dev-7',
      permission: 'read',
    });
    expect(res.httpUrl).toBe('https://forgejo.civitai.com/civitai-apps/my-app.git');
    expect(res.cloneUrl).toBe(
      'https://dev-7:minted-token-sha1@forgejo.civitai.com/civitai-apps/my-app.git'
    );
  });

  it('neither appBlockId nor slug: input validation error (BAD_REQUEST)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(caller.getMyForgejoCloneInfo({} as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
