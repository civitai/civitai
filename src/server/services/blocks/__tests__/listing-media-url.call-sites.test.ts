import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The URL each listing-media CALL SITE builds, through the REAL `getEdgeUrl` (only the client env,
 * the database and the catalog cache are stubbed). `listing-media-url.test.ts` pins the builder and
 * the gated public projections; these are the three sites outside them:
 *
 *   (a) the moderator review preview's screenshots (`getListingPreviewForReview`);
 *   (b) the sub-listing card cover (`projectSubListingCard`);
 *   (c) the author's edit prefill (`getMyListingForEdit`): icon, cover, screenshots and the
 *       civitai.red icon / cover overrides.
 *
 * Each assertion is a literal URL carrying `anim=false`, the site's `width=` and `optimized=true`,
 * so a site that drops a flag, builds its own URL (an aliased `getEdgeUrl` included), passes the
 * wrong width class or the wrong image fails here. Fixture keys are pairwise distinct and distinct
 * from every width and constant in the assertions.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' } }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async () => [],
  bustCacheTag: vi.fn(async () => undefined),
}));

const { redSlots } = vi.hoisted(() => ({
  redSlots: {
    current: { available: false, staged: false, redIconId: null, redCoverId: null } as {
      available: boolean;
      staged: boolean;
      redIconId: number | null;
      redCoverId: number | null;
    },
  },
}));
vi.mock('~/server/services/blocks/listing-media-split.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ListingMediaSplit>()),
  readListingRedSlots: vi.fn(async () => redSlots.current),
}));
vi.mock('~/server/services/blocks/app-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccess>()),
  resolveListingAccess: vi.fn(async () => ({ role: 'owner' })),
}));
import type * as ListingMediaSplit from '~/server/services/blocks/listing-media-split.service';
import type * as AppAccess from '~/server/services/blocks/app-access.service';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getListingPreviewForReview } from '~/server/services/blocks/app-listing.service';
import { projectSubListingCard } from '~/server/services/blocks/app-sub-listing-store.service';
import { getMyListingForEdit } from '~/server/services/blocks/offsite-listing.service';

const { PG } = NsfwLevel;

function scanned(id: number, url: string) {
  return {
    id,
    url,
    nsfwLevel: PG,
    ingestion: 'Scanned',
    needsReview: null as string | null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null as string | null,
  };
}

describe('(a) the moderator review preview', () => {
  const LISTING_ID = 'apl_callsite_review_01';

  beforeEach(() => {
    dbMock.dbRead.appListing.findUnique.mockImplementation(async () => ({
      id: LISTING_ID,
      serialId: 57,
      kind: 'offsite',
      slug: 'callsite-review',
      name: 'Callsite Review',
      tagline: null,
      description: null,
      category: null,
      contentRating: 'g',
      externalUrl: 'https://example.com/app',
      connectClientId: null,
      connectRequestedScopes: null,
      status: 'pending',
      revisionOfId: null,
      updatedAt: new Date('2026-02-03T04:05:06.000Z'),
      appBlockId: null,
      appBlock: null,
      metric: null,
      user: { id: 9, username: 'dev', image: null },
      icon: scanned(31, 'rv-icon-q7'),
      cover: scanned(32, 'rv-cover-w3'),
      screenshots: [
        { caption: 'cap-first', image: scanned(33, 'rv-shot-e5') },
        { caption: null, image: scanned(34, 'rv-shot-t9') },
      ],
    }));
  });

  it('builds every screenshot (and the icon / cover beside them) as a single-frame optimized still', async () => {
    const preview = await getListingPreviewForReview({ listingId: LISTING_ID });
    expect(preview?.media).toEqual({
      icon: {
        imageId: 31,
        url: 'https://image.test/rv-icon-q7/anim=false,width=320,optimized=true/rv-icon-q7.jpeg',
        nsfwLevel: PG,
      },
      cover: {
        imageId: 32,
        url: 'https://image.test/rv-cover-w3/anim=false,width=1200,optimized=true/rv-cover-w3.jpeg',
        nsfwLevel: PG,
      },
      redIcon: null,
      redCover: null,
      screenshots: [
        {
          imageId: 33,
          url: 'https://image.test/rv-shot-e5/anim=false,width=1200,optimized=true/rv-shot-e5.jpeg',
          nsfwLevel: PG,
          caption: 'cap-first',
        },
        {
          imageId: 34,
          url: 'https://image.test/rv-shot-t9/anim=false,width=1200,optimized=true/rv-shot-t9.jpeg',
          nsfwLevel: PG,
          caption: null,
        },
      ],
    });
  });
});

