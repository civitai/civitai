import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { registryListingMedia, registrySubListing } from '~/server/registry-adapter/catalog-media';
import type { ListingStoreFields } from '~/server/registry-adapter/catalog-source';
import { listingBody, type CatalogApp } from '~/server/registry-adapter/entities';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';
import {
  projectSubListingCard,
  type StoreSubListingRow,
} from '~/server/services/blocks/app-sub-listing-store.service';
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
import { imageRatingOfNsfwLevel } from '~/shared/constants/browsingLevel.constants';
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
 *   - the adapter's `listingBody`, whose two ratings must be the fixture's: the app entity's
 *     (`appContentRating`, which falls back to the block's) and the listing's own, the one gated on;
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
  /** The listing's own rating: the column the store gates on. */
  contentRating: string | null;
  /** The backing block's rating, for a listing that has one. */
  blockContentRating?: string;
  /** The app entity's rating the stream carries as `contentRating`; absent, the listing's own. */
  appContentRating?: string;
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
  it('the fixture carries the case the gating rating matters for', () => {
    // The row the gating rating matters for: no listing rating, a block rating above PG.
    expect(
      FIXTURE.listings.some(
        (l) => l.contentRating === null && l.blockContentRating && l.appContentRating
      )
    ).toBe(true);
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

  it.each(FIXTURE.listings.map((l) => [l.slug, l] as const))(
    'the adapter publishes %s with the fixture ratings',
    (_slug, l) => {
      const app: CatalogApp = {
        listing: {
          slug: l.slug,
          kind: l.kind,
          name: l.slug,
          tagline: null,
          category: null,
          contentRating: l.contentRating,
          iconUrl: null,
          creatorUsername: null,
          externalUrl: null,
          sourceRepoUrl: null,
          forkOf: null,
        },
        block: l.blockContentRating
          ? {
              id: `ab_${l.slug}`,
              blockId: l.slug,
              version: '1.0.0',
              status: 'approved',
              contentRating: l.blockContentRating,
              manifest: {},
            }
          : null,
        approved: [],
      };
      const store: ListingStoreFields = {
        id: `apl_${l.slug}`,
        appBlockId: null,
        creator: null,
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
        reviewCount: 0,
        isBeta: false,
        isOfficial: false,
        openCount: null,
        updatedAt: null,
        hasPage: false,
        liveUrl: null,
        description: null,
        media: [],
        installCount: 0,
        createdAt: '2026-01-02T03:04:05.000Z',
        serialId: 1,
        collaborators: [],
        scopes: [],
        connectScopes: [],
        issueTrackerUrl: null,
        actionsRunSource: null,
        betaMessage: null,
        forkable: false,
        connectClientId: null,
        forkOf: null,
        subListings: [],
        subListingsOmitted: 0,
      };
      const body = listingBody(app, `urn:apps.civitai.com:app/${l.slug}`, store);
      expect([body.contentRating, body.listingContentRating]).toEqual([
        l.appContentRating ?? l.contentRating,
        l.contentRating,
      ]);
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

type FixtureSubListing = {
  id: string;
  parent: string;
  contentRating: string | null;
  cardContentRating: string | null;
  image: { key: string; nsfwLevel: number } | null;
};
type ExpectedSubListing = {
  contentRating: string | null;
  cover: string | null;
  icon: string | null;
} | null;
const SUB_FIXTURE: {
  items: FixtureSubListing[];
  expected: Record<string, Record<string, ExpectedSubListing>>;
} = (FIXTURE as unknown as { subListings: never }).subListings;

/**
 * The `readStoreSubListingsOfParents` row a fixture sub-listing stands for: the item under its
 * fixture parent, whose own icon and cover (never its red overrides or screenshots) are the
 * card's fallbacks.
 */
function subListingRowOf(it: FixtureSubListing): StoreSubListingRow {
  const parent = bySlug.get(it.parent)!;
  const own = (slot: 'icon' | 'cover') =>
    parent.media.find((m) => m.host === 'any' && m.slot === slot) ?? null;
  const parentImage = (slot: 'icon' | 'cover') => {
    const m = own(slot);
    return {
      url: m?.key ?? null,
      nsfw_level: m?.nsfwLevel ?? null,
      ingestion: m ? ('Scanned' as const) : null,
    };
  };
  const cover = parentImage('cover');
  const icon = parentImage('icon');
  return {
    id: it.id,
    title: `title of ${it.id}`,
    tagline: null,
    sub_path: 'x',
    content_rating: it.contentRating,
    author_user_id: 9,
    author_username: null,
    author_image: null,
    parent_id: `apl_${parent.slug}`,
    parent_slug: parent.slug,
    parent_name: parent.slug,
    parent_kind: parent.kind,
    parent_category: null,
    parent_content_rating: parent.contentRating,
    parent_cover_url: cover.url,
    parent_cover_nsfw_level: cover.nsfw_level,
    parent_cover_ingestion: cover.ingestion,
    parent_cover_needs_review: null,
    parent_cover_poi: false,
    parent_cover_minor: false,
    parent_cover_tos_violation: false,
    parent_cover_acceptable_minor: false,
    parent_cover_blocked_for: null,
    parent_cover_model_restricted: false,
    parent_icon_url: icon.url,
    parent_icon_nsfw_level: icon.nsfw_level,
    parent_icon_ingestion: icon.ingestion,
    parent_icon_needs_review: null,
    parent_icon_poi: false,
    parent_icon_minor: false,
    parent_icon_tos_violation: false,
    parent_icon_acceptable_minor: false,
    parent_icon_blocked_for: null,
    parent_icon_model_restricted: false,
    // An off-site parent's working link template, so its items have somewhere to link.
    parent_link_template: parent.kind === 'offsite' ? 'https://items.example.com/i/{id}' : null,
    image_url: it.image?.key ?? null,
    image_nsfw_level: it.image?.nsfwLevel ?? null,
    image_ingestion: it.image ? 'Scanned' : null,
    image_needs_review: null,
    image_poi: false,
    image_minor: false,
    image_tos_violation: false,
    image_acceptable_minor: false,
    image_blocked_for: null,
    image_model_restricted: false,
    image_public: it.image ? true : null,
    parent_listing_id: `apl_${parent.slug}`,
    sort_time: '2026-01-03T00:00:00.000000Z',
    parent_item_count: 1,
  };
}

/**
 * Sub-listing cards (`subListings`), site side: each fixture item is a row the stream read returns
 * under its fixture parent, run through the adapter (`registrySubListing`, which must publish the
 * fixture's card rating and image: what the Go side is fed) and through the store grid's gate (the
 * parent's, as `listingMatureFilter` and the scope apply it, and the item's own rating under the
 * same rule, `subListingMatureFilter`) and card projection (`projectSubListingCard`), which must
 * give `subListings.expected` for every viewer. The Go side is `parity_test.go` TestSubListingParity.
 */
describe('sub-listing card parity (media-parity.json subListings): the site side', () => {
  it('the fixture covers the cases the card ceiling differs on', () => {
    expect(SUB_FIXTURE.items.length).toBeGreaterThanOrEqual(8);
    // An item rated above its parent, an unrated item, one under an off-site parent, one without
    // an image.
    expect(SUB_FIXTURE.items.some((i) => i.contentRating === null)).toBe(true);
    expect(SUB_FIXTURE.items.some((i) => i.image === null)).toBe(true);
    expect(SUB_FIXTURE.items.some((i) => bySlug.get(i.parent)?.kind === 'offsite')).toBe(true);
  });

  it.each(SUB_FIXTURE.items.map((i) => [i.id, i] as const))(
    'the adapter publishes %s with the fixture card rating and image',
    (_id, it) => {
      const item = registrySubListing(subListingRowOf(it));
      expect(item).not.toBeNull();
      expect(item?.cardContentRating).toBe(it.cardContentRating);
      expect(item?.contentRating).toBe(it.contentRating);
      expect(item?.image).toEqual(
        it.image
          ? {
              url: listingMediaEdgeUrl(it.image.key, LISTING_COVER_WIDTH),
              nsfwLevel: it.image.nsfwLevel,
              rating: imageRatingOfNsfwLevel(it.image.nsfwLevel),
            }
          : null
      );
    }
  );

  describe.each(FIXTURE.viewers.map((v) => [v.name, v] as const))('viewer %s', (name, v) => {
    it.each(SUB_FIXTURE.items.map((i) => [i.id, i] as const))('%s', (id, it) => {
      const parent = bySlug.get(it.parent)!;
      const want = SUB_FIXTURE.expected[name][id];
      const scope = narrowStoreScope(v.scope);
      const allowed = matureRatingsAllowed(v.redCapable, v.browsingLevel);
      const shown =
        scope !== 'none' &&
        scopeAdmitsListingKind(scope, parent.kind) &&
        matureRatingAllowed(parent.contentRating, allowed) &&
        matureRatingAllowed(it.contentRating, allowed);
      if (want === null) {
        expect(shown).toBe(false);
        return;
      }
      expect(shown).toBe(true);
      const card = projectSubListingCard(subListingRowOf(it), {
        browsingLevel: v.browsingLevel,
        redCapable: v.redCapable,
      });
      const coverWant =
        want.cover === null
          ? null
          : want.cover === it.image?.key
          ? listingMediaEdgeUrl(want.cover, LISTING_COVER_WIDTH)
          : listingCoverUrl({ url: want.cover }, null);
      expect({
        contentRating: card?.contentRating,
        coverUrl: card?.coverUrl,
        iconUrl: card?.parent.iconUrl,
      }).toEqual({
        contentRating: want.contentRating,
        coverUrl: coverWant,
        iconUrl: want.icon === null ? null : listingIconUrl({ url: want.icon }),
      });
    });
  });
});
