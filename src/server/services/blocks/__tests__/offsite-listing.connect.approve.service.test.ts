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
/** The app's own address — where the store sends a viewer so the app can start its
 *  own OAuth flow. A connect listing without one has nowhere to send anybody. */
const CONNECT_URL = 'https://connect.example.com/app';
// A sensitive scope (ModelsWrite) + a normal read (ModelsRead).
const REQUESTED = TokenScope.ModelsWrite | TokenScope.ModelsRead;
const JUSTIFIED = { ModelsWrite: 'We edit models on the user behalf.' };
// A generous client ceiling (⊇ any scope these tests request) unless a test overrides it.
const CEILING =
  TokenScope.ModelsWrite | TokenScope.ModelsRead | TokenScope.MediaWrite | TokenScope.MediaRead;

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
    // Default: the go-live scan-clean gate re-reads each asset's `ingestion` — echo
    // every queried id as `Scanned` so a normal approve passes.
    c.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
      );
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
  /** In-tx (PRIMARY) row overrides — defaults mirror the replica row. Lets a test
   * diverge the primary from the replica to exercise the in-tx TOCTOU re-gate. */
  primaryRequestedScopes?: number;
  primaryJustifications?: Record<string, string>;
  primaryAllowedScopes?: number;
  /** The listing's destination. `null` → the actionability gate refuses go-live. */
  externalUrl?: string | null;
} = {}) {
  mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_c',
    status: 'pending',
    kind: 'offsite',
    slug: 'connect-app',
    appListingId: 'apl_c',
  });
  const requestedScopes = overrides.requestedScopes ?? REQUESTED;
  const justifications = overrides.justifications ?? JUSTIFIED;
  const listing = {
    id: 'apl_c',
    // 🔴 `kind` is load-bearing: the go-live actionability gate is off-site-only, so
    // a fixture without it makes that gate a silent no-op and these tests would pass
    // with the guard deleted.
    kind: 'offsite',
    status: 'draft',
    // CONNECT listings may carry no external URL in the DB model — but a listing with
    // no reachable address renders a store button with nothing to click, which is
    // what the actionability gate now refuses. `externalUrl` is therefore part of the
    // publishable-connect-listing fixture; see the reversed test below.
    externalUrl: overrides.externalUrl === undefined ? CONNECT_URL : overrides.externalUrl,
    iconId: 1,
    coverId: 2,
    revisionOfId: null,
    connectClientId: CLIENT_ID,
    connectRequestedScopes: requestedScopes,
    connectScopeJustifications: justifications,
    userId: CALLER,
    name: 'Connect App',
    slug: 'connect-app',
  };
  mockRead.appListing.findUnique.mockResolvedValue(listing);
  // The in-tx (PRIMARY) re-read: carries the reviewed scope disclosure + the client
  // ceiling so the AUTHORITATIVE connect gates run row-consistent with the flip. By
  // default it mirrors the replica; a TOCTOU test overrides the `primary*` fields.
  mockWrite.appListing.findUnique.mockResolvedValue({
    kind: 'offsite',
    slug: 'connect-app',
    externalUrl: listing.externalUrl,
    iconId: 1,
    coverId: 2,
    connectClientId: CLIENT_ID,
    connectRequestedScopes: overrides.primaryRequestedScopes ?? requestedScopes,
    connectScopeJustifications: overrides.primaryJustifications ?? justifications,
    connectClient: { allowedScopes: overrides.primaryAllowedScopes ?? CEILING },
  });
}

