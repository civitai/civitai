import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 3 (git-push self-service) — `blocks.getMyAppRepo` router coverage.
 * Drives the REAL blocks router so the middleware chain (`protectedProcedure`
 * → isAuthed, `enforceAppBlocksFlag`) + the owner gate decide the outcome; the
 * dev-git-access + forgejo services are mocked at the module boundary so this
 * suite exercises the GATE + URL assembly, not the provisioning service (which
 * has its own test).
 *
 * GATING INVARIANTS pinned here (each FAILS if the gate is dropped):
 *   - anon → UNAUTHORIZED, nothing provisioned.
 *   - non-owner (logged in) → FORBIDDEN, nothing provisioned.
 *   - owner, app NOT approved → `notYetAvailable` shape, nothing provisioned.
 *   - owner, app approved → provisions an identity, grants `write` on the
 *     slug's repo, returns a clone URL carrying the username + token.
 */

const { mockIsAppBlocksEnabled, mockEnsureForgejoIdentity, mockAddCollaborator } = vi.hoisted(
  () => ({
    mockIsAppBlocksEnabled: vi.fn(),
    mockEnsureForgejoIdentity: vi.fn(),
    mockAddCollaborator: vi.fn(),
  })
);

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/env/server', () => ({
  // LOGGING is read by cache-helpers' createLogger at module-eval (the router
  // now statically imports appBlockReview.service, which imports cache-helpers).
  // MEILI_CALL_CONCURRENCY is read by meilisearch/client at module-eval
  // (reached via the router's transitive imports) — pLimit() throws on undefined.
  env: { FORGEJO_PUBLIC_URL: 'https://forgejo.civitai.com', LOGGING: '', MEILI_CALL_CONCURRENCY: 50 },
}));
vi.mock('~/server/services/blocks/dev-git-access.service', () => ({
  ensureForgejoIdentity: mockEnsureForgejoIdentity,
}));
// FORGEJO_ORG is imported statically by the router; addCollaborator is reached
// via the router's dynamic import — both come from this mock.
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
  dbWrite: {},
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn() },
    sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
// F-E marketplace reviews — the router now statically imports these; stub them
// so this test stays isolated (it exercises getMyAppRepo, not reviews).
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

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockResolvedValue(true); // flag lit for all these tests
  mockEnsureForgejoIdentity.mockReset();
  mockEnsureForgejoIdentity.mockResolvedValue({
    forgejoUsername: 'dev-7',
    token: 'minted-token-sha1',
  });
  mockAddCollaborator.mockReset();
  mockAddCollaborator.mockResolvedValue(undefined);
  findUnique.mockReset();
});

describe('blocks.getMyAppRepo — Phase 3 git-push credential', () => {
  it('anon (no session): UNAUTHORIZED, nothing provisioned', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMyAppRepo({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
    expect(mockAddCollaborator).not.toHaveBeenCalled();
  });

  it('non-owner: FORBIDDEN, nothing provisioned', async () => {
    findUnique.mockResolvedValue({
      blockId: 'my-app',
      status: 'approved',
      app: { userId: ownerUser.id },
    });
    const caller = blocksRouter.createCaller(fakeCtx(otherUser) as never);
    await expect(caller.getMyAppRepo({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
    expect(mockAddCollaborator).not.toHaveBeenCalled();
  });

  it('owner but block missing: NOT_FOUND', async () => {
    findUnique.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(caller.getMyAppRepo({ appBlockId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('owner, app NOT approved: returns the notYetAvailable shape, nothing provisioned', async () => {
    findUnique.mockResolvedValue({
      blockId: 'my-app',
      status: 'pending',
      app: { userId: ownerUser.id },
    });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const result = await caller.getMyAppRepo({ appBlockId: 'ab_1' });
    expect(result.notYetAvailable).toBe(true);
    expect(result.firstVersionIsZip).toBe(true);
    expect(result.slug).toBe('my-app');
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
    expect(mockAddCollaborator).not.toHaveBeenCalled();
  });

  it('banned owner: FORBIDDEN, nothing provisioned (no credential issued to a banned account)', async () => {
    findUnique.mockResolvedValue({
      blockId: 'my-app',
      status: 'approved',
      app: { userId: ownerUser.id },
    });
    const bannedOwner = { ...ownerUser, bannedAt: new Date() };
    const caller = blocksRouter.createCaller(fakeCtx(bannedOwner) as never);
    await expect(caller.getMyAppRepo({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockEnsureForgejoIdentity).not.toHaveBeenCalled();
    expect(mockAddCollaborator).not.toHaveBeenCalled();
  });

  it('owner, app approved: provisions identity, grants write on the slug repo, returns the clone URL with creds', async () => {
    findUnique.mockResolvedValue({
      blockId: 'my-app',
      status: 'approved',
      app: { userId: ownerUser.id },
    });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const result = await caller.getMyAppRepo({ appBlockId: 'ab_1' });

    expect(result.notYetAvailable).toBe(false);
    expect(result.slug).toBe('my-app');
    expect(result.forgejoUsername).toBe('dev-7');

    // Provisioned the caller's identity (not anyone else's).
    expect(mockEnsureForgejoIdentity).toHaveBeenCalledWith(7);
    // Granted WRITE on this slug's repo.
    expect(mockAddCollaborator).toHaveBeenCalledWith({
      slug: 'my-app',
      username: 'dev-7',
      permission: 'write',
    });

    // Public (no-cred) URL + credentialed clone URL.
    expect(result.httpUrl).toBe('https://forgejo.civitai.com/civitai-apps/my-app.git');
    expect(result.cloneUrl).toBe(
      'https://dev-7:minted-token-sha1@forgejo.civitai.com/civitai-apps/my-app.git'
    );
    // Instructions carry the credentialed clone + the no-trust-on-push notice.
    expect(result.instructions).toContain(result.cloneUrl);
    expect(result.instructions).toMatch(/moderator approves/i);
  });
});
