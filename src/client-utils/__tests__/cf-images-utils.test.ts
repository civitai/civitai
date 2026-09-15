import { describe, it, expect, vi } from 'vitest';

// `cf-images-utils` reads `env.NEXT_PUBLIC_IMAGE_LOCATION` at call time. Stub the
// client env module before importing the unit under test so we don't trip the
// zod schema check in `~/env/client`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test',
  },
}));

import {
  COMMON_IMAGE_WIDTHS,
  MAX_EDGE_WIDTH,
  SRCSET_DPR,
  getEdgeUrl,
  getEdgeUrlSrcSet,
  resolveOptimized,
  resolveOptimizedLegacy,
  snapWidthToCommonSize,
  toMediaQuality,
} from '~/client-utils/cf-images-utils';

describe('snapWidthToCommonSize', () => {
  it('leaves widths that are exactly on the ladder unchanged', () => {
    for (const size of COMMON_IMAGE_WIDTHS) {
      expect(snapWidthToCommonSize(size)).toBe(size);
    }
  });

  it('snaps widths below the bottom of the ladder up to the smallest ladder value', () => {
    const smallest = COMMON_IMAGE_WIDTHS[0];
    expect(snapWidthToCommonSize(1)).toBe(smallest);
    expect(snapWidthToCommonSize(smallest - 1)).toBe(smallest);
  });

  it('snaps widths between ladder values up to the next ladder value', () => {
    // Ladder is [96, 320, 450, 512, 800, 1200, 1600, 2200]
    expect(snapWidthToCommonSize(97)).toBe(320);
    expect(snapWidthToCommonSize(321)).toBe(450);
    expect(snapWidthToCommonSize(451)).toBe(512);
    expect(snapWidthToCommonSize(513)).toBe(800);
    expect(snapWidthToCommonSize(801)).toBe(1200);
    expect(snapWidthToCommonSize(1201)).toBe(1600);
    expect(snapWidthToCommonSize(1601)).toBe(2200);
  });

  it('passes widths above the top of the ladder through unchanged', () => {
    const top = COMMON_IMAGE_WIDTHS[COMMON_IMAGE_WIDTHS.length - 1];
    expect(snapWidthToCommonSize(top + 1)).toBe(top + 1);
    expect(snapWidthToCommonSize(5000)).toBe(5000);
  });
});

describe('getEdgeUrl width snapping', () => {
  const SRC = 'abc-image-uuid';

  it('emits the snapped width for off-ladder values', () => {
    // 451 is between 450 and 512 → snaps to 512.
    const url = getEdgeUrl(SRC, { width: 451 });
    expect(url).toContain('width=512');
    expect(url).not.toContain('width=451');
  });

  it('preserves on-ladder widths verbatim', () => {
    const url = getEdgeUrl(SRC, { width: 450 });
    expect(url).toContain('width=450');
  });

  it('leaves over-ladder widths to the existing 1800 cap', () => {
    // 2500 > top of ladder (2200) → snap is a no-op → existing cap clamps to 1800.
    const url = getEdgeUrl(SRC, { width: 2500 });
    expect(url).toContain('width=1800');
  });

  it('does not emit a width param when width is undefined', () => {
    // No width and no height → `getEdgeUrl` defaults `original=true` and clears
    // both dimensions; we expect no `width=` segment to leak through.
    const url = getEdgeUrl(SRC);
    expect(url).not.toMatch(/(^|[,/?])width=/);
  });

  it('does not snap height', () => {
    const url = getEdgeUrl(SRC, { height: 451 });
    expect(url).toContain('height=451');
  });
});

