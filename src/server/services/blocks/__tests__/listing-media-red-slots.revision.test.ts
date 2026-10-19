import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { seq } = vi.hoisted(() => ({ seq: { n: 0 } }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_rv_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_rv_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_rv_${++seq.n}`,
  newUlid: () => `ULIDRV${++seq.n}`,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  applyRevisionRedSlots,
  writeListingRedSlot,
} from '~/server/services/blocks/listing-media-split.service';
import { beginListingRevision } from '~/server/services/blocks/offsite-listing.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * T10 — opening a revision CARRIES the live listing's civitai.red icon / cover overrides onto the
 * shadow (`beginListingRevision` → `cloneListingRedSlots`, inside its transaction).
 *
 * Why it matters even though an apply leaves the live overrides alone when the shadow staged
 * none: an owner who then edits ONE override on the revision creates the shadow's row with only
 * that slot, and the apply copies BOTH slots back — so without the clone, changing the red cover
 * would silently delete the red icon. The overrides are real SQL (PGlite, both real migrations);
 * the listing rows are the shared Prisma mock.
 *
 * Ids: live `apl_rv_parent`, shadow `apl_rv_new_1` (the mocked id generator's first), overrides
 * 121 (icon) / 122 (old cover) / 123 (new cover), owner 124.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const PARENT = 'apl_rv_parent';
const SHADOW = 'apl_rv_new_1';
const OWNER = 124;
const RED_ICON = 121;
const OLD_RED_COVER = 122;
const NEW_RED_COVER = 123;

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
  await split.applyMigration();
  await split.applyRedSlotsMigration();
});
afterAll(() => split.db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  seq.n = 0;
  await split.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
  await split.seed({ listingIds: [PARENT, SHADOW] });
  await split.seedImages(
    [RED_ICON, OLD_RED_COVER, NEW_RED_COVER].map((id) => ({ id, nsfwLevel: NsfwLevel.R }))
  );
  await split.setRedSlots(PARENT, { icon: RED_ICON, cover: OLD_RED_COVER });
  split.route(dbMock.dbWrite as never);
  split.route(dbMock.dbRead as never);

  const parent = {
    id: PARENT,
    kind: 'offsite',
    slug: 'red-revision',
    status: 'approved',
    userId: OWNER,
    revisionOfId: null,
    name: 'Red Revision',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: 'https://cool.app',
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
  };
  dbMock.dbRead.appListing.findUnique.mockResolvedValue(parent);
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.appListing.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: SHADOW });
  dbMock.dbWrite.appListing.create.mockImplementation(async (a: { data: unknown }) => a.data);
  dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(dbMock.dbWrite)
  );
});

describe('T10 — a revision carries the live overrides', () => {
  it('🔴 opening a revision copies the live overrides onto the shadow', async () => {
    expect(await beginListingRevision({ listingId: PARENT, userId: OWNER })).toEqual({
      shadowId: SHADOW,
      created: true,
    });
    expect(await split.redSlots(SHADOW)).toEqual({ icon: RED_ICON, cover: OLD_RED_COVER });
  });

  it('🔴 so changing ONE override on the revision leaves the other one live after approve', async () => {
    await beginListingRevision({ listingId: PARENT, userId: OWNER });
    await writeListingRedSlot(split.raw, {
      appListingId: SHADOW,
      slot: 'cover',
      imageId: NEW_RED_COVER,
    });
    await applyRevisionRedSlots(split.raw, { shadowId: SHADOW, parentId: PARENT });
    expect(await split.redSlots(PARENT)).toEqual({ icon: RED_ICON, cover: NEW_RED_COVER });
  });
});
