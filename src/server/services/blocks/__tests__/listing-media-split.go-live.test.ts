import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';

const { recordRatingChange } = vi.hoisted(() => ({
  recordRatingChange: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: (...a: unknown[]) => recordRatingChange(...a),
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE,
  MEDIA_SPLIT_UNAVAILABLE_MESSAGE,
} from '~/server/services/blocks/listing-media-split.service';
import { approveExternalRequest } from '~/server/services/blocks/offsite-listing.service';
import type { ListingMediaSplitDecision } from '~/shared/utils/listing-media-split';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * T6 — every moderator go-live `approveExternalRequest` reaches, with the media-split decision:
 * an on-site listing request (floored, raise-only), an off-site approve (derived replaces) and a
 * revision apply (decision on the live parent, face from the shadow). The split decision is
 * written to and read from a real `app_listing_red_media` (PGlite, the real migration); the
 * listing rows are the shared Prisma mock.
 *
 * Fixture: a `g` app whose icon and cover are PG and whose one screenshot is R.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MOD = 7;
const OWNER = 42;
const REQUEST_ID = 'alpr_split';
const LISTING_ID = 'apl_split';
const PARENT_ID = 'apl_split_parent';
const SHADOW_ID = 'apl_split_shadow';
const ICON = 11;
const COVER = 12;
const SHOT = 13;
const R_COVER = 14;

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
});
afterAll(() => split.db.close());

const LEVELS: Record<number, number> = {
  [ICON]: NsfwLevel.PG,
  [COVER]: NsfwLevel.PG,
  [SHOT]: NsfwLevel.R,
  [R_COVER]: NsfwLevel.R,
};

async function resetSplitTable(present: boolean) {
  await split.db.exec(`DROP TABLE IF EXISTS app_listing_red_media`);
  await split.db.exec(`TRUNCATE app_listings, "Image", "User" CASCADE`);
  if (present) await split.applyMigration();
  await split.seed({
    listingIds: [LISTING_ID, PARENT_ID, SHADOW_ID],
    images: LEVELS,
    users: [MOD],
  });
  split.route(mockWrite as never);
  split.route(mockRead as never);
}

function wireImages() {
  for (const c of [mockRead, mockWrite]) {
    c.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: 'Scanned',
          nsfwLevel: LEVELS[id] ?? NsfwLevel.PG,
        }))
      );
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([{ imageId: SHOT }]);
  }
}

/** A pending, non-shadow listing request of `kind` whose listing goes live on approve. */
function wireFirstApprove(kind: 'onsite' | 'offsite', coverId = COVER) {
  const listing = {
    id: LISTING_ID,
    status: 'pending',
    externalUrl: kind === 'offsite' ? 'https://cool.app' : null,
    iconId: ICON,
    coverId,
    revisionOfId: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Cool App',
    slug: 'cool-app',
    kind,
    contentRating: 'g',
    appBlockId: kind === 'onsite' ? 'apb_1' : null,
  };
  mockRead.appListingPublishRequest.findUnique.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    status: 'pending',
    kind,
    slug: 'cool-app',
    appListingId: LISTING_ID,
  });
  for (const c of [mockRead, mockWrite])
    c.appListing.findUnique.mockReset().mockResolvedValue(listing);
  wireImages();
}

/** A pending off-site revision: the shadow carries the R screenshot onto an approved `g` parent. */
function wireRevision(coverId = COVER) {
  const parent = {
    id: PARENT_ID,
    slug: 'cool-app',
    status: 'approved',
    kind: 'offsite',
    contentRating: 'g',
  };
  const shadow = {
    id: SHADOW_ID,
    status: 'draft',
    revisionOfId: PARENT_ID,
    externalUrl: 'https://cool.app',
    iconId: ICON,
    coverId,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Cool App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    slug: 'rev-x',
    kind: 'offsite',
  };
  mockRead.appListingPublishRequest.findUnique.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    status: 'pending',
    kind: 'offsite',
    slug: 'cool-app',
    appListingId: SHADOW_ID,
  });
  for (const c of [mockRead, mockWrite])
    c.appListing.findUnique
      .mockReset()
      .mockImplementation(async (args: { where: { id: string } }) =>
        args.where.id === PARENT_ID ? parent : args.where.id === SHADOW_ID ? shadow : null
      );
  wireImages();
}

const approve = (mediaSplit?: ListingMediaSplitDecision) =>
  approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD, mediaSplit });

/** The rating the approve stamped on the listing going live (first approve or revision parent). */
function stampedRating(): string | null | undefined {
  const flip = mockWrite.appListing.updateMany.mock.calls.find(
    (c: { data?: { status?: string } }[]) => c[0]?.data?.status === 'approved'
  );
  if (flip) return flip[0].data.contentRating;
  const parentWrite = mockWrite.appListing.update.mock.calls.find(
    (c: { where?: { id?: string } }[]) => c[0]?.where?.id === PARENT_ID
  );
  return parentWrite?.[0]?.data?.contentRating;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  for (const c of [mockRead, mockWrite]) {
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
  mockWrite.appBlock.updateMany.mockReset().mockResolvedValue({ count: 1 });
  await resetSplitTable(true);
});

const SITES = [
  {
    site: 'on-site listing request (raise-only floor)',
    wire: (coverId?: number) => wireFirstApprove('onsite', coverId),
    listing: LISTING_ID,
  },
  {
    site: 'off-site approve (derived replaces)',
    wire: (coverId?: number) => wireFirstApprove('offsite', coverId),
    listing: LISTING_ID,
  },
  {
    site: 'off-site revision apply',
    wire: (coverId?: number) => wireRevision(coverId),
    listing: PARENT_ID,
  },
];

describe.each(SITES)('$site', ({ wire, listing }) => {
  it('🔴 a split approve keeps the listing at its civitai.com rating and records the decision', async () => {
    wire();
    await approve('split');
    expect(stampedRating()).toBe('g');
    expect(await split.stamp(listing)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('invariant guard: with the decision omitted the R screenshot still floors the listing', async () => {
    wire();
    await approve();
    expect(stampedRating()).toBe('r');
    expect(await split.stamp(listing)).toBeNull();
  });

  it('rate-mature ends an earlier split', async () => {
    wire();
    await approve('split');
    vi.clearAllMocks();
    wire();
    mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
    await approve('rate-mature');
    expect(stampedRating()).toBe('r');
    expect(await split.stamp(listing)).toEqual({ at: null, by: null });
  });

  it('🔴 refuses a split whose cover is above SFW, before anything goes live', async () => {
    wire(R_COVER);
    await expect(approve('split')).rejects.toThrow(MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE);
    expect(stampedRating()).toBeUndefined();
  });

  it('🔴 table absent: a split is refused as unavailable, and nothing goes live', async () => {
    await resetSplitTable(false);
    wire();
    await expect(approve('split')).rejects.toThrow(MEDIA_SPLIT_UNAVAILABLE_MESSAGE);
    expect(stampedRating()).toBeUndefined();
  });

  it('table absent: an approve without a decision floors exactly as before', async () => {
    await resetSplitTable(false);
    wire();
    await approve();
    expect(stampedRating()).toBe('r');
  });
});
