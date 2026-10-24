import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
import type * as AppAccess from '~/server/services/blocks/app-access.service';
import type * as OffsiteListing from '~/server/services/blocks/offsite-listing.service';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';

const { recordRatingChange, beginListingRevision, bust, access } = vi.hoisted(() => ({
  /** What `resolveListingAccess` answers for the caller: an owner unless a test says otherwise. */
  access: { current: { role: 'owner' } as { role: string } | null },
  recordRatingChange: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  beginListingRevision: vi.fn(async (..._a: unknown[]) => ({
    shadowId: 'apl_rm_shadow',
    created: true,
  })),
  bust: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: (...a: unknown[]) => recordRatingChange(...a),
}));
vi.mock('~/server/services/blocks/offsite-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OffsiteListing>()),
  beginListingRevision: (...a: unknown[]) => beginListingRevision(...a),
}));
vi.mock('~/server/services/blocks/app-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccess>()),
  resolveListingAccess: vi.fn(async () => access.current),
}));
vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: () => bust(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  getListingAssets,
  setListingIcon,
  setListingRedMedia,
} from '~/server/services/blocks/app-listing-assets.service';
import {
  getMyListingForApp,
  getMyListingForEdit,
  loadListingEditRedMedia,
} from '~/server/services/blocks/offsite-listing.service';
import { RED_SLOTS_UNAVAILABLE_MESSAGE } from '~/server/services/blocks/listing-media-split.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * `setListingRedMedia` — the owner / moderator write of a civitai.red icon / cover override —
 * and the review read of it (`getListingAssets`). The override table is real SQL (PGlite, both
 * real migrations); the listing rows and images are the shared Prisma mock.
 *
 * Fixture ids are pairwise distinct: listings `apl_rm_live` / `apl_rm_shadow`, images 61 (PG
 * icon) / 62 (PG cover) / 63 (R override) / 64 (Blocked override), owner 71, moderator 72.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LIVE = 'apl_rm_live';
const SHADOW = 'apl_rm_shadow';
const OWNER_ID = 71;
const owner = { id: OWNER_ID, isModerator: false } as never;
const mod = { id: 72, isModerator: true } as never;
const ICON = 61;
const COVER = 62;
const R_OVERRIDE = 63;
const BLOCKED_OVERRIDE = 64;
const PG13_OVERRIDE = 65;

const LEVELS: Record<number, number> = {
  [ICON]: NsfwLevel.PG,
  [COVER]: NsfwLevel.PG,
  [R_OVERRIDE]: NsfwLevel.R,
  [BLOCKED_OVERRIDE]: NsfwLevel.R,
  [PG13_OVERRIDE]: NsfwLevel.PG13,
};
const INGESTION: Record<number, string> = { [BLOCKED_OVERRIDE]: 'Blocked' };

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
});
afterAll(() => split.db.close());

async function resetTables(redSlots: boolean) {
  await split.db.exec(`DROP TABLE IF EXISTS app_listing_red_media`);
  await split.db.exec(`TRUNCATE app_listings, "Image", "User" CASCADE`);
  await split.applyMigration();
  if (redSlots) await split.applyRedSlotsMigration();
  await split.seed({ listingIds: [LIVE, SHADOW], users: [72] });
  await split.seedImages(
    Object.entries(LEVELS).map(([id, nsfwLevel]) => ({
      id: Number(id),
      nsfwLevel,
      ingestion: INGESTION[Number(id)] ?? 'Scanned',
    }))
  );
  split.route(dbMock.dbRead as never);
  split.route(dbMock.dbWrite as never);
}

function listing(over: Record<string, unknown> = {}) {
  return {
    id: LIVE,
    kind: 'offsite',
    slug: 'red-media',
    name: 'Red Media',
    category: null,
    contentRating: 'g',
    userId: OWNER_ID,
    iconId: ICON,
    coverId: COVER,
    status: 'approved',
    revisionOfId: null,
    ...over,
  };
}

