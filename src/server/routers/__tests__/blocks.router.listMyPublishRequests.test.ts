import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 P4 — `blocks.listMyPublishRequests` OWNER-control augmentation.
 *
 * Asserts the ROUTER query now carries, per publish-request row: the backing
 * on-site `AppListing.id` + its TRUE lifecycle `status` (distinct from the request
 * status), the last moderation action for a REMOVED listing (owner-hidden vs
 * mod-removed), and `hasPage` (does the manifest declare a launch page). Also pins
 * the BATCHED shape — ONE `appListing.findMany` + ONE `appListingModerationEvent
 * .findMany` for the whole page, NOT an N+1 per row.
 *
 * Same heavy-mock skeleton as `blocks.router.getMyAppAnalytics.test.ts` (services
 * stubbed so importing the router doesn't drag in the generated Prisma client);
 * `getFeatureFlags` is mocked so the `appDeveloperProcedure` author gate passes.
 */

const { mockIsAppBlocksEnabled, mockDbRead } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockDbRead: {
    appBlockPublishRequest: { findMany: vi.fn() },
    appListing: { findMany: vi.fn() },
    appListingModerationEvent: { findMany: vi.fn() },
    blockUserSubscription: { groupBy: vi.fn() },
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/services/feature-flags.service')>()),
  getFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true, appBlocksPages: false }),
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
  dbRead: mockDbRead,
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
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
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

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: true, appBlocksAuthor: true } as never,
    track: undefined,
  };
}

const owner = { id: 7, isModerator: false, tier: 'free', username: 'owner' };

/** A page-app manifest (declares a launch page → hasPage true). */
const PAGE_MANIFEST = { name: 'App', page: { path: '/' } };
/** A model-slot manifest (no page → hasPage false). */
const SLOT_MANIFEST = { name: 'App', targets: ['model.sidebar_top'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockDbRead.blockUserSubscription.groupBy.mockResolvedValue([]);
  mockDbRead.appListing.findMany.mockResolvedValue([]);
  mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([]);
});

describe('listMyPublishRequests — P4 owner-control augmentation', () => {
  it('carries the backing listing id + TRUE status + hasPage; a LIVE (approved) listing has no last action', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-1',
        appBlockId: null,
        slug: 'live-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: new Date('2026-01-02'),
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-a', manifest: PAGE_MANIFEST, _count: { userSubscriptions: 4 } },
      },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { id: 'l-a', appBlockId: 'block-a', status: 'approved' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appListingId: 'l-a',
      listingStatus: 'approved',
      lastModerationAction: null,
      hasPage: true,
    });
    // Approved (live) listing → NO moderation-action lookup (only removed listings).
    expect(mockDbRead.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });

  it('a REMOVED listing carries its last moderation action (owner-hidden vs mod-removed), BATCHED (one findMany, not N+1)', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-h',
        appBlockId: null,
        slug: 'hidden-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-h', manifest: SLOT_MANIFEST, _count: { userSubscriptions: 0 } },
      },
      {
        id: 'req-m',
        appBlockId: null,
        slug: 'gone-app',
        version: '1.0.0',
        status: 'approved',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: new Date('2026-01-02'),
        rejectionReason: null,
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: { id: 'block-m', manifest: PAGE_MANIFEST, _count: { userSubscriptions: 0 } },
      },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { id: 'l-h', appBlockId: 'block-h', status: 'removed' },
      { id: 'l-m', appBlockId: 'block-m', status: 'removed' },
    ]);
    mockDbRead.appListingModerationEvent.findMany.mockResolvedValue([
      { appListingId: 'l-h', action: 'owner-unpublish' },
      { appListingId: 'l-m', action: 'delist' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    const byListing = Object.fromEntries(rows.map((r) => [r.appListingId, r]));
    expect(byListing['l-h']).toMatchObject({
      listingStatus: 'removed',
      lastModerationAction: 'owner-unpublish',
      hasPage: false, // slot manifest
    });
    expect(byListing['l-m']).toMatchObject({
      listingStatus: 'removed',
      lastModerationAction: 'delist',
      hasPage: true, // page manifest
    });
    // BATCHED: exactly ONE moderation-event query for the whole page, over BOTH
    // removed listing ids (not one query per row).
    expect(mockDbRead.appListingModerationEvent.findMany).toHaveBeenCalledTimes(1);
    const modArgs = mockDbRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(modArgs.where.appListingId.in.sort()).toEqual(['l-h', 'l-m']);
    expect(modArgs.distinct).toEqual(['appListingId']);
    // And exactly ONE backing-listing query for the whole page.
    expect(mockDbRead.appListing.findMany).toHaveBeenCalledTimes(1);
  });

  it('a row with no backing listing (pending first version) → null listing fields, null last action', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'req-p',
        appBlockId: null,
        slug: 'pending-app',
        version: '1.0.0',
        status: 'pending',
        submittedAt: new Date('2026-01-01'),
        reviewedAt: null,
        rejectionReason: null,
        approvalNotes: null,
        deployState: null,
        deployDetail: null,
        deployUpdatedAt: null,
        fileSummary: null,
        manifestDiffSummary: null,
        appBlock: null,
      },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx(owner) as never);
    const rows = await caller.listMyPublishRequests();

    expect(rows[0]).toMatchObject({
      appListingId: null,
      listingStatus: null,
      lastModerationAction: null,
      hasPage: false,
    });
    // No app-block ids on the page → no backing-listing / moderation queries at all.
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });
});
