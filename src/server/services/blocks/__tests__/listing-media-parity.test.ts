import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { registryListingMedia } from '~/server/registry-adapter/catalog-media';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';
import {
  projectListingMedia,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';
import type { ListingRedMediaImages } from '~/server/services/blocks/listing-media-split.service';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import { scopeAdmitsListingKind, narrowStoreScope } from '~/shared/utils/store-visibility-scope';

/**
 * The listing media parity harness, site side. The app index's listings read model
 * (`apps/app-index-go`, LISTINGS-READ-MODEL.md) re-implements the store's per-request media rule
 * and viewer gate in Go, and the shadow diff that later compares the two tolerates no media
 * difference. One fixture pins both: `media-parity.json`, read here and by the read model's
 * `parity_test.go`. Here each fixture listing is a database row, run through
 *
 *   - the adapter (`registryListingMedia`), which must publish exactly the fixture's media items, in
 *     its order, each with its own level and rating: that is what the Go side is fed;
 *   - the store's gate (`scopeAdmitsListingKind`, `matureRatingAllowed`) and media projection
 *     (`projectListingMedia`), which must give `expected` for every viewer.
 *
 * A change to either rule fails here until the fixture changes, and the fixture cannot change
 * without failing the Go side until the read model follows.
 */

type FixtureItem = {
  key: string;
  slot: 'icon' | 'cover' | 'screenshot';
  host: 'any' | 'red';
  nsfwLevel: number;
  rating: string;
  caption?: string | null;
};
type FixtureListing = {
  slug: string;
  kind: 'onsite' | 'offsite';
  contentRating: string | null;
  media: FixtureItem[];
};
type FixtureViewer = {
  name: string;
  redCapable: boolean;
  browsingLevel: number;
  scope: string;
};
type Expected = { icon: string | null; cover: string | null; screenshots: string[] } | null;
type Fixture = {
  viewers: FixtureViewer[];
  listings: FixtureListing[];
  expected: Record<string, Record<string, Expected>>;
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'apps/app-index-go/internal/listingread/testdata/media-parity.json'),
    'utf8'
  )
);

/** A scanned, unflagged, unrestricted image stored at `url`: one the adapter publishes. */
const image = (url: string, nsfwLevel: number): ListingMediaImage => ({
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
});

/** The database row a fixture listing stands for, and its civitai.red overrides. */
function rowOf(l: FixtureListing) {
  const own = (slot: 'icon' | 'cover') =>
    l.media.find((m) => m.host === 'any' && m.slot === slot) ?? null;
  const red = (slot: 'icon' | 'cover') =>
    l.media.find((m) => m.host === 'red' && m.slot === slot) ?? null;
  const asImage = (m: FixtureItem | null) => (m ? image(m.key, m.nsfwLevel) : null);
  const asRedImage = (m: FixtureItem | null, id: number) =>
    m ? { ...image(m.key, m.nsfwLevel), id } : null;
  const redIcon = red('icon');
  const redCover = red('cover');
  const overrides: ListingRedMediaImages | null =
    redIcon || redCover ? { icon: asRedImage(redIcon, 1), cover: asRedImage(redCover, 2) } : null;
  return {
    contentRating: l.contentRating,
    icon: asImage(own('icon')),
    cover: asImage(own('cover')),
    screenshots: l.media
      .filter((m) => m.host === 'any' && m.slot === 'screenshot')
      .map((m) => ({ caption: m.caption ?? null, image: image(m.key, m.nsfwLevel) })),
    red: overrides,
  };
}

const bySlug = new Map(FIXTURE.listings.map((l) => [l.slug, l] as const));

describe('listing media parity (media-parity.json): the site side', () => {
  it('the fixture is the matrix the read model is tested with', () => {
    expect(FIXTURE.viewers.map((v) => v.name)).toEqual([
      'anonymous SFW',
      'PG13 main',
      'R main',
      'anonymous red',
      'X red',
      'XXX red',
      'anonymous SFW, public-external',
    ]);
    expect(FIXTURE.listings.length).toBeGreaterThanOrEqual(9);
  });

  it.each(FIXTURE.listings.map((l) => [l.slug, l] as const))(
    'the adapter publishes %s as exactly the fixture media',
    (_slug, l) => {
      const row = rowOf(l);
      const published = registryListingMedia({
        icon: row.icon,
        cover: row.cover,
        screenshots: row.screenshots,
        red: row.red,
      });
      const want = l.media.map((m) => ({
        slot: m.slot,
        host: m.host,
        url:
          m.slot === 'icon'
            ? listingIconUrl({ url: m.key })
            : m.slot === 'cover'
            ? listingCoverUrl({ url: m.key }, null)
            : listingMediaEdgeUrl(m.key, LISTING_SCREENSHOT_WIDTH),
        nsfwLevel: m.nsfwLevel,
        rating: m.rating,
        ...(m.slot === 'screenshot'
          ? {
              caption: m.caption ?? null,
              coverUrl: listingMediaEdgeUrl(m.key, LISTING_COVER_WIDTH),
            }
          : {}),
      }));
      expect(published).toEqual(want);
    }
  );

  describe.each(FIXTURE.viewers.map((v) => [v.name, v] as const))('viewer %s', (name, v) => {
    it.each(FIXTURE.listings.map((l) => [l.slug] as const))('%s', (slug) => {
      const l = bySlug.get(slug)!;
      const want = FIXTURE.expected[name][slug];
      const scope = narrowStoreScope(v.scope);
      const shown =
        scope !== 'none' &&
        scopeAdmitsListingKind(scope, l.kind) &&
        matureRatingAllowed(l.contentRating, matureRatingsAllowed(v.redCapable, v.browsingLevel));
      if (want === null) {
        expect(shown).toBe(false);
        return;
      }
      expect(shown).toBe(true);
      const row = rowOf(l);
      const got = projectListingMedia(row, {
        kind: 'public',
        audience: { redCapable: v.redCapable, viewerBrowsingLevel: v.browsingLevel },
        red: row.red,
      });
      const item = (key: string) => l.media.find((m) => m.key === key)!;
      const coverWant =
        want.cover === null
          ? null
          : item(want.cover).slot === 'screenshot'
          ? listingMediaEdgeUrl(want.cover, LISTING_COVER_WIDTH)
          : listingCoverUrl({ url: want.cover }, null);
      expect(got).toEqual({
        iconUrl: want.icon === null ? null : listingIconUrl({ url: want.icon }),
        coverUrl: coverWant,
        screenshots: want.screenshots.map((key) => ({
          url: listingMediaEdgeUrl(key, LISTING_SCREENSHOT_WIDTH),
          caption: item(key).caption ?? null,
        })),
      });
    });
  });
});