describe('approveExternalRequest — CONNECT approve→live (validateExternalUrl skip)', () => {
  /**
   * 🔴 REVERSED INTENT — called out rather than left in the diff.
   *
   * This test used to stage `externalUrl: null` and assert the approve SUCCEEDED,
   * encoding "a connect listing needs no destination". That rule is what let three
   * connect listings go live with a disabled button and no way to open the app.
   *
   * A connect listing's OAuth flow starts at the APP's own site (confidential
   * clients own their redirect_uri / state / PKCE) — the store's only job is to get
   * the viewer there, and `externalUrl` is the only address it has. So a connect
   * listing with no destination is not a valid shape that happens to render poorly;
   * it is a listing no user can act on, under every version of the view-model.
   *
   * What this test still pins, unchanged, is the ORIGINAL subject: `validateExternalUrl`
   * is skipped for connect. The listing now carries an https URL so the approve
   * reaches the flip, and the null-destination case is asserted below as a refusal.
   */
  it('approves a connect listing (URL gate skipped) → draft→approved', async () => {
    stageConnectApprove();
    const res = await approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_c', listingId: 'apl_c', slug: 'connect-app' });
    // The listing flip fired (draft/pending → approved) — proves approve reached the
    // flip rather than throwing on either URL gate.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_c', status: { in: ['draft', 'pending'] } },
      data: { status: 'approved', contentRating: 'g' },
    });
    // Owner notified their app went live.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-listing-approved', userId: CALLER })
    );
  });

  it('🔴 REFUSES a connect listing with NO destination — the shape that shipped a dead CTA', async () => {
    // The reversal, pinned positively. `validateExternalUrl` is still skipped (a null
    // URL is not an *invalid* URL) — it is the ACTIONABILITY gate that refuses, and
    // the message must be the one a moderator can act on.
    stageConnectApprove({ externalUrl: null });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('needs a working link before it can go live'),
    });
    // Fails CLOSED — nothing flipped, and the owner is NOT told their app went live.
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
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
          externalUrl: CONNECT_URL,
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
        return { id: 'apl_parent', slug: 'parent-slug', status: 'approved', kind: 'offsite' };
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
          externalUrl: CONNECT_URL,
          connectClientId: CLIENT_ID,
          connectRequestedScopes: UPDATED,
          connectScopeJustifications: UPDATED_JUST,
          // The in-tx subset re-assert (N2) reads the client ceiling; UPDATED ⊆ CEILING.
          connectClient: { allowedScopes: CEILING },
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

  it('🔴 a REVISION that would strip the live listing\'s destination is REFUSED — nothing copied', async () => {
    // The "break an already-live listing" case. A revision writes NO status, so the
    // status-transition gates never see it — but it copies `externalUrl` /
    // `connectClientId` straight onto an approved parent. A shadow with no
    // destination would therefore turn a working live listing into a dead CTA.
    //
    // 🔴 This also pins WHERE the gate is asserted. It must run on the POST-COPY
    // projection (parent kind/slug + SHADOW url/client). A gate that re-read the
    // PARENT instead would see the parent's still-valid URL, pass, and then
    // overwrite it — passing this scenario while permitting exactly the regression.
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_r',
      status: 'pending',
      kind: 'offsite',
      slug: 'parent-slug',
      appListingId: 'apl_shadow',
    });
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: null, // the revision REMOVES the destination
          iconId: 1,
          coverId: 2,
          revisionOfId: 'apl_parent',
          connectClientId: CLIENT_ID,
          connectRequestedScopes: REQUESTED,
          connectScopeJustifications: JUSTIFIED,
          userId: CALLER,
          name: 'Connect App',
          slug: 'parent-slug',
        };
      }
      // The LIVE parent still has a perfectly good destination.
      return {
        id: 'apl_parent',
        slug: 'parent-slug',
        status: 'approved',
        kind: 'offsite',
        externalUrl: CONNECT_URL,
      };
    });
    mockWrite.appListing.findUnique.mockResolvedValue({
      id: 'apl_shadow',
      status: 'draft',
      revisionOfId: 'apl_parent',
      externalUrl: null,
      connectClientId: CLIENT_ID,
      connectRequestedScopes: REQUESTED,
      connectScopeJustifications: JUSTIFIED,
      connectClient: { allowedScopes: CEILING },
      iconId: 1,
      coverId: 2,
    });

    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('needs a working link before it can go live'),
    });
    // Nothing was copied onto the live parent — it keeps serving its old, working content.
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('in-tx subset-of-ceiling on the REVISION: a shadow requesting a scope beyond the (shrunk) client ceiling → REJECT inside the tx, NO copy', async () => {
    // N2: mirror the first-time approve's in-tx subset re-assert on the revision path.
    // The revision's scopes are all justified, so this is caught ONLY by the
    // subset-of-ceiling re-assert (the client's `allowedScopes` shrank after edit).
    const REQ = TokenScope.ModelsWrite | TokenScope.ModelsRead; // superset of the shrunk ceiling
    const JUST = { ModelsWrite: 'still editing models' }; // sensitive scope IS justified
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_r',
      status: 'pending',
      kind: 'offsite',
      slug: 'parent-slug',
      appListingId: 'apl_shadow',
    });
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: CONNECT_URL,
          iconId: 1,
          coverId: 2,
          revisionOfId: 'apl_parent',
          connectClientId: CLIENT_ID,
          connectRequestedScopes: REQ,
          connectScopeJustifications: JUST,
          userId: CALLER,
          name: 'Connect App',
          slug: 'parent-slug',
        };
      }
      if (args.where.id === 'apl_parent') {
        return { id: 'apl_parent', slug: 'parent-slug', status: 'approved', kind: 'offsite' };
      }
      return null;
    });
    // In-tx (PRIMARY) shadow re-read: same scopes, but the client ceiling SHRANK to
    // ModelsRead only → ModelsWrite is now out of ceiling.
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
          externalUrl: CONNECT_URL,
          connectClientId: CLIENT_ID,
          connectRequestedScopes: REQ,
          connectScopeJustifications: JUST,
          connectClient: { allowedScopes: TokenScope.ModelsRead }, // ceiling shrank
          iconId: 1,
          coverId: 2,
        };
      }
      return null;
    });

    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('exceed') });
    // The tx opened (the authoritative gate runs inside it) but bailed BEFORE the copy.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe('approveExternalRequest — sensitive-must-justify gate', () => {
  it('PRE-TX FAST-FAIL: a SENSITIVE requested scope with NO justification (replica) → BAD_REQUEST before the tx opens', async () => {
    // The replica row ALREADY shows the unjustified sensitive scope, so the pre-tx
    // fail-fast rejects it without opening the tx. This documents the CHEAP fast-fail;
    // the AUTHORITATIVE gate (row-consistent, race-safe) is exercised by the in-tx
    // TOCTOU test below where the replica is benign but the primary is broadened.
    stageConnectApprove({ requestedScopes: REQUESTED, justifications: {} }); // ModelsWrite unjustified
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('ModelsWrite'),
    });
    // The fast-fail runs BEFORE the tx — nothing was flipped.
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

