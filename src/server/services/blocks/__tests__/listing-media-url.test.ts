import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The CDN url every listing icon, cover and screenshot is served from, pinned as LITERAL strings
 * through the REAL `getEdgeUrl` (only the client env is stubbed).
 *
 * Pins `optimized=true` (WebP keeps alpha; JPEG flattens a transparent icon to black) and
 * `anim=false` (no animated WebP for animated sources). Rationale: see `listingMediaEdgeUrl`.
 * Other blocks tests mock `getEdgeUrl` and drop its options, so none can see these flags (the
 * call-site tests in `listing-media-url.call-sites.test.ts` excepted). Keys are pairwise distinct
 * and distinct from every width constant.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' } }));

import { NsfwLevel } from '~/server/common/enums';
import {
  gatedListingCoverUrl,
  gatedListingIconUrl,
  gatedListingScreenshots,
  listingSocialImage,
  MODERATOR_REVIEW_MEDIA,
  projectListingMedia,
  SFW_PUBLIC_MEDIA,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';
import { listingCoverUrl, listingIconUrl } from '~/server/services/blocks/listing-media-url';

const { PG } = NsfwLevel;

function img(url: string) {
  return {
    url,
    nsfwLevel: PG,
    ingestion: 'Scanned',
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
  } satisfies ListingMediaImage;
}

describe('listingIconUrl', () => {
  it('asks the CDN for the optimized (WebP, alpha-preserving) variant', () => {
    expect(listingIconUrl({ url: 'icon-key-a1' })).toBe(
      'https://image.test/icon-key-a1/anim=false,width=320,optimized=true/icon-key-a1.jpeg'
    );
  });

  it('asks for a single frame, so an animated source does not play', () => {
    const params = listingIconUrl({ url: 'icon-key-j0' })!.split('/')[4].split(',');
    expect(params).toContain('anim=false');
    expect(params).toContain('optimized=true');
  });

  it('is null for a missing icon', () => {
    expect(listingIconUrl(null)).toBeNull();
    expect(listingIconUrl(undefined)).toBeNull();
    expect(listingIconUrl({ url: null })).toBeNull();
  });
});

describe('listingCoverUrl', () => {
  it('asks the CDN for the optimized variant', () => {
    expect(listingCoverUrl({ url: 'cover-key-b2' }, null)).toBe(
      'https://image.test/cover-key-b2/anim=false,width=1200,optimized=true/cover-key-b2.jpeg'
    );
  });

  it('asks for a single frame, so an animated cover does not play', () => {
    const params = listingCoverUrl({ url: 'cover-key-k1' }, null)!.split('/')[4].split(',');
    expect(params).toContain('anim=false');
    expect(params).toContain('optimized=true');
  });

  it('returns the fallback url unchanged when there is no cover', () => {
    expect(listingCoverUrl(null, 'fallback-url-c3')).toBe('fallback-url-c3');
  });
});

describe('the gated public projections use the optimized variant', () => {
  const ceiling = PG;

  it('icon', () => {
    expect(gatedListingIconUrl(img('icon-key-d4'), ceiling)).toBe(
      'https://image.test/icon-key-d4/anim=false,width=320,optimized=true/icon-key-d4.jpeg'
    );
  });

  it('screenshots', () => {
    expect(
      gatedListingScreenshots([{ caption: 'cap-e5', image: img('shot-key-e5') }], ceiling)
    ).toEqual([
      {
        url: 'https://image.test/shot-key-e5/anim=false,width=1200,optimized=true/shot-key-e5.jpeg',
        caption: 'cap-e5',
      },
    ]);
  });

  it('cover falling back to the first screenshot', () => {
    expect(gatedListingCoverUrl(null, [{ image: img('shot-key-f6') }], ceiling)).toBe(
      'https://image.test/shot-key-f6/anim=false,width=1200,optimized=true/shot-key-f6.jpeg'
    );
  });

  it('projectListingMedia, public and moderator-review', () => {
    const row = {
      contentRating: 'g',
      icon: img('icon-key-g7'),
      cover: null,
      screenshots: [{ caption: null, image: img('shot-key-h8') }],
    };
    const expected = {
      iconUrl:
        'https://image.test/icon-key-g7/anim=false,width=320,optimized=true/icon-key-g7.jpeg',
      coverUrl:
        'https://image.test/shot-key-h8/anim=false,width=1200,optimized=true/shot-key-h8.jpeg',
      screenshots: [
        {
          url: 'https://image.test/shot-key-h8/anim=false,width=1200,optimized=true/shot-key-h8.jpeg',
          caption: null,
        },
      ],
    };
    expect(projectListingMedia(row, SFW_PUBLIC_MEDIA)).toEqual(expected);
    expect(projectListingMedia(row, MODERATOR_REVIEW_MEDIA)).toEqual(expected);
  });
});

/** INVARIANT GUARD: the `og:image` must stay JPEG (see `listingSocialImage`). */
describe('listingSocialImage stays JPEG', () => {
  it('builds its icon url without optimized', () => {
    const row = { contentRating: 'g', icon: img('icon-key-i9'), cover: null, screenshots: [] };
    const url = listingSocialImage(row, { redCapable: false })?.url;
    expect(url).toBe('https://image.test/icon-key-i9/width=320/icon-key-i9.jpeg');
    expect(url).not.toContain('optimized');
  });

  it('builds its cover url without optimized', () => {
    const row = {
      contentRating: 'g',
      icon: img('icon-key-l2'),
      cover: img('cover-key-m3'),
      screenshots: [],
    };
    const url = listingSocialImage(row, { redCapable: false })?.url;
    expect(url).toBe('https://image.test/cover-key-m3/width=1200/cover-key-m3.jpeg');
    expect(url).not.toContain('optimized');
  });
});

/**
 * TRIPWIRE ONLY, not coverage: it greps the spelling `getEdgeUrl(`, so an aliased import walks
 * past it, and it cannot see a wrong width. The URL each of these sites actually builds (the
 * moderator review screenshots, the sub-listing card cover, the author's edit prefill) is pinned
 * by `listing-media-url.call-sites.test.ts`.
 */
describe('listing-media modules build CDN urls only through listing-media-url', () => {
  const SRC = resolve(__dirname, '../../../..');
  const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

  it.each([
    'server/services/blocks/app-listing.service.ts',
    'server/services/blocks/app-sub-listing-store.service.ts',
    'server/services/blocks/offsite-listing.service.ts',
  ])('%s never calls getEdgeUrl', (rel) => {
    const code = read(rel);
    // Positive control: the file was read, so a no-match below is a fact about its contents.
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/\bgetEdgeUrl\s*\(/);
    expect(code).toMatch(/\blistingMediaEdgeUrl\s*\(/);
  });
});