describe('(b) the sub-listing card', () => {
  type Row = Parameters<typeof projectSubListingCard>[0];

  const row: Row = {
    id: 'asl_callsite_01',
    title: 'Callsite Item',
    tagline: null,
    sub_path: 'item-path',
    content_rating: 'g',
    author_user_id: 12,
    author_username: 'author',
    author_image: null,
    parent_id: 'apl_callsite_parent_01',
    parent_slug: 'callsite-parent',
    parent_name: 'Callsite Parent',
    parent_kind: 'onsite',
    parent_category: null,
    parent_content_rating: 'g',
    parent_cover_url: 'sub-parent-cover-r4',
    parent_cover_nsfw_level: PG,
    parent_cover_ingestion: 'Scanned',
    parent_cover_needs_review: null,
    parent_cover_poi: false,
    parent_cover_minor: false,
    parent_cover_tos_violation: false,
    parent_cover_acceptable_minor: false,
    parent_cover_blocked_for: null,
    parent_icon_url: 'sub-parent-icon-y6',
    parent_icon_nsfw_level: PG,
    parent_icon_ingestion: 'Scanned',
    parent_icon_needs_review: null,
    parent_icon_poi: false,
    parent_icon_minor: false,
    parent_icon_tos_violation: false,
    parent_icon_acceptable_minor: false,
    parent_icon_blocked_for: null,
    parent_link_template: null,
    image_url: 'sub-item-image-u8',
    image_nsfw_level: PG,
    image_ingestion: 'Scanned',
    image_needs_review: null,
    image_poi: false,
    image_minor: false,
    image_tos_violation: false,
    image_acceptable_minor: false,
    image_blocked_for: null,
    image_public: true,
  };

  it("builds the item's own image as the cover, a single-frame optimized still at the cover width", () => {
    const card = projectSubListingCard(row, { redCapable: false });
    expect(card?.coverUrl).toBe(
      'https://image.test/sub-item-image-u8/anim=false,width=1200,optimized=true/sub-item-image-u8.jpeg'
    );
    expect(card?.parent.iconUrl).toBe(
      'https://image.test/sub-parent-icon-y6/anim=false,width=320,optimized=true/sub-parent-icon-y6.jpeg'
    );
  });

  // Positive control for the case above: with no item image the cover is the PARENT's, so the
  // assertion above is about the item-image branch, not the parent fallback.
  it('falls back to the parent cover when the item has no image', () => {
    const card = projectSubListingCard(
      { ...row, image_url: null, image_ingestion: null, image_public: null },
      { redCapable: false }
    );
    expect(card?.coverUrl).toBe(
      'https://image.test/sub-parent-cover-r4/anim=false,width=1200,optimized=true/sub-parent-cover-r4.jpeg'
    );
  });
});

describe('(c) the author edit prefill', () => {
  const LISTING_ID = 'apl_callsite_edit_01';
  const RED_ICON = 91;
  const RED_COVER = 92;

  beforeEach(() => {
    for (const c of [dbMock.dbRead, dbMock.dbWrite]) {
      // One row serving both reads the prefill issues (the editable gate and the edit view).
      c.appListing.findUnique.mockImplementation(async () => ({
        id: LISTING_ID,
        kind: 'offsite',
        slug: 'callsite-edit',
        status: 'draft',
        userId: 12,
        revisionOfId: null,
        name: 'Callsite Edit',
        tagline: null,
        description: null,
        category: null,
        contentRating: 'g',
        externalUrl: 'https://example.com/app',
        connectClientId: null,
        connectRequestedScopes: null,
        connectScopeJustifications: null,
        iconId: 81,
        coverId: 82,
        icon: { url: 'ed-icon-a2' },
        cover: { url: 'ed-cover-s4' },
        screenshots: [
          { id: 'sc_1', imageId: 83, order: 0, caption: 'one', image: { url: 'ed-shot-d6' } },
          { id: 'sc_2', imageId: 84, order: 1, caption: null, image: { url: 'ed-shot-f8' } },
        ],
      }));
    }
    dbMock.dbWrite.image.findMany.mockImplementation(async () => [
      { id: RED_ICON, url: 'ed-red-icon-g1' },
      { id: RED_COVER, url: 'ed-red-cover-h3' },
    ]);
    redSlots.current = {
      available: true,
      staged: true,
      redIconId: RED_ICON,
      redCoverId: RED_COVER,
    };
  });

  it('builds the icon, cover and screenshots as single-frame optimized stills', async () => {
    const res = await getMyListingForEdit({ listingId: LISTING_ID, userId: 12 });
    expect(res.assets).toEqual({
      icon: {
        imageId: 81,
        url: 'https://image.test/ed-icon-a2/anim=false,width=320,optimized=true/ed-icon-a2.jpeg',
      },
      cover: {
        imageId: 82,
        url: 'https://image.test/ed-cover-s4/anim=false,width=1200,optimized=true/ed-cover-s4.jpeg',
      },
      screenshots: [
        {
          id: 'sc_1',
          imageId: 83,
          url: 'https://image.test/ed-shot-d6/anim=false,width=1200,optimized=true/ed-shot-d6.jpeg',
          caption: 'one',
          order: 0,
        },
        {
          id: 'sc_2',
          imageId: 84,
          url: 'https://image.test/ed-shot-f8/anim=false,width=1200,optimized=true/ed-shot-f8.jpeg',
          caption: null,
          order: 1,
        },
      ],
    });
  });

  it('builds the civitai.red icon / cover overrides the same way, at the icon / cover widths', async () => {
    const res = await getMyListingForEdit({ listingId: LISTING_ID, userId: 12 });
    expect(res.redMedia).toEqual({
      available: true,
      icon: {
        imageId: RED_ICON,
        url: 'https://image.test/ed-red-icon-g1/anim=false,width=320,optimized=true/ed-red-icon-g1.jpeg',
      },
      cover: {
        imageId: RED_COVER,
        url: 'https://image.test/ed-red-cover-h3/anim=false,width=1200,optimized=true/ed-red-cover-h3.jpeg',
      },
    });
  });
});
