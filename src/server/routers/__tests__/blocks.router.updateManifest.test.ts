import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App management (Phase 1) — `blocks.updateManifest` router coverage.
 * Drives the REAL blocks router so the middleware chain (`protectedProcedure`
 * → isAuthed, `enforceAppBlocksFlag`) + the owner / approved / immutability /
 * validation gates decide the outcome. The Forgejo commit, the validator, and
 * the pending-review recorder are mocked at the module boundary so this suite
 * exercises the GATES + the server-derived commit, not the downstream services.
 *
 * GATING / SAFETY INVARIANTS pinned here (each FAILS if its gate is dropped):
 *   - anon → UNAUTHORIZED; nothing committed.
 *   - non-owner → FORBIDDEN; nothing committed.
 *   - owner, app NOT approved → PRECONDITION_FAILED; nothing committed.
 *   - invalid manifest (validator reject) → BAD_REQUEST; nothing committed.
 *   - version not strictly greater → BAD_REQUEST; nothing committed.
 *   - owner + valid → commitFiles called with the SERVER-derived slug + the
 *     merged manifest (blockId forced to the slug), then recordPendingFromPush
 *     records a PENDING review (no auto-approve / no deploy).
 *   - immutable blockId: even if the merged manifest's stored blockId differs
 *     from the slug, the committed manifest carries the SLUG.
 */

const {
  mockIsAppBlocksEnabled,
  mockCommitFiles,
  mockRecordPending,
  mockValidate,
  mockStamp,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockCommitFiles: vi.fn(),
  mockRecordPending: vi.fn(),
  mockValidate: vi.fn(),
  mockStamp: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/env/server', () => ({
  env: { FORGEJO_PUBLIC_URL: 'https://forgejo.civitai.com', APPS_DOMAIN: 'civit.ai', LOGGING: '' },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  commitFiles: mockCommitFiles,
  addCollaborator: vi.fn(),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  recordPendingFromPush: mockRecordPending,
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: mockValidate },
}));
vi.mock('~/server/services/blocks/manifest-normalize', () => ({
  stampCanonicalIframeSrc: mockStamp,
}));
// publish-request.schema is a pure module (regexes + zod schemas) — use the
// REAL one so the router's static imports (withdrawRequestSchema, etc.) resolve
// and SEMVER_REGEX is the canonical pattern.

// --- the rest of the router's static import graph (stubbed, as in getMyAppRepo) ---
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
  dbRead: { appBlock: { findUnique: vi.fn() } },
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

const approvedBlock = {
  id: 'ab_1',
  blockId: 'my-app',
  status: 'approved',
  version: '1.0.0',
  manifest: { blockId: 'my-app', version: '1.0.0', name: 'My App', scopes: ['models:read:self'] },
  app: { userId: ownerUser.id, allowedScopes: 1, allowedOrigins: ['https://my-app.civit.ai'] },
};

const validPatch = { version: '1.0.1', name: 'My App v2', contentRating: 'g', scopes: [] as string[] };

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset().mockResolvedValue(true);
  mockCommitFiles.mockReset().mockResolvedValue({ sha: 'a'.repeat(40) });
  mockRecordPending.mockReset().mockResolvedValue({ publishRequestId: 'pubreq_x' });
  mockValidate.mockReset().mockReturnValue({ valid: true });
  mockStamp.mockReset().mockImplementation((m: Record<string, unknown>) => m);
  findUnique.mockReset();
});

describe('blocks.updateManifest — Phase 1 web manifest editor', () => {
  it('anon: UNAUTHORIZED, nothing committed', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockRecordPending).not.toHaveBeenCalled();
  });

  it('non-owner: FORBIDDEN, nothing committed', async () => {
    findUnique.mockResolvedValue(approvedBlock);
    const caller = blocksRouter.createCaller(fakeCtx(otherUser) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('owner but block missing: NOT_FOUND', async () => {
    findUnique.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'nope', patch: validPatch })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('owner, app NOT approved: PRECONDITION_FAILED, nothing committed', async () => {
    findUnique.mockResolvedValue({ ...approvedBlock, status: 'pending' });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('version not strictly greater: BAD_REQUEST, nothing committed', async () => {
    findUnique.mockResolvedValue(approvedBlock);
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'ab_1', patch: { ...validPatch, version: '1.0.0' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('invalid manifest (validator reject) → BAD_REQUEST, nothing committed', async () => {
    findUnique.mockResolvedValue(approvedBlock);
    mockValidate.mockReturnValue({ valid: false, errors: ['scope "x" is not a known block scope'] });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockRecordPending).not.toHaveBeenCalled();
  });

  it('over-scope manifest is rejected via the SERVER validator (scope-subset gate runs)', async () => {
    findUnique.mockResolvedValue(approvedBlock);
    mockValidate.mockReturnValue({
      valid: false,
      errors: ['requested scopes exceed OAuth client allowedScopes: models:write:self'],
    });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({
        appBlockId: 'ab_1',
        patch: { ...validPatch, scopes: ['models:write:self'] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // The validator was called with the app's OauthClient context (the
    // allowedScopes bitmask + allowedOrigins), i.e. the subset check actually ran.
    expect(mockValidate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ allowedScopes: 1, allowedOrigins: ['https://my-app.civit.ai'] })
    );
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('owner + valid: commits server-derived slug + merged manifest, records a PENDING review', async () => {
    findUnique.mockResolvedValue(approvedBlock);
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const res = await caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch });

    expect(res.status).toBe('pending');
    expect(res.slug).toBe('my-app');
    expect(res.version).toBe('1.0.1');
    expect(res.publishRequestId).toBe('pubreq_x');

    // Committed to the canonical org + the SERVER-derived slug, only the manifest
    // file, with the new version baked in.
    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    const commitArg = mockCommitFiles.mock.calls[0][0];
    expect(commitArg.org).toBe('civitai-apps');
    expect(commitArg.slug).toBe('my-app');
    expect(commitArg.files).toHaveLength(1);
    expect(commitArg.files[0].path).toBe('block.manifest.json');
    const committed = JSON.parse(commitArg.files[0].content.toString('utf8'));
    expect(committed.version).toBe('1.0.1');
    expect(committed.name).toBe('My App v2');

    // PENDING review recorded (no auto-approve / no deploy) with the commit sha.
    expect(mockRecordPending).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-app', sha: 'a'.repeat(40), appBlockId: 'ab_1', version: '1.0.1' })
    );
  });

  it('immutable blockId: the committed manifest carries the SLUG even if the stored manifest blockId drifted', async () => {
    // Stored manifest has a stale/wrong blockId; the slug (block.blockId) is the
    // source of truth and must win in the committed manifest.
    findUnique.mockResolvedValue({
      ...approvedBlock,
      manifest: { ...approvedBlock.manifest, blockId: 'WRONG-old-slug' },
    });
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await caller.updateManifest({ appBlockId: 'ab_1', patch: validPatch });

    const commitArg = mockCommitFiles.mock.calls[0][0];
    const committed = JSON.parse(commitArg.files[0].content.toString('utf8'));
    expect(committed.blockId).toBe('my-app');
    // And the validator saw the slug-forced manifest too.
    const validated = mockValidate.mock.calls[0][0] as { blockId: string };
    expect(validated.blockId).toBe('my-app');
  });
});