function wire(rows: Record<string, ReturnType<typeof listing>>) {
  for (const c of [dbMock.dbRead, dbMock.dbWrite]) {
    c.appListing.findUnique.mockImplementation(
      async (args: { where: { id: string } }) => rows[args.where.id] ?? null
    );
    c.appListingScreenshot.findMany.mockResolvedValue([]);
    c.image.findMany.mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
      (args?.where?.id?.in ?? []).map((id) => ({
        id,
        nsfwLevel: LEVELS[id] ?? 0,
        ingestion: INGESTION[id] ?? 'Scanned',
      }))
    );
  }
  // `loadValidatedImage`: an image the caller owns, a valid icon AND a valid cover (1:1 would
  // fail the cover's aspect, so the shape follows the id).
  dbMock.dbRead.image.findUnique.mockImplementation(async (args: { where: { id: number } }) => {
    const id = args.where.id;
    if (!(id in LEVELS)) return null;
    const square =
      id === R_OVERRIDE || id === BLOCKED_OVERRIDE || id === PG13_OVERRIDE || id === ICON;
    return {
      id,
      userId: OWNER_ID,
      url: `img-${id}.png`,
      type: 'image',
      width: square ? 512 : 1600,
      height: square ? 512 : 900,
      mimeType: 'image/png',
      metadata: {},
      ingestion: INGESTION[id] ?? 'Scanned',
      nsfwLevel: LEVELS[id],
    };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  access.current = { role: 'owner' };
  await resetTables(true);
});

describe('setListingRedMedia', () => {
  it('🔴 an owner’s edit of a LIVE listing opens a revision and lands on it, never on the live row', async () => {
    wire({
      [LIVE]: listing(),
      [SHADOW]: listing({ id: SHADOW, status: 'draft', revisionOfId: LIVE }),
    });
    const res = await setListingRedMedia(
      { listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE },
      owner
    );
    expect(res).toEqual({
      status: 'attached',
      slot: 'icon',
      imageId: R_OVERRIDE,
      scanPending: undefined,
    });
    expect(beginListingRevision).toHaveBeenCalledWith({ listingId: LIVE, userId: OWNER_ID });
    expect(await split.redSlots(SHADOW)).toEqual({ icon: R_OVERRIDE, cover: null });
    expect(await split.redSlots(LIVE)).toBeNull();
  });

  it('🔴 setting ONE override on a revision keeps the other live one (the revision starts from the live overrides)', async () => {
    wire({
      [LIVE]: listing(),
      [SHADOW]: listing({ id: SHADOW, status: 'draft', revisionOfId: LIVE }),
    });
    await split.setRedSlots(LIVE, { icon: R_OVERRIDE, cover: null });
    await setListingRedMedia({ listingId: LIVE, slot: 'cover', imageId: COVER }, owner);
    expect(await split.redSlots(SHADOW)).toEqual({ icon: R_OVERRIDE, cover: COVER });
  });

  it('invariant guard: on a LIVE listing a slot change takes the SAME review path as an icon change: one revision, opened the same way, holds both', async () => {
    wire({
      [LIVE]: listing(),
      [SHADOW]: listing({ id: SHADOW, status: 'draft', revisionOfId: LIVE }),
    });
    await setListingIcon({ listingId: LIVE, imageId: ICON }, owner);
    const iconRevisionCalls = beginListingRevision.mock.calls.map((c) => c[0]);
    expect(dbMock.dbWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: SHADOW },
      data: { iconId: ICON },
    });
    beginListingRevision.mockClear();

    await setListingRedMedia({ listingId: LIVE, slot: 'cover', imageId: COVER }, owner);
    expect(beginListingRevision.mock.calls.map((c) => c[0])).toEqual(iconRevisionCalls);
    expect(iconRevisionCalls).toEqual([{ listingId: LIVE, userId: OWNER_ID }]);
    // Both edits sit on the revision; the live listing is untouched until it is approved.
    expect(await split.redSlots(SHADOW)).toEqual({ icon: null, cover: COVER });
    expect(await split.redSlots(LIVE)).toBeNull();
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: LIVE } })
    );
  });

  it('invariant guard: an accepted collaborator (editor seat) may set and clear a slot, as for the icon', async () => {
    access.current = { role: 'editor' };
    wire({ [LIVE]: listing({ status: 'draft' }) });
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE }, owner);
    expect(await split.redSlots(LIVE)).toEqual({ icon: R_OVERRIDE, cover: null });
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: null }, owner);
    expect(await split.redSlots(LIVE)).toEqual({ icon: null, cover: null });
  });

  it('🔴 a caller with no role on the listing is refused, and nothing is written', async () => {
    access.current = null;
    wire({ [LIVE]: listing({ status: 'draft' }) });
    await expect(
      setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE }, owner)
    ).rejects.toThrow(/You do not own this listing/);
    expect(await split.redSlots(LIVE)).toBeNull();
  });

  it('🔴 a Blocked image is refused, and nothing is written', async () => {
    wire({ [LIVE]: listing({ status: 'draft' }) });
    await expect(
      setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: BLOCKED_OVERRIDE }, owner)
    ).rejects.toThrow(/rejected during scanning/);
    expect(await split.redSlots(LIVE)).toBeNull();
  });

  it('a slot is validated as the asset it stands in for (a square image is no cover)', async () => {
    wire({ [LIVE]: listing({ status: 'draft' }) });
    await expect(
      setListingRedMedia({ listingId: LIVE, slot: 'cover', imageId: R_OVERRIDE }, owner)
    ).rejects.toThrow(/cover must be landscape/);
  });

  it('clearing a slot writes null and validates no image', async () => {
    wire({ [LIVE]: listing({ status: 'draft' }) });
    await split.setRedSlots(LIVE, { icon: R_OVERRIDE, cover: null });
    expect(
      await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: null }, owner)
    ).toEqual({ status: 'cleared', slot: 'icon' });
    expect(await split.redSlots(LIVE)).toEqual({ icon: null, cover: null });
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });

  it('🔴 refused before a revision is opened while the override columns are absent', async () => {
    await resetTables(false);
    wire({ [LIVE]: listing() });
    await expect(
      setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE }, owner)
    ).rejects.toThrow(RED_SLOTS_UNAVAILABLE_MESSAGE);
    expect(beginListingRevision).not.toHaveBeenCalled();
  });

  it('🔴 a moderator’s live edit of an UNSPLIT listing raises its rating by the override, and busts', async () => {
    wire({ [LIVE]: listing() });
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE }, mod);
    expect(beginListingRevision).not.toHaveBeenCalled();
    expect(await split.redSlots(LIVE)).toEqual({ icon: R_OVERRIDE, cover: null });
    expect(dbMock.dbWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LIVE },
      data: { contentRating: 'r' },
    });
    expect(recordRatingChange).toHaveBeenCalledWith(
      expect.objectContaining({ appListingId: LIVE, before: 'g', after: 'r' })
    );
    expect(bust).toHaveBeenCalled();
  });

  it('🔴 a PG-13 override raises an unsplit live listing to PG-13 — and never a split one', async () => {
    // PG-13 is civitai.com-eligible by LEVEL: only the override mark keeps it out of a split.
    wire({ [LIVE]: listing() });
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: PG13_OVERRIDE }, mod);
    expect(dbMock.dbWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LIVE },
      data: { contentRating: 'pg13' },
    });
    vi.clearAllMocks();
    await split.db.query(
      `UPDATE app_listing_red_media SET media_split_approved_at = now(), media_split_approved_by = 72
       WHERE app_listing_id = $1`,
      [LIVE]
    );
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: PG13_OVERRIDE }, mod);
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('invariant guard: the same edit of a SPLIT listing leaves its rating alone', async () => {
    wire({ [LIVE]: listing() });
    await split.db.query(
      `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
       VALUES ($1, now(), 72)`,
      [LIVE]
    );
    await setListingRedMedia({ listingId: LIVE, slot: 'icon', imageId: R_OVERRIDE }, mod);
    expect(await split.redSlots(LIVE)).toEqual({ icon: R_OVERRIDE, cover: null });
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalled();
    // The split decision survives the override write.
    expect(await split.stamp(LIVE)).toEqual({ at: expect.any(String), by: 72 });
  });
});

