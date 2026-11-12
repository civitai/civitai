import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The off-site approve MUTATION refuses while the app has an open review hold. Drives the real
 * `appListingsRouter` and the real `approveExternalRequest` + holds service; only the database
 * is faked.
 */

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppListingsEnabled: vi.fn(async () => true),
  resolveStoreVisibilityScope: vi.fn(async () => 'public'),
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { appListingsRouter } from '../app-listings.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function modCtx() {
  return {
    acceptableOrigin: true,
    user: { id: 1, isModerator: true, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const hold = {
  id: 7,
  slug: 'listing-app',
  publishRequestId: 'alpr_1',
  requestKind: 'listing',
  placedByUserId: 1,
  placedByUsername: 'mod',
  placedByLabel: 'code-check',
  reason: 'security check still running',
  createdAt: new Date(),
  clearedAt: null,
  clearedByUserId: null,
  clearedKind: null,
  clearedReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_1',
    status: 'pending',
    kind: 'offsite',
    slug: 'listing-app',
    appListingId: 'apl_1',
  } as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...v: unknown[]) =>
    Promise.resolve(
      Prisma.sql(strings, ...v).text.includes('app_publish_request_holds') ? [hold] : []
    )) as never);
});

describe('appListings.approveExternalRequest with an open review hold', () => {
  it('🔴 refuses with PRECONDITION_FAILED naming the hold, before the listing is read', async () => {
    const caller = appListingsRouter.createCaller(modCtx() as never);
    const err = await caller.approveExternalRequest({ publishRequestId: 'alpr_1' }).catch((e) => e);
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toContain('code-check (mod): security check still running');
    expect(dbMock.dbRead.appListing.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('🔴 an override naming the shown hold passes the router and gets past the hold check', async () => {
    const caller = appListingsRouter.createCaller(modCtx() as never);
    const err = await caller
      .approveExternalRequest({
        publishRequestId: 'alpr_1',
        holdOverrideReason: 'checked by hand, a false alarm',
        holdOverrideIds: [7],
      })
      .catch((e) => e);
    // This fixture has no draft listing, so the approve stops at that read, past the holds.
    expect(err?.code).not.toBe('PRECONDITION_FAILED');
    expect(dbMock.dbRead.appListing.findUnique).toHaveBeenCalled();
  });
});

describe('appListings.listMySubmissions never returns hold text to the developer', () => {
  it('a submission with an open hold carries no hold reason, label or count', async () => {
    dbMock.dbRead.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...v: unknown[]) =>
      Promise.resolve(
        Prisma.sql(strings, ...v).text.includes('app_publish_request_holds') ? [hold] : []
      )) as never);
    dbMock.dbRead.appListingPublishRequest.findMany.mockResolvedValueOnce([
      {
        id: 'alpr_1',
        kind: 'offsite',
        slug: 'listing-app',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        rejectionReason: null,
        approvalNotes: null,
        appListingId: null,
        appListing: null,
      },
    ] as never);
    const caller = appListingsRouter.createCaller({
      ...modCtx(),
      user: { id: 2, isModerator: false, onboarding: 0x1f },
      features: { trpcFlagGuardPerRequest: true, appBlocksAuthor: true },
    } as never);
    const body = JSON.stringify(await caller.listMySubmissions({}));
    expect(body).toContain('alpr_1');
    for (const secret of ['code-check', 'security check still running']) {
      expect(body).not.toContain(secret);
    }
    expect(body).not.toMatch(/hold/i);
  });
});