describe('getEdgeUrlSrcSet', () => {
  const SRC = 'abc-image-uuid';

  const descriptors = (srcSet: string | undefined) =>
    (srcSet ?? '').split(', ').map((entry) => {
      const [url, descriptor] = entry.split(' ');
      return { width: Number(url.match(/width=(\d+)/)?.[1]), descriptor };
    });

  it('pairs the requested width with a variant one ladder-snapped doubling up', () => {
    // Post detail renders an 800 CSS px box; a 2x display needs 1600 real pixels.
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 800 }))).toEqual([
      { width: 800, descriptor: '1x' },
      { width: 1600, descriptor: `${SRCSET_DPR}x` },
    ]);
  });

  it('snaps both descriptors onto the ladder', () => {
    // 451 -> 512; 902 -> 1200. Neither number appears verbatim.
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 451 }))).toEqual([
      { width: 512, descriptor: '1x' },
      { width: 1200, descriptor: `${SRCSET_DPR}x` },
    ]);
  });

  it('carries every other option onto BOTH variants', () => {
    // The 2x URL losing `optimized` is the expensive failure: unoptimized, the 1600px
    // variant of a detailed image measures ~1MB against ~305kB.
    const srcSet = getEdgeUrlSrcSet(SRC, { width: 800, optimized: true, anim: false });
    const urls = (srcSet ?? '').split(', ');
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toContain('optimized=true');
      expect(url).toContain('anim=false');
    }
  });

  it('escapes whitespace in a name so the candidate is not silently dropped', () => {
    // A raw space TERMINATES a srcset URL: the rest of the filename is read as the
    // descriptor, found invalid, and the candidate is dropped — leaving the browser on
    // `src`, i.e. 1x, with no error. Image names routinely contain spaces.
    const srcSet = getEdgeUrlSrcSet(SRC, { width: 800, name: 'Unstable Bastard_312879214.png' });
    // Every candidate must be `<url><space><descriptor>` with no space inside the url.
    for (const candidate of (srcSet ?? '').split(', ')) {
      const [url, descriptor, ...extra] = candidate.split(' ');
      expect(extra).toEqual([]);
      expect(descriptor).toMatch(/^\dx$/);
      expect(url).toContain('%20');
    }
    expect(descriptors(srcSet)).toEqual([
      { width: 800, descriptor: '1x' },
      { width: 1600, descriptor: `${SRCSET_DPR}x` },
    ]);
  });

  it('omits the attribute when the 2x variant cannot exceed the 1x one', () => {
    // Both clamp to MAX_EDGE_WIDTH, so a srcSet here would list the same URL twice.
    expect(getEdgeUrlSrcSet(SRC, { width: MAX_EDGE_WIDTH })).toBeUndefined();
  });

  it('omits the attribute for original and for width-less requests', () => {
    expect(getEdgeUrlSrcSet(SRC, { width: 800, original: true })).toBeUndefined();
    expect(getEdgeUrlSrcSet(SRC, {})).toBeUndefined();
  });

  it('omits the attribute for a src the edge does not serve', () => {
    expect(getEdgeUrlSrcSet('https://example.test/a.png', { width: 800 })).toBeUndefined();
    expect(getEdgeUrlSrcSet('blob:whatever', { width: 800 })).toBeUndefined();
  });
});

describe('toMediaQuality', () => {
  it('reads an unset preference as compressed — the default flip, with nothing written', () => {
    expect(toMediaQuality({})).toBe('compressed');
    expect(toMediaQuality({ canUseLossless: true })).toBe('compressed');
  });

  it('gives lossless only to a viewer who both chose it and is entitled to it', () => {
    expect(toMediaQuality({ imageFormat: 'metadata', canUseLossless: true })).toBe('lossless');
    expect(toMediaQuality({ imageFormat: 'metadata', canUseLossless: false })).toBe('compressed');
  });

  it('reads an explicit compressed choice as compressed even for a member', () => {
    expect(toMediaQuality({ imageFormat: 'optimized', canUseLossless: true })).toBe('compressed');
  });
});

