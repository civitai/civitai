import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';

const { bustCatalog } = vi.hoisted(() => ({ bustCatalog: vi.fn(async () => undefined) }));
vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: () => bustCatalog(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { reDeriveListingRatingsForModeratedImage } from '~/server/services/blocks/app-listing-rating-rederive.service';
import { recordListingRatingChangeAfterCommit } from '~/server/services/blocks/app-listing-rating';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * A moderator re-rates an image that a live listing shows ONLY as its civitai.red icon override.
 * The listing is found through the override (it uses the image in no `app_listings` column and
 * no screenshot), and the override floors its rating exactly when the listing is not split. The
 * overrides and the split are real SQL (PGlite, both real migrations); the listing rows are the
 * shared Prisma mock.
 *
 * Ids: listing `apl_rr_live`, own icon/cover 91 (PG), override 92, moderator 93.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LIVE = 'apl_rr_live';
const OWN = 91;
const OVERRIDE = 92;
const MOD = 93;

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
  await split.applyMigration();
  await split.applyRedSlotsMigration();
});
afterAll(() => split.db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await split.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
  await split.seed({ listingIds: [LIVE], users: [MOD] });
  // The image row as it stands AFTER the moderator's write: the re-derive runs post-commit.
  await split.seedImages([
    { id: OWN, nsfwLevel: NsfwLevel.PG },
    { id: OVERRIDE, nsfwLevel: NsfwLevel.R },
  ]);
  await split.setRedSlots(LIVE, { icon: OVERRIDE, cover: null });

  const listing = {
    slug: 'rerate',
    kind: 'offsite',
    contentRating: 'g',
    appBlock: null,
    iconId: OWN,
    coverId: OWN,
  };
  // The listing uses the image in none of its own columns or screenshots.
  dbMock.dbWrite.appListing.findMany.mockResolvedValue([]);
  dbMock.dbWrite.appListing.findUnique.mockResolvedValue(listing);
  dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockImplementation(
    async (args: { where: { id: { in: number[] } } }) =>
      args.where.id.in.map((id) => ({ id, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' }))
  );
  dbMock.dbWrite.appListingModerationEvent.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.appListing.update.mockImplementation(async (a: { data: unknown }) => a.data);
  split.route(dbMock.dbWrite as never, {
    // The live-row lock: this listing is approved and not a shadow.
    queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).text.includes('FOR UPDATE') ? [{ id: LIVE }] : [],
  });
});

const rerate = () =>
  reDeriveListingRatingsForModeratedImage({
    imageId: OVERRIDE,
    previousNsfwLevel: NsfwLevel.PG,
    actorUserId: MOD,
  });

describe('a moderator re-rates an image a live listing shows only as its civitai.red override', () => {
  it('🔴 an unsplit listing is found through the override and raised to R', async () => {
    expect(await rerate()).toEqual([{ appListingId: LIVE, before: 'g', after: 'r' }]);
    expect(dbMock.dbWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LIVE },
      data: { contentRating: 'r' },
    });
    expect(bustCatalog).toHaveBeenCalled();
  });

  it('invariant guard: a split listing keeps its rating — the override never floors it', async () => {
    await split.db.query(
      `UPDATE app_listing_red_media SET media_split_approved_at = now(), media_split_approved_by = $2
       WHERE app_listing_id = $1`,
      [LIVE, MOD]
    );
    expect(await rerate()).toEqual([]);
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('positive control: with the override cleared the listing is not touched at all', async () => {
    await split.setRedSlots(LIVE, { icon: null, cover: null });
    expect(await rerate()).toEqual([]);
    expect(dbMock.dbWrite.appListing.findUnique).not.toHaveBeenCalled();
  });
});

describe('the override mark reaches the re-rate floor', () => {
  const splitIt = () =>
    split.db.query(
      `UPDATE app_listing_red_media SET media_split_approved_at = now(), media_split_approved_by = $2
       WHERE app_listing_id = $1`,
      [LIVE, MOD]
    );

  it('🔴 a PG-13 override — civitai.com-eligible by level — raises an unsplit listing, never a split one', async () => {
    await split.seedImages([{ id: OVERRIDE, nsfwLevel: NsfwLevel.PG13 }]);
    expect(await rerate()).toEqual([{ appListingId: LIVE, before: 'g', after: 'pg13' }]);
    vi.clearAllMocks();
    await splitIt();
    expect(await rerate()).toEqual([]);
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('invariant guard: the "before" side keeps the mark: lowering an override a split never counted lowers nothing', async () => {
    // An on-site app declared g, rated pg13 by something else, split. Its override is re-rated
    // PG-13 → PG. The override never floored this split listing, so it cannot "explain" the
    // stored pg13 and the rating must stay — reading the override's previous level WITHOUT its
    // mark would let it explain pg13 and drop the listing to g.
    await split.seedImages([{ id: OVERRIDE, nsfwLevel: NsfwLevel.PG }]);
    await splitIt();
    dbMock.dbWrite.appListing.findUnique.mockResolvedValue({
      slug: 'rerate',
      kind: 'onsite',
      contentRating: 'pg13',
      appBlock: { contentRating: 'g' },
      iconId: OWN,
      coverId: OWN,
    });
    expect(
      await reDeriveListingRatingsForModeratedImage({
        imageId: OVERRIDE,
        previousNsfwLevel: NsfwLevel.PG13,
        actorUserId: MOD,
      })
    ).toEqual([]);
    expect(dbMock.dbWrite.appListing.update).not.toHaveBeenCalled();
  });
});

describe('the rating-history cause reads the overrides too', () => {
  it('🔴 a raise that lands on what the override derives is a store-media change', async () => {
    dbMock.dbWrite.appListingModerationEvent.create.mockResolvedValue({});
    await recordListingRatingChangeAfterCommit({
      appListingId: LIVE,
      slug: 'rerate',
      before: 'g',
      after: 'r',
      actorUserId: MOD,
    });
    expect(dbMock.dbWrite.appListingModerationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ detail: 'store-media' }),
    });
  });
});
