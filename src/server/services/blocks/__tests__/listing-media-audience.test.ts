import { describe, expect, it, vi } from 'vitest';

/**
 * The listing-media gate in isolation. The surfaces that use it are driven through their own
 * entry points in `listing-media-audience.seam.test.ts` (store reads),
 * `listing-media-surfaces.test.ts` (post chip) and
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
  isModerationFlagSet,
  listingMediaCeiling,
  listingMediaImageSelect,
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

  // THE RED-HOST RULE: the non-red ceiling for the same listing, UNION the viewer's opted-in
  // levels, never Blocked. Fixture viewer levels (R alone = 4, PG|R = 5, PG|R|XXX = 21) are
  // distinct from every constant the code names (PG = 1, SFW = 3, all rated = 31).
  it('on a red host: the non-red ceiling UNION the viewer level, up to XXX, never Blocked', () => {
    // The viewer adds mature levels, uncapped by the listing rating…
    expect(listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: PG | R | XXX }, 'g')).toBe(
      PG | R | XXX
    );
    // …but never Blocked.
    expect(
      listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: PG | R | Blocked }, 'g')
    ).toBe(PG | R);
    // A viewer who opted into R alone still keeps what the non-red host shows (PG-13 on pg13).
    expect(listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: R }, 'pg13')).toBe(
      PG | PG13 | R
    );
  });

  // A red host never shows LESS than a non-red host: with no viewer level (anonymous, or not
  // opted in) it is EXACTLY the non-red ceiling, rating cap included.
  it.each([
    ['g', PG],
    ['pg13', PG | PG13],
    ['x', PG | PG13],
    [null, PG],
  ])(
    'on a red host with no viewer level, a %s listing gets the non-red ceiling',
    (rating, want) => {
      expect(listingMediaCeiling({ redCapable: true }, rating)).toBe(want);
      // A nonsense 0 is "no level" too, not "hide everything".
      expect(listingMediaCeiling({ redCapable: true, viewerBrowsingLevel: 0 }, rating)).toBe(want);
      expect(listingMediaCeiling({ redCapable: false }, rating)).toBe(want);
    }
  );
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

describe('projectListingMedia — the civitai.red icon / cover overrides', () => {
  // A `g` listing with a PG icon and cover; the overrides are R (icon) and XXX (cover).
  const row = {
    contentRating: 'g',
    icon: img('own-icon.png', PG),
    cover: img('own-cover.png', PG),
    screenshots: [{ caption: 'one', image: img('shot-pg.png', PG) }],
  };
  const red = { icon: img('red-icon.png', R), cover: img('red-cover.png', XXX) };
  const ALL_OPTED = PG | PG13 | R | NsfwLevel.X | XXX;
  const view = (redCapable: boolean, viewerBrowsingLevel?: number) => ({
    kind: 'public' as const,
    audience: { redCapable, viewerBrowsingLevel },
    red,
  });

  it('🔴 a red host shows each override to a viewer who opted into its level (XXX included)', () => {
    expect(projectListingMedia(row, view(true, ALL_OPTED))).toMatchObject({
      iconUrl: 'edge:red-icon.png@256',
      coverUrl: 'edge:red-cover.png@1200',
    });
  });

  it('🔴 an override the viewer may not see falls back to the listing’s own icon / cover', () => {
    // R-opted: the R icon shows, the XXX cover does not.
    expect(projectListingMedia(row, view(true, PG | PG13 | R))).toMatchObject({
      iconUrl: 'edge:red-icon.png@256',
      coverUrl: 'edge:own-cover.png@1200',
    });
    // Anonymous: neither.
    expect(projectListingMedia(row, view(true, undefined))).toMatchObject({
      iconUrl: 'edge:own-icon.png@256',
      coverUrl: 'edge:own-cover.png@1200',
    });
  });

  it('invariant guard: a non-red view never uses an override, even one the caller passed and the viewer could see', () => {
    // A PG override is inside the non-red ceiling: only the host test keeps it out.
    const pgRed = { icon: img('red-pg-icon.png', PG), cover: img('red-pg-cover.png', PG) };
    expect(
      projectListingMedia(row, {
        kind: 'public',
        audience: { redCapable: false, viewerBrowsingLevel: ALL_OPTED },
        red: pgRed,
      })
    ).toMatchObject({ iconUrl: 'edge:own-icon.png@256', coverUrl: 'edge:own-cover.png@1200' });
  });

  it('invariant guard: a Blocked, flagged or unrated override never renders', () => {
    for (const bad of [
      img('red-blocked.png', R, { ingestion: 'Blocked' }),
      img('red-flagged.png', R, { tosViolation: true }),
      img('red-unrated.png', 0, { ingestion: 'Pending' }),
      img('red-blocked-level.png', Blocked),
    ]) {
      expect(
        projectListingMedia(row, { ...view(true, ALL_OPTED), red: { icon: bad, cover: bad } })
      ).toMatchObject({ iconUrl: 'edge:own-icon.png@256', coverUrl: 'edge:own-cover.png@1200' });
    }
  });

  it('a hidden cover override with no visible own cover falls back to the first visible screenshot', () => {
    expect(projectListingMedia({ ...row, cover: null }, view(true, PG | PG13 | R))).toMatchObject({
      coverUrl: 'edge:shot-pg.png@1200',
    });
  });

  it('the moderator review view ignores the overrides (they are reviewed beside it)', () => {
    expect(projectListingMedia(row, MODERATOR_REVIEW_MEDIA)).toMatchObject({
      iconUrl: 'edge:own-icon.png@256',
      coverUrl: 'edge:own-cover.png@1200',
    });
  });
});

// The select is the contract between the hydration and the decision: a column the classifier reads
// but the select omits would arrive `undefined` from the database, and every mocked suite would
// still pass (their rows carry every field whatever is selected). So the READ set is recorded from
// the classifier itself, not restated here.
describe('listingMediaImageSelect covers every field the visibility decision reads', () => {
  it('a Proxy over a visible image records the reads; each must be selected', () => {
    const read = new Set<string>();
    const tracked = new Proxy(img('t.png', PG), {
      get(target, key) {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key);
      },
    });
    // A visible image walks every branch of the classifier (each flag, ingestion, level).
    expect(isListingImageVisible(tracked, PG)).toBe(true);
    // Positive control: the recorder saw the obvious ones, so an empty set cannot pass below.
    expect(read.has('nsfwLevel') && read.has('ingestion')).toBe(true);
    const missing = [...read].filter((k) => !(k in listingMediaImageSelect));
    expect(missing).toEqual([]);
  });
});

// The fail-closed contract every reader of a raw / untyped row relies on: only a literal `false`
// or an absent value means "not flagged".
describe('isModerationFlagSet', () => {
  it.each([false, null, undefined])('%s is not set', (v) => {
    expect(isModerationFlagSet(v)).toBe(false);
  });
  it.each([true, 't', 'false', 1, 0, ''])('%j counts as set', (v) => {
    expect(isModerationFlagSet(v)).toBe(true);
  });
});