describe('resolveOptimized', () => {
  const lossless = { quality: 'lossless' } as const;
  const compressed = { quality: 'compressed' } as const;

  it('compresses a non-member in card feeds AND at preview width', () => {
    // The reported bug, from the other side: the two widths used to disagree.
    expect(resolveOptimized({ width: 450, ...compressed })).toBe(true);
    expect(resolveOptimized({ width: 800, ...compressed })).toBe(true);
  });

  it('honours lossless at EVERY width, card feeds included', () => {
    // 🔴 The regression this PR exists to fix. Before, `width <= 450` forced compression on
    // regardless of the preference, so every card feed ignored the choice.
    expect(resolveOptimized({ width: 450, ...lossless })).toBe(false);
    expect(resolveOptimized({ width: 96, ...lossless })).toBe(false);
    expect(resolveOptimized({ width: 800, ...lossless })).toBe(false);
  });

  it('compresses when quality is unknown', () => {
    // A viewer resolved before the session lands must not flash the expensive variant.
    expect(resolveOptimized({ width: 800 })).toBe(true);
  });

  it('lets an explicit call-site optimized win over lossless', () => {
    // Site chrome — stickers, avatars, shop tiles, the announcement banner — has one variant
    // for everyone, which is what lets `announcement-media-check` name the URL it probes.
    expect(resolveOptimized({ width: 96, optimized: true, ...lossless })).toBe(true);
  });

  it('never flags an original request, for anybody', () => {
    // Downloads and the lightbox. The cacher ignores `optimized` on an original, but emitting
    // it would still change the URL and split the CDN cache key.
    expect(resolveOptimized({ original: true, ...compressed })).toBe(false);
    expect(resolveOptimized({ original: true, ...lossless })).toBe(false);
    // `getEdgeUrl` infers `original` from the absence of both dimensions — mirrored here, or
    // every width-less call would start carrying the flag.
    expect(resolveOptimized({ ...compressed })).toBe(false);
    expect(resolveOptimized({ height: 400, ...compressed })).toBe(true);
  });

  it('leaves the download shape on the original, for both qualities', () => {
    // 🔴 Product requirement, not an implementation detail: the download button renders
    // `DownloadImage`, which calls `useEdgeUrl` with neither width nor height. That has to come
    // out as the stored original for everyone — lossless is about BROWSING, and a non-member must
    // not have their downloads quietly compressed by the default flip.
    const download = { type: 'image' as const, name: 'a.png' };
    for (const quality of ['compressed', 'lossless'] as const) {
      expect(resolveOptimized({ ...download, quality })).toBe(false);
    }
    const url = getEdgeUrl('KEY', download);
    expect(url).toContain('original=true');
    expect(url).not.toContain('optimized');
  });

  it('leaves hi-DPI to the viewer, so a paying member keeps lossless at 2x', () => {
    // Decision 3.1(b): hiDpi decides whether a srcSet is emitted, no longer what format it is.
    expect(resolveOptimized({ width: 1600, ...lossless })).toBe(false);
  });
});

describe('resolveOptimizedLegacy', () => {
  // The flag-off path. These are the pre-change assertions verbatim: if they drift, a rollback
  // no longer restores the URLs it claims to.
  it('forces the optimized format for a hi-DPI request whatever the preference', () => {
    expect(resolveOptimizedLegacy({ width: 800, hiDpi: true, imageFormat: 'metadata' })).toBe(true);
  });

  it('leaves a plain wide request on the user preference', () => {
    expect(resolveOptimizedLegacy({ width: 800, imageFormat: 'metadata' })).toBe(false);
    expect(resolveOptimizedLegacy({ width: 800, imageFormat: 'optimized' })).toBe(true);
  });

  it('still forces it below the small-preview threshold', () => {
    expect(resolveOptimizedLegacy({ width: 450, imageFormat: 'metadata' })).toBe(true);
  });

  it('leaves an original request on the user preference', () => {
    expect(resolveOptimizedLegacy({ imageFormat: 'metadata' })).toBe(false);
  });
});
