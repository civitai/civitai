import { describe, expect, it, vi } from 'vitest';

/**
 * The listing-media gate in isolation. The surfaces that use it are driven through their own
 * entry points in `listing-media-audience.seam.test.ts` (store reads),
 * `listing-media-surfaces.test.ts` (run-page icon, post chip) and
 * `app-sub-listing-store.behavior.test.ts` (sub-listing cards).
 *
 * Levels used: PG = 1, PG-13 = 2, R = 4, XXX = 16 — and Blocked = 32 only where it is the point.
 * Urls are pairwise distinct.
 */

// `civitai.red` is configured as a blue alias AND the red primary, as in production: the gate must
// key off red CAPABILITY, which the colour walk would get wrong.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));

import { NsfwLevel } from '~/server/common/enums';
import {
  isListingImageVisible,
  isSfwEligibleLevel,
  listingMediaCeiling,
  MODERATOR_REVIEW_MEDIA,
  projectListingMedia,
  SFW_PUBLIC_MEDIA,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';
import { isRedCapableHost } from '~/server/utils/server-domain';

const { PG, PG13, R, XXX, Blocked } = NsfwLevel;

function img(url: string, nsfwLevel: number, over: Partial<ListingMediaImage> = {}) {
  return {
    url,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ...over,
  } satisfies ListingMediaImage;
}

describe('isRedCapableHost — the one red-host test', () => {
  it('is true for the red primary even though the colour walk reads it as blue', () => {
    expect(isRedCapableHost('civitai.red')).toBe(true);
    expect(isRedCapableHost('CIVITAI.RED')).toBe(true);
  });
  it('is false for a SFW host and fails closed on an empty / missing host', () => {
    expect(isRedCapableHost('civitai.com')).toBe(false);
    expect(isRedCapableHost('')).toBe(false);
    expect(isRedCapableHost(undefined)).toBe(false);
    expect(isRedCapableHost(null)).toBe(false);
  });
});

describe('listingMediaCeiling', () => {
  it('off a red host: SFW, capped by the listing rating, and the viewer is NOT consulted', () => {
    expect(listingMediaCeiling({ redCapable: false }, 'g')).toBe(PG);
    expect(listingMediaCeiling({ redCapable: false }, 'pg13')).toBe(PG | PG13);
    // An R-rated listing still shows only SFW media off a red host.
    expect(listingMediaCeiling({ redCapable: false }, 'r')).toBe(PG | PG13);
    // A viewer who opted into XXX does not widen a SFW host.
    expect(listingMediaCeiling({ redCapable: false, viewerBrowsingLevel: PG | R | XXX }, 'x')).toBe(
      PG | PG13
    );
    // Unknown / null rating fails closed to PG.
    expect(listingMediaCeiling({ redCapable: false }, null)).toBe(PG);
  });

  it('on a red host: the viewer level, up to XXX, never Blocked, and not capped by the rating', () => {
    expect(listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: PG | R | XXX }, 'g')).toBe(
      PG | R | XXX
    );
    expect(
      listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: PG | R | Blocked }, 'g')
    ).toBe(PG | R);
    // Anonymous (no level) and a nonsense 0 both read as the public floor.
    expect(listingMediaCeiling({ redCapable: true }, 'x')).toBe(PG);
    expect(listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: 0 }, 'x')).toBe(PG);
  });
});

describe('isListingImageVisible — fail-closed on every uncertain state', () => {
  const ceiling = PG | PG13 | R;
  it('shows a scanned, unflagged image within the ceiling', () => {
    expect(isListingImageVisible(img('v.png', R), ceiling)).toBe(true);
  });
  it.each([
    ['above the ceiling', img('a.png', XXX)],
    ['unrated (level 0)', img('b.png', 0)],
    ['still scanning', img('c.png', PG, { ingestion: 'Pending' })],
    ['blocked by the scanner', img('d.png', PG, { ingestion: 'Blocked' })],
    ['flagged for review', img('e.png', PG, { needsReview: 'minor' })],
    ['hard-blocked', img('f.png', PG, { blockedFor: 'tos' })],
    ['a ToS violation', img('g.png', PG, { tosViolation: true })],
  ])('hides an image that is %s', (_label, image) => {
    expect(isListingImageVisible(image, ceiling)).toBe(false);
  });
  it('hides a missing image', () => {
    expect(isListingImageVisible(null, ceiling)).toBe(false);
  });
});

describe('projectListingMedia', () => {
  const row = {
    contentRating: 'g',
    icon: img('icon-r.png', R),
    cover: img('cover-pending.png', PG, { ingestion: 'Pending' }),
    screenshots: [
      { caption: 'one', image: img('shot-r.png', R) },
      { caption: 'two', image: null },
      { caption: 'three', image: img('shot-pg.png', PG) },
      { caption: 'four', image: img('shot-pg13.png', PG13) },
    ],
  };

  it('the default public view hides what a SFW `g` card may not show, and falls back', () => {
    expect(projectListingMedia(row, SFW_PUBLIC_MEDIA)).toEqual({
      iconUrl: null,
      coverUrl: 'edge:shot-pg.png@1200',
      screenshots: [{ url: 'edge:shot-pg.png@1200', caption: 'three' }],
    });
  });

  it('a red, R-opted-in view shows the R media and keeps stored order', () => {
    const view = {
      kind: 'public' as const,
      audience: { redCapable: true, viewerBrowsingLevel: PG | PG13 | R },
    };
    expect(projectListingMedia(row, view)).toEqual({
      iconUrl: 'edge:icon-r.png@256',
      // The cover is still scanning, so it is not shown even here.
      coverUrl: 'edge:shot-r.png@1200',
      screenshots: [
        { url: 'edge:shot-r.png@1200', caption: 'one' },
        { url: 'edge:shot-pg.png@1200', caption: 'three' },
        { url: 'edge:shot-pg13.png@1200', caption: 'four' },
      ],
    });
  });

  it('the moderator review view shows everything attached, ungated', () => {
    expect(projectListingMedia(row, MODERATOR_REVIEW_MEDIA)).toEqual({
      iconUrl: 'edge:icon-r.png@256',
      coverUrl: 'edge:cover-pending.png@1200',
      screenshots: [
        { url: 'edge:shot-r.png@1200', caption: 'one' },
        { url: 'edge:shot-pg.png@1200', caption: 'three' },
        { url: 'edge:shot-pg13.png@1200', caption: 'four' },
      ],
    });
  });

  it('never returns a level or a moderation flag — only urls and captions', () => {
    const out = JSON.stringify(projectListingMedia(row, MODERATOR_REVIEW_MEDIA));
    for (const key of ['nsfwLevel', 'ingestion', 'needsReview', 'blockedFor', 'tosViolation']) {
      expect(out).not.toContain(key);
    }
  });
});

describe('isSfwEligibleLevel', () => {
  it('admits unrated and SFW levels only', () => {
    expect([0, PG, PG13, PG | PG13].map(isSfwEligibleLevel)).toEqual([true, true, true, true]);
    expect([R, XXX, Blocked, PG | R].map(isSfwEligibleLevel)).toEqual([false, false, false, false]);
  });
});
