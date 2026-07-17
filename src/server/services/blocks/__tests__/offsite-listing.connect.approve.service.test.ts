import { beforeEach, describe, expect, it, vi } from 'vitest';

import { approveExternalRequest } from '~/server/services/blocks/offsite-listing.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * App Store Listings (W13) — OAuth-CONNECT APPROVE service tests (PR3).
 *
 * Covers the two gaps PR3 closes for connect (OAuth) listings:
 *   1. approve→live: a connect listing (externalUrl = null) is approvable — the
 *      `validateExternalUrl` gate is SKIPPED for the connect sub-kind — and a connect
 *      REVISION copies its (updated) scopes onto the live parent.
 *   2. sensitive-must-justify: approving a connect listing where a SENSITIVE requested
 *      scope has no justification is rejected `BAD_REQUEST`; all-justified approves; a
 *      non-sensitive missing justification does NOT block.
 *
 * External-link (non-connect) URL validation is proven UNWEAKENED by the sibling
 * `offsite-listing.service.test.ts` ("a non-https stored value BLOCKS approve").
 * DB deps are mocked — no real Prisma.
 */

const { mockRead, mockWrite } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 0),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    image: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
    appListingPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
  });
  const mockRead = makeClient();
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite };
});

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn(async () => undefined) }));

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotify,
}));

const MOD = 7;
const CALLER = 42;
const CLIENT_ID = 'oauth-client-1';
// A sensitive scope (ModelsWrite) + a normal read (ModelsRead).
const REQUESTED = TokenScope.ModelsWrite | TokenScope.ModelsRead;
const JUSTIFIED = { ModelsWrite: 'We edit models on the user behalf.' };

beforeEach(() => {
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockReset().mockResolvedValue(null);
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListingScreenshot.count.mockReset().mockResolvedValue(1);
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
    c.appListingScreenshot.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    c.appListingScreenshot.updateMany.mockReset().mockResolvedValue({ count: 0 });
    c.image.findMany.mockReset().mockResolvedValue([]);
    c.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  mockNotify.mockReset().mockResolvedValue(undefined);
});

/**
 * Stage a first-time CONNECT approve: a pending connect request → a DRAFT connect
 * listing (externalUrl null, revisionOfId null), on both the replica + primary.
 */
function stageConnectApprove(overrides: {
  requestedScopes?: number;
  justifications?: Record<string, string>;
} = {}) {
  mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_c',
    status: 'pending',
    kind: 'offsite',
    slug: 'connect-app',
    appListingId: 'apl_c',
  });
  const listing = {
    id: 'apl_c',
    status: 'draft',
    externalUrl: null, // CONNECT: no external URL by construction
    iconId: 1,
    coverId: 2,
    revisionOfId: null,
    connectClientId: CLIENT_ID,
    connectRequestedScopes: overrides.requestedScopes ?? REQUESTED,
    connectScopeJustifications: overrides.justifications ?? JUSTIFIED,
    userId: CALLER,
    name: 'Connect App',
    slug: 'connect-app',
  };
  mockRead.appListing.findUnique.mockResolvedValue(listing);
  mockWrite.appListing.findUnique.mockResolvedValue({
    externalUrl: null,
    iconId: 1,
    coverId: 2,
    connectClientId: CLIENT_ID,
  });
}

describe('approveExternalRequest — CONNECT approve→live (validateExternalUrl skip)', () => {
  it('approves a connect listing with a NULL externalUrl (URL gate skipped) → draft→approved', async () => {
    stageConnectApprove();
    const res = await approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_c', listingId: 'apl_c', slug: 'connect-app' });
    // The listing flip fired (draft/pending → approved) — proves approve reached the
    // flip rather than throwing on the null URL.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_c', status: { in: ['draft', 'pending'] } },
      data: { status: 'approved', contentRating: 'g' },
    });
    // Owner notified their app went live.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-listing-approved', userId: CALLER })
    );
  });

  it('the LIVE connect listing carries the reviewed scopes (flip does not clobber the connect fields)', async () => {
    stageConnectApprove();
    await approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD });
    // The first-time flip only sets status + contentRating; it never rewrites the
    // connect fields, so the reviewed connectClientId/scopes/justifications persist
    // on the same (now-approved) row.
    const flip = mockWrite.appListing.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(flip.data).toEqual({ status: 'approved', contentRating: 'g' });
    expect(flip.data).not.toHaveProperty('connectRequestedScopes');
  });
});

describe('approveExternalRequest — CONNECT revision copies updated scopes to live', () => {
  it('a connect REVISION approve copies connectClientId/scopes/justifications onto the live parent', async () => {
    const UPDATED = TokenScope.ModelsWrite | TokenScope.MediaWrite; // scope change
    const UPDATED_JUST = {
      ModelsWrite: 'still editing models',
      MediaWrite: 'now also publishing media',
    };
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_r',
      status: 'pending',
      kind: 'offsite',
      slug: 'parent-slug',
      appListingId: 'apl_shadow',
    });
    // approveExternalRequest reads the SHADOW (revisionOfId set) on the replica →
    // routes into applyApprovedRevision; applyApprovedRevision then reads the PARENT.
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: null,
          iconId: 1,
          coverId: 2,
          revisionOfId: 'apl_parent',
          connectClientId: CLIENT_ID,
          connectRequestedScopes: UPDATED,
          connectScopeJustifications: UPDATED_JUST,
          userId: CALLER,
          name: 'Connect App',
          slug: 'parent-slug',
        };
      }
      if (args.where.id === 'apl_parent') {
        return { id: 'apl_parent', slug: 'parent-slug', status: 'approved' };
      }
      return null;
    });
    // The in-tx (PRIMARY) shadow re-read.
    mockWrite.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          revisionOfId: 'apl_parent',
          name: 'Connect App',
          tagline: null,
          description: null,
          category: 'utility',
          contentRating: 'g',
          externalUrl: null,
          connectClientId: CLIENT_ID,
          connectRequestedScopes: UPDATED,
          connectScopeJustifications: UPDATED_JUST,
          iconId: 1,
          coverId: 2,
        };
      }
      return null;
    });

    const res = await approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_r', listingId: 'apl_parent', slug: 'parent-slug' });

    // The copy onto the LIVE parent carries the UPDATED connect scopes.
    const copy = mockWrite.appListing.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(copy.where).toEqual({ id: 'apl_parent' });
    expect(copy.data).toMatchObject({
      connectClientId: CLIENT_ID,
      connectRequestedScopes: UPDATED,
      connectScopeJustifications: UPDATED_JUST,
    });
  });
});

describe('approveExternalRequest — sensitive-must-justify gate', () => {
  it('a SENSITIVE requested scope with NO justification → BAD_REQUEST (no tx opened)', async () => {
    stageConnectApprove({ requestedScopes: REQUESTED, justifications: {} }); // ModelsWrite unjustified
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('ModelsWrite'),
    });
    // The gate runs BEFORE the tx — nothing was flipped.
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('all sensitive scopes justified → approves', async () => {
    stageConnectApprove({ requestedScopes: REQUESTED, justifications: JUSTIFIED });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).resolves.toMatchObject({ publishRequestId: 'alpr_c', listingId: 'apl_c' });
  });

  it('a NON-sensitive requested scope missing a justification does NOT block approval', async () => {
    // Only ModelsRead (non-sensitive) requested, with an empty justification map.
    stageConnectApprove({ requestedScopes: TokenScope.ModelsRead, justifications: {} });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).resolves.toMatchObject({ publishRequestId: 'alpr_c', listingId: 'apl_c' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalled();
  });
});