describe('getListingAssets — the review read of the overrides', () => {
  it('🔴 reports each override with its level and scan state, and a Blocked one blocks approve', async () => {
    wire({ [LIVE]: listing({ status: 'pending' }) });
    await split.setRedSlots(LIVE, { icon: R_OVERRIDE, cover: BLOCKED_OVERRIDE });
    const res = await getListingAssets({ listingId: LIVE }, mod);
    expect(res).toMatchObject({
      redIconId: R_OVERRIDE,
      redCoverId: BLOCKED_OVERRIDE,
      redIconNsfwLevel: NsfwLevel.R,
      redCoverNsfwLevel: NsfwLevel.R,
      redIconScanStatus: 'scanned',
      redCoverScanStatus: 'blocked',
      redSlotsAvailable: true,
      hasBlockedAsset: true,
    });
  });

  it('positive control: the same listing without overrides blocks nothing', async () => {
    wire({ [LIVE]: listing({ status: 'pending' }) });
    const res = await getListingAssets({ listingId: LIVE }, mod);
    expect(res).toMatchObject({
      redIconId: null,
      redCoverId: null,
      hasBlockedAsset: false,
      redSlotsStaged: false,
    });
  });

  it('says whether the listing has an overrides row at all (a revision that staged none)', async () => {
    wire({ [LIVE]: listing({ status: 'pending' }) });
    await split.setRedSlots(LIVE, { icon: null, cover: null });
    expect(await getListingAssets({ listingId: LIVE }, mod)).toMatchObject({
      redIconId: null,
      redSlotsStaged: true,
    });
  });

  it('says when the environment cannot read the overrides at all', async () => {
    await resetTables(false);
    wire({ [LIVE]: listing({ status: 'pending' }) });
    expect((await getListingAssets({ listingId: LIVE }, mod)).redSlotsAvailable).toBe(false);
  });
});