describe('approveExternalRequest — AUTHORITATIVE in-tx connect re-gate (TOCTOU)', () => {
  it('🔴 TOCTOU: replica is benign (ModelsRead only) but the PRIMARY was broadened to an unjustified sensitive scope → REJECT inside the tx, NO flip', async () => {
    // The owner submitted requesting only a non-sensitive scope (pre-tx replica gate
    // passes), then RACED an in-place edit broadening `connectRequestedScopes` to a
    // sensitive bit with an empty justification map AFTER the mod's pre-tx check but
    // BEFORE the flip. The authoritative in-tx re-read must catch it and roll back.
    stageConnectApprove({
      requestedScopes: TokenScope.ModelsRead, // replica: benign, gate passes
      justifications: {},
      primaryRequestedScopes: TokenScope.ModelsWrite | TokenScope.ModelsRead, // primary: broadened
      primaryJustifications: {}, // ...with NO justification for the sensitive bit
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('ModelsWrite'),
    });
    // We DID open the tx (the authoritative gate runs inside it) but bailed BEFORE any
    // flip — neither the request nor the listing status changed, and no live copy wrote.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    // Owner is NOT notified of a live app that never went live.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('in-tx subset-of-ceiling: the PRIMARY row requests a scope NOT in the client ceiling → REJECT inside the tx, NO flip', async () => {
    // Guards a client whose `allowedScopes` SHRANK after submit: the requested mask is
    // a SUPERSET of the (now-smaller) ceiling. Sensitive scopes are all justified, so
    // this is caught only by the subset re-assert, not the justify gate.
    stageConnectApprove({
      requestedScopes: TokenScope.ModelsWrite | TokenScope.ModelsRead,
      justifications: JUSTIFIED,
      primaryRequestedScopes: TokenScope.ModelsWrite | TokenScope.ModelsRead,
      primaryJustifications: JUSTIFIED,
      primaryAllowedScopes: TokenScope.ModelsRead, // ceiling shrank — ModelsWrite no longer allowed
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_c', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('exceed'),
    });
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });
});

describe('approveExternalRequest — external-link revision still validates its URL', () => {
  it('a connect-LESS revision with a bad stored externalUrl still throws BAD_REQUEST on approve (in-tx URL gate)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_r',
      status: 'pending',
      kind: 'offsite',
      slug: 'parent-slug',
      appListingId: 'apl_shadow',
    });
    // Replica: the shadow (revisionOfId set) routes into applyApprovedRevision; the
    // parent is still approved.
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: 'http://insecure.example.com', // non-https stored URL
          iconId: 1,
          coverId: 2,
          revisionOfId: 'apl_parent',
          connectClientId: null, // external-link revision (no connect)
          connectRequestedScopes: null,
          connectScopeJustifications: null,
          userId: CALLER,
          name: 'Link App',
          slug: 'parent-slug',
        };
      }
      if (args.where.id === 'apl_parent') {
        return { id: 'apl_parent', slug: 'parent-slug', status: 'approved', kind: 'offsite' };
      }
      return null;
    });
    // In-tx (PRIMARY) shadow re-read carries the same bad URL, connectClientId null.
    mockWrite.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_shadow') {
        return {
          id: 'apl_shadow',
          status: 'draft',
          revisionOfId: 'apl_parent',
          name: 'Link App',
          tagline: null,
          description: null,
          category: 'utility',
          contentRating: 'g',
          externalUrl: 'http://insecure.example.com',
          connectClientId: null,
          connectRequestedScopes: null,
          connectScopeJustifications: null,
          iconId: 1,
          coverId: 2,
        };
      }
      return null;
    });

    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('externalUrl'),
    });
    // Rolled back before the parent copy.
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });
});
