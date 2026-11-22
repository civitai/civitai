import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The seam the unit tests of `readCatalog` cannot see: that the REAL scope read is the
 * public-catalog decision, kill switch included. Replacing it with the constant scope (`full`)
 * passes every other test in this directory; it fails here.
 */

const { isFliptMock } = vi.hoisted(() => ({ isFliptMock: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import { listingMediaImageSelect } from '~/server/services/blocks/listing-media-audience';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import { PUBLIC_APPS_CATALOG_DISABLED_FLAG } from '~/server/services/blocks/public-apps-catalog';

describe('liveCatalogReadDeps().resolveScope', () => {
  beforeEach(() => isFliptMock.mockReset());

  it('🔴 the kill switch thrown → `none`', async () => {
    isFliptMock.mockImplementation(
      async (flag: string) => flag === PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
    expect(await liveCatalogReadDeps().resolveScope()).toBe('none');
  });

  it('positive control: the kill switch off → the public catalog, and the switch was read', async () => {
    isFliptMock.mockResolvedValue(false);
    expect(await liveCatalogReadDeps().resolveScope()).toBe('full');
    expect(isFliptMock.mock.calls.map(([flag]) => flag)).toContain(
      PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
  });
});

/**
 * The live `loadListingExtras` read (store-listing@v1, LISTINGS-READ-MODEL.md slice 2): the media
 * query and the civitai.red override read go to the database (the shared `dbMock`), and the extras
 * of each listing come back as the stream publishes them.
 */
describe('liveCatalogReadDeps({ listings: true }).loadListingExtras', () => {
  const img = (url: string, nsfwLevel: number): ListingMediaImage =>
    ({
      url,
      nsfwLevel,
      ingestion: 'Scanned',
      needsReview: null,
      poi: false,
      minor: false,
      tosViolation: false,
      acceptableMinor: false,
      blockedFor: null,
      modelRestricted: false,
    } as ListingMediaImage);
  const redRow = {
    app_listing_id: 'lst-a1',
    slot: 'cover',
    image_id: 5505,
    url: 'covers/red-e5',
    nsfw_level: NsfwLevel.XXX,
    ingestion: 'Scanned',
    needs_review: null,
    poi: false,
    minor: false,
    tos_violation: false,
    acceptable_minor: false,
    blocked_for: null,
    model_restricted: false,
  };

  it('reads each listing’s media, override and metric, and defaults a missing metric', async () => {
    let query: { where: unknown; select: Record<string, unknown> } | undefined;
    dbMock.dbRead.appListing.findMany.mockImplementation((async (args: never) => {
      query = args;
      // As the database answers that query: screenshots filtered and in order.
      return [
        {
          id: 'lst-a1',
          description: 'desc-a1',
          createdAt: new Date('2026-02-03T04:05:06.000Z'),
          icon: img('icons/own-a1', NsfwLevel.PG),
          cover: img('covers/own-b2', NsfwLevel.PG13),
          screenshots: [
            { caption: 'cap-c3', image: img('shots/c3', NsfwLevel.R) },
            { caption: null, image: img('shots/d4', NsfwLevel.X) },
          ],
          metric: null,
        },
        {
          id: 'lst-f6',
          description: null,
          createdAt: new Date('2025-12-31T23:59:59.000Z'),
          icon: null,
          cover: null,
          screenshots: [],
          metric: { installCount: 37 },
        },
      ];
    }) as never);
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('to_regclass')) {
        return [
          {
            present: true,
            can_select: true,
            can_insert: false,
            can_update: false,
            red_slots: true,
          },
        ];
      }
      if (sql.includes('app_listing_red_media')) return [redRow];
      return [];
    }) as never);

    const { loadListingExtras } = liveCatalogReadDeps({ listings: true });
    if (!loadListingExtras) throw new Error('listings on, but no loadListingExtras');
    const extras = await loadListingExtras(['lst-a1', 'lst-f6']);

    expect(query?.where).toEqual({ id: { in: ['lst-a1', 'lst-f6'] } });
    // Only screenshots with an image, in stored order with `id` breaking ties.
    expect(query?.select.screenshots).toEqual({
      where: { imageId: { not: null } },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      select: { caption: true, image: { select: listingMediaImageSelect } },
    });
    expect(query?.select.metric).toEqual({ select: { installCount: true } });

    expect(extras.get('lst-a1')).toEqual({
      media: [
        {
          slot: 'icon',
          host: 'any',
          url: listingIconUrl({ url: 'icons/own-a1' }),
          nsfwLevel: 1,
          rating: 'pg',
        },
        {
          slot: 'cover',
          host: 'any',
          url: listingCoverUrl({ url: 'covers/own-b2' }, null),
          nsfwLevel: 2,
          rating: 'pg13',
        },
        {
          slot: 'screenshot',
          host: 'any',
          url: listingMediaEdgeUrl('shots/c3', LISTING_SCREENSHOT_WIDTH),
          nsfwLevel: 4,
          rating: 'r',
          caption: 'cap-c3',
          coverUrl: listingMediaEdgeUrl('shots/c3', LISTING_COVER_WIDTH),
        },
        {
          slot: 'screenshot',
          host: 'any',
          url: listingMediaEdgeUrl('shots/d4', LISTING_SCREENSHOT_WIDTH),
          nsfwLevel: 8,
          rating: 'x',
          caption: null,
          coverUrl: listingMediaEdgeUrl('shots/d4', LISTING_COVER_WIDTH),
        },
        // The civitai.red cover override, red-only, rated XXX on its own (not folded into X).
        {
          slot: 'cover',
          host: 'red',
          url: listingCoverUrl({ url: 'covers/red-e5' }, null),
          nsfwLevel: 16,
          rating: 'xxx',
        },
      ],
      description: 'desc-a1',
      // No metric row yet: no installs.
      installCount: 0,
      createdAt: '2026-02-03T04:05:06.000Z',
    });
    // Positive control for the default: a metric row's count is carried.
    expect(extras.get('lst-f6')).toEqual({
      media: [],
      description: null,
      installCount: 37,
      createdAt: '2025-12-31T23:59:59.000Z',
    });
  });
});
