import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T8 SEAM — a moderator re-rates a split listing's icon PG → R. Three components decide what
 * happens next and each is tested alone elsewhere; here they share ONE image table and the
 * rating one of them writes is the rating the next one reads:
 *
 *   1. `reDeriveListingRatingInTx` (the re-rate re-derive, split-aware) decides the rating;
 *   2. `getListingDetail` (the real store read: maturity gate + per-image media gate) renders it
 *      for civitai.com and for civitai.red;
 *   3. `loadListingAssetScansBatch` + `computeListingProblems` tell the author.
 *
 * The unsplit control runs the same re-rate without the split: the listing leaves civitai.com.
 */

vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async () => [],
  bustCacheTag: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getListingDetail } from '~/server/services/blocks/app-listing.service';
import { loadListingAssetScansBatch } from '~/server/services/blocks/app-listing-assets.service';
import { reDeriveListingRatingInTx } from '~/server/services/blocks/app-listing-rating-rederive.service';
import { computeListingProblems } from '~/server/services/blocks/listing-problems';

const LISTING_ID = 'apl_split_seam';
const ICON = 31;
const COVER = 32;
const SHOT = 33;
const MOD = 4501;
/** A viewer who opted into PG through R. */
const R_VIEWER = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R;

type Img = { id: number; url: string; nsfwLevel: number; ingestion: string };
const images = new Map<number, Img>();
let contentRating: string;
let split: boolean;

const gated = (id: number) => {
  const i = images.get(id)!;
  return {
    url: i.url,
    nsfwLevel: i.nsfwLevel,
    ingestion: i.ingestion,
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
  };
};

function storeRow() {
  return {
    id: LISTING_ID,
    serialId: 77,
    kind: 'offsite',
    slug: 'split-seam',
    name: 'Split Seam',
    tagline: 'x',
    description: 'x',
    category: 'tools',
    contentRating,
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    status: 'approved',
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    appBlockId: null,
    appBlock: null,
    metric: null,
    user: { id: 9, username: 'dev', image: null },
    icon: gated(ICON),
    cover: gated(COVER),
    screenshots: [{ caption: 'cap-0', image: gated(SHOT) }],
  };
}

/** The transaction the re-derive runs in, over the same image table and rating. */
function tx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Prisma.sql(strings, ...values).text;
      if (text.includes('to_regclass'))
        return [{ present: true, can_select: true, can_insert: true, can_update: true }];
      if (text.includes('FROM app_listing_red_media')) return [{ split }];
      return [{ id: LISTING_ID }]; // the row lock
    },
    appListing: {
      findUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) =>
        args.select.iconId
          ? { iconId: ICON, coverId: COVER }
          : { slug: 'split-seam', kind: 'offsite', contentRating, appBlock: null },
      update: async (args: { data: { contentRating: string } }) => {
        contentRating = args.data.contentRating;
        return {};
      },
    },
    appListingScreenshot: { findMany: async () => [{ imageId: SHOT }] },
    image: {
      findMany: async (args: { where: { id: { in: number[] } } }) =>
        args.where.id.in.map((id) => ({
          id,
          nsfwLevel: images.get(id)!.nsfwLevel,
          ingestion: 'Scanned',
        })),
    },
    appListingModerationEvent: { findFirst: async () => null, create: async () => ({}) },
  } as never;
}

async function moderatorReratesIcon(nsfwLevel: number) {
  const previousNsfwLevel = images.get(ICON)!.nsfwLevel;
  images.get(ICON)!.nsfwLevel = nsfwLevel;
  await reDeriveListingRatingInTx(tx(), {
    appListingId: LISTING_ID,
    imageId: ICON,
    previousNsfwLevel,
    actorUserId: MOD,
  });
}

const detail = (redCapable: boolean, viewerBrowsingLevel?: number) =>
  getListingDetail(
    { slug: 'split-seam' },
    { redCapable, scope: 'full', floor: 'public', viewerBrowsingLevel }
  );

async function authorProblems() {
  const scans = await loadListingAssetScansBatch(
    [{ id: LISTING_ID, iconId: ICON, coverId: COVER }],
    {
      appListingScreenshot: {
        findMany: async () => [{ appListingId: LISTING_ID, imageId: SHOT }],
      },
      image: {
        findMany: async (args: { where: { id: { in: number[] } } }) =>
          args.where.id.in.map((id) => ({
            id,
            ingestion: 'Scanned',
            nsfwLevel: images.get(id)!.nsfwLevel,
          })),
      },
    } as never
  );
  return computeListingProblems({
    kind: 'offsite',
    iconId: ICON,
    coverId: COVER,
    screenshotCount: 1,
    description: 'x',
    tagline: 'x',
    category: 'tools',
    assetScans: scans.get(LISTING_ID),
    status: 'approved',
    contentRating,
    declaredContentRating: null,
  }).problems.map((p) => p.code);
}

beforeEach(() => {
  images.clear();
  images.set(ICON, { id: ICON, url: 'icon.png', nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' });
  images.set(COVER, { id: COVER, url: 'cover.png', nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' });
  images.set(SHOT, { id: SHOT, url: 'shot.png', nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' });
  contentRating = 'g';
  dbMock.dbRead.appListing.findFirst.mockImplementation(async () => storeRow());
  dbMock.dbRead.appListing.findMany.mockImplementation(async () => [storeRow()]);
});

describe('T8 — a split listing whose icon is re-rated R', () => {
  beforeEach(() => {
    split = true;
  });

  it('🔴 stays on civitai.com at its rating, with a placeholder icon', async () => {
    await moderatorReratesIcon(NsfwLevel.R);

    expect(contentRating).toBe('g');
    const com = await detail(false, R_VIEWER);
    expect(com, 'the listing left civitai.com').not.toBeNull();
    expect(com!.iconUrl).toBeNull();
    // The cover is untouched and still renders.
    expect(com!.coverUrl).toBe('edge:cover.png@1200');
  });

  it('civitai.red still shows the icon to a viewer who opted into R, and only to them', async () => {
    await moderatorReratesIcon(NsfwLevel.R);

    expect((await detail(true, R_VIEWER))!.iconUrl).toBe('edge:icon.png@256');
    expect((await detail(true, undefined))!.iconUrl).toBeNull();
  });

  it('🔴 the author is told, in listing-problems', async () => {
    await moderatorReratesIcon(NsfwLevel.R);

    expect(await authorProblems()).toEqual(['sfw-slot-mature']);
  });
});

describe('control — the same re-rate on an UNSPLIT listing', () => {
  beforeEach(() => {
    split = false;
  });

  it('raises the listing out of civitai.com (today’s behaviour)', async () => {
    await moderatorReratesIcon(NsfwLevel.R);

    expect(contentRating).toBe('r');
    expect(await detail(false, R_VIEWER)).toBeNull();
    expect((await detail(true, R_VIEWER))!.iconUrl).toBe('edge:icon.png@256');
  });

  it('a listing hidden from civitai.com raises no civitai.com media problem', async () => {
    await moderatorReratesIcon(NsfwLevel.R);

    expect(await authorProblems()).toEqual([]);
  });
});
