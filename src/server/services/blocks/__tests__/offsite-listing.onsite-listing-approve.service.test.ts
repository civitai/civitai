import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import { approveExternalRequest } from '~/server/services/blocks/offsite-listing.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * 🔴 APPROVING A NON-SHADOW **ON-SITE** LISTING REQUEST — a shape that did not exist
 * before the owner-republish asset-review route.
 *
 * Every other on-site `AppListingPublishRequest` is a media REVISION: its listing carries
 * `revisionOfId`, so `approveExternalRequest` returns early into `applyApprovedRevision`
 * and the main approve path never sees `kind: 'onsite'`. The republish review arm mints
 * the first non-shadow one, which lands on that main path — so the two on-site behaviours
 * asserted here are NEW CODE on a NEWLY REACHABLE branch, not tweaks to an existing flow:
 *
 *   1. THE RATING IS RAISE-ONLY OVER THE APP'S OWN DECLARATION. Off-site, the rating IS
 *      the assets, so the derived value REPLACES the stored one. On-site it describes the
 *      APP (manifest-declared) and the store art is a strictly smaller surface, so
 *      replacing it would LOWER a `pg13` app to `g` because its icon happens to be tame.
 *   2. THE BACKING BLOCK IS UN-SUSPENDED. `AppBlock.status` is the only gate on whether a
 *      hosted app serves. The review arm deliberately leaves it `suspended`, so approving
 *      only the listing would put a store card live pointing at a dead app.
 *
 * DB deps come from the canonical `dbMock` — no real Prisma.
 */

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn(async () => undefined) }));

vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotify,
}));

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

const MOD = 7;
const OWNER = 42;
const REQUEST_ID = 'alpr_onsite';
const LISTING_ID = 'apl_onsite';
const BLOCK_ID = 'apb_backing';
const SLUG = 'cool-app';

/** Pairwise-DISTINCT image ids, so a mutant that reads the wrong field cannot pass. */
const ICON_ID = 11;
const COVER_ID = 22;
const SHOT_ID = 33;

/**
 * Stage an on-site, NON-shadow, pending listing request whose listing is `pending`.
 *
 * `declared` is the app's stored `contentRating`; `levels` maps an image id to the
 * `nsfwLevel` the scanner found, so the two inputs to the rating decision are set
 * independently and a test can make them disagree in either direction.
 */
function wire(
  opts: {
    kind?: string;
    declared?: string | null;
    levels?: Record<number, number>;
    appBlockId?: string | null;
    blockUnsuspendCount?: number;
  } = {}
) {
  const kind = opts.kind ?? 'onsite';
  const levels = opts.levels ?? {};
  const listing = {
    id: LISTING_ID,
    status: 'pending',
    // An off-site listing must satisfy the go-live actionability gate (an https
    // destination); an on-site one carries no URL and the gate is a no-op for it.
    externalUrl: kind === 'offsite' ? 'https://cool.app' : null,
    iconId: ICON_ID,
    coverId: COVER_ID,
    revisionOfId: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Cool App',
    slug: SLUG,
    kind,
    contentRating: opts.declared === undefined ? 'pg13' : opts.declared,
    appBlockId: opts.appBlockId === undefined ? BLOCK_ID : opts.appBlockId,
  };

  mockRead.appListingPublishRequest.findUnique.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    status: 'pending',
    kind,
    slug: SLUG,
    appListingId: LISTING_ID,
  });
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockReset().mockResolvedValue(listing);
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([{ imageId: SHOT_ID }]);
    c.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: 'Scanned',
          nsfwLevel: levels[id] ?? NsfwLevel.PG,
        }))
      );
  }
  mockWrite.appBlock.updateMany
    .mockReset()
    .mockResolvedValue({ count: opts.blockUnsuspendCount ?? 1 });
}

/** The `data` of the guarded listing flip → approved. */
function flipData() {
  const call = mockWrite.appListing.updateMany.mock.calls.find(
    (c: { data?: { status?: string } }[]) => c[0]?.data?.status === 'approved'
  );
  return call?.[0]?.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations — every default below is set
  // explicitly so a value left behind by an earlier test cannot decide a later one.
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  for (const c of [mockRead, mockWrite]) {
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
  mockWrite.appBlock.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockNotify.mockReset().mockResolvedValue(undefined);
});

describe('approveExternalRequest — ON-SITE rating is RAISE-ONLY over the app declaration', () => {
  it('🔴 tame store art does NOT lower the app rating (the whole point)', async () => {
    // A `pg13` app whose icon/cover/screenshot all scan as PG. The off-site rule would
    // derive `g` and STAMP it, under-rating the runtime because a picture looked tame.
    wire({
      declared: 'pg13',
      levels: { [ICON_ID]: NsfwLevel.PG, [COVER_ID]: NsfwLevel.PG, [SHOT_ID]: NsfwLevel.PG },
    });
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'pg13' });
  });

  it('🔴 mature store art DOES raise it', async () => {
    wire({
      declared: 'g',
      levels: { [ICON_ID]: NsfwLevel.PG, [COVER_ID]: NsfwLevel.X, [SHOT_ID]: NsfwLevel.PG },
    });
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'x' });
  });

  it('a moderator override may raise above the floor', async () => {
    wire({ declared: 'g', levels: { [ICON_ID]: NsfwLevel.PG } });
    await approveExternalRequest({
      publishRequestId: REQUEST_ID,
      reviewerUserId: MOD,
      contentRating: 'r',
    });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'r' });
  });

  it('🔴 a moderator override may NOT lower it below the app declaration', async () => {
    wire({ declared: 'r', levels: { [ICON_ID]: NsfwLevel.PG } });
    await approveExternalRequest({
      publishRequestId: REQUEST_ID,
      reviewerUserId: MOD,
      contentRating: 'g',
    });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'r' });
  });

  it('🔴 OFF-SITE is unchanged: the derived rating REPLACES the stored one, up or down', async () => {
    // The control that makes every assertion above a claim about the on-site BRANCH
    // rather than about the helper. Same declared rating, same tame media, opposite
    // answer — so a mutant that took one path for both kinds fails here or above.
    wire({
      kind: 'offsite',
      declared: 'pg13',
      levels: { [ICON_ID]: NsfwLevel.PG, [COVER_ID]: NsfwLevel.PG, [SHOT_ID]: NsfwLevel.PG },
    });
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'g' });
  });
});

describe('approveExternalRequest — ON-SITE un-suspends the backing block', () => {
  it('🔴 restores the runtime, not only the store card', async () => {
    // `AppBlock.status` is the ONLY gate on whether a hosted app serves, and the review
    // arm leaves it `suspended` on purpose. Approving only the listing would publish a
    // store card pointing at a dead app — store-visible and not self-recoverable.
    wire({});
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'suspended' },
      data: { status: 'approved' },
    });
  });

  it('OFF-SITE touches no block', async () => {
    wire({ kind: 'offsite', appBlockId: null });
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('an on-site listing with no backing block is a no-op, not a crash', async () => {
    wire({ appBlockId: null });
    await approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD });
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 does NOT un-suspend when the listing flip lost its race', async () => {
    // A 0-count means a concurrent withdraw/reject already closed the listing. Waking the
    // block anyway would leave the app serving with no approved store listing.
    wire({});
    mockWrite.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });
});
