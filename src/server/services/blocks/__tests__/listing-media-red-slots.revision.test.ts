import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';

const { seq } = vi.hoisted(() => ({ seq: { n: 0 } }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_rv_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_rv_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_rv_${++seq.n}`,
  newUlid: () => `ULIDRV${++seq.n}`,
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  applyRevisionRedSlots,
  writeListingRedSlot,
} from '~/server/services/blocks/listing-media-split.service';
import {
  approveExternalRequest,
  beginListingRevision,
} from '~/server/services/blocks/offsite-listing.service';
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
  // Reset, not just cleared: a test that throws mid-open leaves a queued `Once` value behind.
  dbMock.dbWrite.appListing.findFirst.mockReset();
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

/** The SQL text of every raw call the write client made that names the overrides table. */
function tableStatements(kind: '$queryRaw' | '$executeRaw') {
  const calls = (dbMock.dbWrite[kind] as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .filter(([strings]) => Array.isArray(strings))
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).text)
    .filter((text) => text.includes('app_listing_red_media'));
}

describe('T10b — a write role that may only SELECT the overrides table', () => {
  afterEach(() => split.unrestrict());

  it('🔴 opening a revision of a listing with no overrides still succeeds, issuing nothing against the table', async () => {
    // Postgres checks INSERT privilege before it looks for rows, so even the zero-row
    // `INSERT … SELECT` the clone used to issue here raised "permission denied" and failed
    // every revision open.
    await split.db.exec(`TRUNCATE app_listing_red_media`);
    await split.restrictTo(['SELECT']);
    expect(await beginListingRevision({ listingId: PARENT, userId: OWNER })).toEqual({
      shadowId: SHADOW,
      created: true,
    });
    expect(tableStatements('$executeRaw')).toEqual([]);
    // The only read naming the table is the privilege probe (`to_regclass`).
    expect(tableStatements('$queryRaw').every((t) => t.includes('to_regclass'))).toBe(true);
    expect(await split.redSlots(SHADOW)).toBeNull();
  });

  it('positive control: with INSERT and UPDATE the same open carries the overrides', async () => {
    await split.restrictTo(['SELECT', 'INSERT', 'UPDATE']);
    await beginListingRevision({ listingId: PARENT, userId: OWNER });
    expect(tableStatements('$executeRaw')).toHaveLength(1);
    expect(await split.redSlots(SHADOW)).toEqual({ icon: RED_ICON, cover: OLD_RED_COVER });
  });
});

const REQUEST = 'alpr_rv_approve';

/** Wire the moderator's approve of the revision `beginListingRevision` just opened. */
function wireRevisionApprove() {
  const parent = { id: PARENT, slug: 'red-revision', status: 'approved', kind: 'offsite' };
  const shadow = {
    id: SHADOW,
    status: 'draft',
    revisionOfId: PARENT,
    externalUrl: 'https://cool.app',
    iconId: 1,
    coverId: 2,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Red Revision',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    slug: 'red-revision-rev',
    kind: 'offsite',
  };
  dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: REQUEST,
    status: 'pending',
    kind: 'offsite',
    slug: 'red-revision',
    appListingId: SHADOW,
  });
  for (const c of [dbMock.dbRead, dbMock.dbWrite]) {
    c.appListing.findUnique
      .mockReset()
      .mockImplementation(async (a: { where: { id: string } }) =>
        a.where.id === PARENT
          ? { ...parent, contentRating: 'r' }
          : a.where.id === SHADOW
          ? shadow
          : null
      );
    c.image.findMany
      .mockReset()
      .mockImplementation(async (a: { where?: { id?: { in?: number[] } } }) =>
        (a?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: 'Scanned',
          nsfwLevel: NsfwLevel.PG,
        }))
      );
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([{ imageId: 3 }]);
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
}

describe('T10c — a write role that may SELECT and INSERT the overrides table, but not UPDATE it', () => {
  afterEach(() => split.unrestrict());

  it('🔴 a revision of a listing with overrides opens AND approves, and the live overrides stay as they were', async () => {
    // The approve applies a staged row back with an upsert (`ON CONFLICT … DO UPDATE`), which
    // PostgreSQL refuses without UPDATE even when no row conflicts. So the open must not stage a
    // row this role cannot apply: before it checked UPDATE too, the clone ran here and the
    // approve failed with "permission denied".
    await split.restrictTo(['SELECT', 'INSERT']);
    expect(await beginListingRevision({ listingId: PARENT, userId: OWNER })).toEqual({
      shadowId: SHADOW,
      created: true,
    });
    wireRevisionApprove();
    await expect(
      approveExternalRequest({ publishRequestId: REQUEST, reviewerUserId: 8 })
    ).resolves.toMatchObject({ listingId: PARENT });
    expect(await split.redSlots(PARENT)).toEqual({ icon: RED_ICON, cover: OLD_RED_COVER });
    // The open staged nothing (the shadow delete is mocked, so a staged row would still be here).
    expect(await split.redSlots(SHADOW)).toBeNull();
  });
});
