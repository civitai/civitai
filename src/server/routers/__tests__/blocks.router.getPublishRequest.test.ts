import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * REVIEW PAGE single-request read (PR #3298) — auth-surface coverage for the
 * `blocks.getPublishRequest` proc through the REAL router (the modal→page
 * migration's server entry point for `/apps/review/<publishRequestId>`).
 *
 * The proc stacks: `moderatorProcedure` (isAuthed → isMod) + `enforceAppBlocksFlag`
 * + an in-handler `ctx.user?.isModerator` belt, then delegates to
 * `getReviewRequestById` and maps a null result → NOT_FOUND (fail-closed;
 * never leaks missing-vs-withdrawn). We prove, against the real middleware stack:
 *   - a NON-moderator caller → rejected (FORBIDDEN, from `isMod`); service NOT reached.
 *   - an ANONYMOUS caller → rejected (UNAUTHORIZED, from `isAuthed`); service NOT reached.
 *   - a moderator (flag on) → reaches `getReviewRequestById(id)` and returns its result.
 *   - a moderator, service returns null (missing / withdrawn / superseded) → NOT_FOUND.
 *   - HONEST flag-off note: `getPublishRequest` is a QUERY, and `enforceAppBlocksFlag`
 *     deliberately does NOT throw on a query when the flag is off — it passes through
 *     (fail-open-EMPTY, `_appBlocksDisabled`). So for THIS read the moderator gate,
 *     not the visibility flag, is the real guard: a mod with the flag off still
 *     reaches the service. We assert that real behavior rather than a flag-off
 *     rejection that queries never perform. (The mod segment of the live flag
 *     resolves true for mods anyway, so no non-mod ever benefits from this.)
 *
 * Mock surface mirrors blocks.router.agentReview.test.ts so importing the router
 * doesn't drag in the generated Prisma client.
 */

const {
  mockIsAppBlocksEnabled,
  mockIsReviewSandboxEnabled,
  mockIsAgenticEnabled,
  mockGetReviewRequestById,
  mockPreviewRequest,
  mockGetReviewStatus,
  mockMintReviewBlockToken,
  mockTeardownPreview,
  mockListActivePreviews,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockRedis,
  mockSysRedis,
  mockDbRead,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsReviewSandboxEnabled: vi.fn(),
  mockIsAgenticEnabled: vi.fn(),
  mockGetReviewRequestById: vi.fn(),
  mockPreviewRequest: vi.fn(),
  mockGetReviewStatus: vi.fn(),
  mockMintReviewBlockToken: vi.fn(),
  mockTeardownPreview: vi.fn(),
  mockListActivePreviews: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockRedis: { get: vi.fn(), set: vi.fn() },
  mockSysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    appBlockPublishRequest: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksReviewSandboxEnabled: mockIsReviewSandboxEnabled,
  isAppBlocksAgenticReviewEnabled: mockIsAgenticEnabled,
}));
// getPublishRequest dynamically imports getReviewRequestById from this module.
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  getReviewRequestById: mockGetReviewRequestById,
  previewRequest: mockPreviewRequest,
  getReviewStatus: mockGetReviewStatus,
  mintReviewBlockToken: mockMintReviewBlockToken,
  teardownPreview: mockTeardownPreview,
  listActiveReviewPreviews: mockListActivePreviews,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
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
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
  return { ...actual, redis: mockRedis, sysRedis: mockSysRedis };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The app-blocks visibility flag resolves true for a moderator subject on the
// live `app-blocks-enabled` flag (its `moderators` segment) — model that so the
// mod path is exercised as it runs in prod.
function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };
const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

// The hydrated shape getReviewRequestById returns: { mode, request }, where
// `request` carries the fields OnsiteReviewModalBody consumes on the page.
const HYDRATED = {
  mode: 'pending' as const,
  request: {
    id: PUBREQ,
    slug: 'my-app',
    version: '1.0.0',
    approvalNotes: null,
    rejectionReason: null,
    reviewRepoUrl: 'https://forgejo.example/review/my-app',
    pushCommitUrl: null,
  },
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockGetReviewRequestById.mockReset();
  mockGetReviewRequestById.mockResolvedValue(HYDRATED);
});

describe('blocks.getPublishRequest — mod-only review-page read', () => {
  it('moderator + flag on: reaches getReviewRequestById(id) and returns the hydrated { mode, request }', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getPublishRequest({ publishRequestId: PUBREQ });
    expect(mockGetReviewRequestById).toHaveBeenCalledWith(PUBREQ);
    expect(res.mode).toBe('pending');
    expect(res.request).toMatchObject({ id: PUBREQ, slug: 'my-app' });
  });

  it('non-moderator: rejected (FORBIDDEN from isMod), service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(
      caller.getPublishRequest({ publishRequestId: PUBREQ })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetReviewRequestById).not.toHaveBeenCalled();
  });

  it('anonymous: rejected (UNAUTHORIZED from isAuthed), service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(
      caller.getPublishRequest({ publishRequestId: PUBREQ })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockGetReviewRequestById).not.toHaveBeenCalled();
  });

  it('moderator, service returns null (missing/withdrawn/superseded): NOT_FOUND (fail-closed, no leak of which)', async () => {
    mockGetReviewRequestById.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.getPublishRequest({ publishRequestId: PUBREQ })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetReviewRequestById).toHaveBeenCalledWith(PUBREQ);
  });

  it('any rejection is a TRPCError (structured tRPC error, never a raw 500 leak)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(
      caller.getPublishRequest({ publishRequestId: PUBREQ })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  // HONEST flag-off behavior: enforceAppBlocksFlag is fail-open-EMPTY on queries
  // (it returns next({ _appBlocksDisabled }) instead of throwing for type==='query').
  // So a moderator with the visibility flag fully OFF still reaches the service —
  // the moderator gate, not the flag, is what protects this read. We lock that in
  // rather than asserting a flag-off rejection queries never perform.
  it('moderator + app-blocks flag OFF (query fail-open-empty): NOT blocked by the flag — mod gate still reaches the service', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getPublishRequest({ publishRequestId: PUBREQ });
    expect(mockGetReviewRequestById).toHaveBeenCalledWith(PUBREQ);
    expect(res.mode).toBe('pending');
  });
});