describe('loadListingEditRedMedia — the editor’s prefill of the overrides', () => {
  it('🔴 returns each filled slot with its image id and an edge-resolved preview', async () => {
    wire({ [LIVE]: listing({ status: 'draft' }) });
    dbMock.dbWrite.image.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, url: `key-${id}` }))
    );
    await split.setRedSlots(LIVE, { icon: R_OVERRIDE, cover: null });
    const res = await loadListingEditRedMedia(LIVE);
    expect(res.available).toBe(true);
    expect(res.icon.imageId).toBe(R_OVERRIDE);
    expect(res.icon.url).toContain(`key-${R_OVERRIDE}`);
    expect(res.cover).toEqual({ imageId: null, url: null });
  });

  it('🔴 slot columns absent: not available, so the editor offers no picker', async () => {
    await resetTables(false);
    wire({ [LIVE]: listing({ status: 'draft' }) });
    expect(await loadListingEditRedMedia(LIVE)).toEqual({
      available: false,
      icon: { imageId: null, url: null },
      cover: { imageId: null, url: null },
    });
  });

  it('a failing read never fails the editor: not available, and logged', async () => {
    wire({ [LIVE]: listing({ status: 'draft' }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('boom'));
    try {
      expect((await loadListingEditRedMedia(LIVE)).available).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the editor reads hand the step the EDIT TARGET’s overrides (`redMedia`)', () => {
  /** One row serving every `appListing.findUnique` shape the two reads issue. */
  function editRow(id: string, over: Record<string, unknown> = {}) {
    return {
      ...listing({ id, ...over }),
      appBlockId: 'ab_rm',
      tagline: null,
      description: null,
      externalUrl: null,
      connectClientId: null,
      connectRequestedScopes: null,
      connectScopeJustifications: null,
      appBlock: { contentRating: null },
      icon: { url: 'icon-key' },
      cover: { url: 'cover-key' },
      screenshots: [],
    };
  }
  function wireEdit(rows: Record<string, ReturnType<typeof editRow>>, shadowOf?: string) {
    for (const c of [dbMock.dbRead, dbMock.dbWrite]) {
      c.appListing.findUnique.mockImplementation(
        async (args: { where: { id?: string; appBlockId?: string } }) =>
          args.where.appBlockId != null ? rows[LIVE] ?? null : rows[args.where.id ?? ''] ?? null
      );
      c.appListing.findFirst.mockImplementation(async () => (shadowOf ? { id: shadowOf } : null));
      c.image.findMany.mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, url: `key-${id}` }))
      );
    }
  }

  it('🔴 getMyListingForApp: the existing revision’s overrides, not the live listing’s', async () => {
    wireEdit(
      { [LIVE]: editRow(LIVE), [SHADOW]: editRow(SHADOW, { status: 'draft', revisionOfId: LIVE }) },
      SHADOW
    );
    await split.setRedSlots(LIVE, { icon: PG13_OVERRIDE, cover: null });
    await split.setRedSlots(SHADOW, { icon: R_OVERRIDE, cover: null });
    const res = await getMyListingForApp({ appBlockId: 'ab_rm', userId: OWNER_ID });
    expect(res.editTargetId).toBe(SHADOW);
    expect(res.redMedia.available).toBe(true);
    expect(res.redMedia.icon.imageId).toBe(R_OVERRIDE);
    expect(res.redMedia.icon.url).toContain(`key-${R_OVERRIDE}`);
    expect(res.redMedia.cover).toEqual({ imageId: null, url: null });
  });

  it('🔴 getMyListingForEdit: the listing’s own overrides for a draft edited in place', async () => {
    wireEdit({ [LIVE]: editRow(LIVE, { status: 'draft' }) });
    await split.setRedSlots(LIVE, { icon: null, cover: COVER });
    const res = await getMyListingForEdit({ listingId: LIVE, userId: OWNER_ID });
    expect(res.redMedia.available).toBe(true);
    expect(res.redMedia.cover.imageId).toBe(COVER);
    expect(res.redMedia.icon).toEqual({ imageId: null, url: null });
  });
});
