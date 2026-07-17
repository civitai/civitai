import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.updateManifest` — per-scope justification ENFORCEMENT at the router
 * boundary. Unlike the sibling `blocks.router.updateManifest.test.ts` (which
 * MOCKS BlockManifestValidator to isolate the gates), this suite drives the
 * router with the REAL validator + the REAL iframe.src stamper, so the
 * `scopeJustifications` rules actually run through the mutation. This locks the
 * enforcement: a future refactor that narrows or drops the validator call fails
 * the bad-key case here (zod's input schema does NOT check key-in-scopes).
 *
 * Base manifest is otherwise FULLY VALID (passes the real validator), so a
 * rejection is attributable to the justification rule under test — proven by the
 * "valid justification commits" control.
 */

const { mockIsAppBlocksEnabled, mockCommitFiles, mockRecordPending } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockCommitFiles: vi.fn(),
  mockRecordPending: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
// env comes from the global ~/env/server mock in src/__tests__/setup.ts
// (APPS_DOMAIN='civit.ai', so the canonical iframe.src stamp lands on
// https://my-app.civit.ai/ — matching the app's allowedOrigins below).
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  commitFiles: mockCommitFiles,
  addCollaborator: vi.fn(),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  recordPendingFromPush: mockRecordPending,
}));
// NOTE: `block-manifest-validator.service` + `manifest-normalize` are DELIBERATELY
// NOT mocked here — the real validator/stamper run so the justification rules
// (and the canonical iframe.src stamp) are exercised end-to-end.

// --- the rest of the router's static import graph (stubbed, as in the sibling
// updateManifest suite) so the router module imports cleanly ---
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
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn() },
    sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  };
});
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

const findUnique = dbRead.appBlock.findUnique as ReturnType<typeof vi.fn>;

// A stored manifest that is FULLY VALID under the real validator (iframe block,
// contentRating, a single OAuth-eligible scope). The app's allowedScopes cover
// that scope and allowedOrigins cover the canonical per-app subdomain the
// stamper writes (https://my-app.civit.ai/).
const approvedBlock = {
  id: 'ab_1',
  blockId: 'my-app',
  status: 'approved',
  version: '1.0.0',
  trustTier: 'unverified',
  manifest: {
    blockId: 'my-app',
    version: '1.0.0',
    name: 'My App',
    contentRating: 'g',
    renderMode: 'iframe',
    trustTier: 'unverified',
    scopes: ['models:read:self'],
    iframe: {
      src: 'https://my-app.civit.ai/',
      minHeight: 200,
      maxHeight: null,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  app: {
    userId: ownerUser.id,
    allowedScopes: TokenScope.ModelsRead,
    allowedOrigins: ['https://my-app.civit.ai'],
  },
};

// Base patch: keeps the manifest valid (scopes unchanged), bumps the version.
const basePatch = {
  version: '1.0.1',
  name: 'My App v2',
  contentRating: 'g',
  scopes: ['models:read:self'],
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset().mockResolvedValue(true);
  mockCommitFiles.mockReset().mockResolvedValue({ sha: 'a'.repeat(40) });
  mockRecordPending.mockReset().mockResolvedValue({ publishRequestId: 'pubreq_x' });
  findUnique.mockReset().mockResolvedValue(approvedBlock);
});

describe('blocks.updateManifest — scopeJustifications enforcement (real validator)', () => {
  it('CONTROL: a valid justification (declared scope, ≤500 chars) commits + records a PENDING review', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    const res = await caller.updateManifest({
      appBlockId: 'ab_1',
      patch: {
        ...basePatch,
        scopeJustifications: { 'models:read:self': 'We render the page model in a widget.' },
      },
    });

    expect(res.status).toBe('pending');
    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    // The justification survives into the committed manifest bytes (so the mod
    // sees it).
    const committed = JSON.parse(mockCommitFiles.mock.calls[0][0].files[0].content.toString('utf8'));
    expect(committed.scopeJustifications).toEqual({
      'models:read:self': 'We render the page model in a widget.',
    });
    expect(mockRecordPending).toHaveBeenCalledTimes(1);
  });

  it('rejects a justification whose key is NOT one of the manifest scopes (validator-only rule → BAD_REQUEST, nothing committed)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({
        appBlockId: 'ab_1',
        patch: {
          ...basePatch,
          // scopes is ['models:read:self']; user:read:self is a real scope but
          // NOT requested here — the validator must reject the dangling rationale.
          scopeJustifications: { 'user:read:self': 'we do not even request this' },
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockRecordPending).not.toHaveBeenCalled();
  });

  it('surfaces the specific validator error for an undeclared-scope justification', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({
        appBlockId: 'ab_1',
        patch: {
          ...basePatch,
          scopeJustifications: { 'user:read:self': 'nope' },
        },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not in the manifest'),
    });
  });

  it('rejects an oversized (>500-char) justification value → BAD_REQUEST, nothing committed', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({
        appBlockId: 'ab_1',
        patch: {
          ...basePatch,
          scopeJustifications: { 'models:read:self': 'a'.repeat(501) },
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockRecordPending).not.toHaveBeenCalled();
  });

  it('rejects an empty-string justification value (validator-only: zod permits it, the validator does not)', async () => {
    // z.string().max(500) accepts '' (no min), so this reaches the validator —
    // which requires a NON-EMPTY string. Locks the validator specifically.
    const caller = blocksRouter.createCaller(fakeCtx(ownerUser) as never);
    await expect(
      caller.updateManifest({
        appBlockId: 'ab_1',
        patch: {
          ...basePatch,
          scopeJustifications: { 'models:read:self': '' },
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });
});
