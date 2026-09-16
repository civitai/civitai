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
  snapWidthToCommonSize,
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
    // 451 -> 512 for the 1x; the 2x target of 1024 has no rung, so the candidate is the widest
    // rung under it, 800. Neither number appears verbatim.
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 451 }))).toEqual([
      { width: 512, descriptor: '1x' },
      { width: 800, descriptor: '1.56x' },
    ]);
  });

  it('gives a card the 800 rung at a true 1.77x, NOT the 1200 one at a claimed 2x', () => {
    // Rounding 900 UP lands on 1200, which the CDN serves identically to `width=1200`.
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 450 }))).toEqual([
      { width: 450, descriptor: '1x' },
      { width: 800, descriptor: '1.77x' },
    ]);
  });

  it('never claims a density the candidate does not have, nor exceeds SRCSET_DPR', () => {
    // A descriptor is a promise about pixels: 800/450 rounded up to 1.78x would overstate it.
    let checked = 0;
    for (const width of COMMON_IMAGE_WIDTHS) {
      const srcSet = getEdgeUrlSrcSet(SRC, { width });
      if (!srcSet) continue;
      const [base, scaled] = descriptors(srcSet);
      const ratio = (scaled.width as number) / (base.width as number);
      expect(Number(scaled.descriptor.replace('x', '')), `width=${width}`).toBeLessThanOrEqual(
        ratio
      );
      expect(ratio, `width=${width}`).toBeLessThanOrEqual(SRCSET_DPR);
      expect(ratio, `width=${width}`).toBeGreaterThan(1);
      checked++;
    }
    // Guards the loop: a rung that stops emitting a candidate would otherwise be absorbed silently.
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('never offers a 2x candidate wider than the SOURCE', () => {
    // The cacher UPSCALES rather than refusing, so an unbounded candidate bills real bytes for
    // interpolated pixels — and most generated images are under 1600 wide.
    expect(getEdgeUrlSrcSet(SRC, { width: 800, sourceWidth: 832 })).toBeUndefined();
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 800, sourceWidth: 4096 }))).toEqual([
      { width: 800, descriptor: '1x' },
      { width: 1600, descriptor: '2x' },
    ]);
  });

  it('drops to a smaller rung the source CAN back, rather than omitting outright', () => {
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 450, sourceWidth: 900 }))).toEqual([
      { width: 450, descriptor: '1x' },
      { width: 800, descriptor: '1.77x' },
    ]);
    // A 512px source cannot back 800, but it CAN back 512 — so the candidate drops a rung rather
    // than disappearing. 13% more pixels is still more pixels, and they are real ones.
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 450, sourceWidth: 512 }))).toEqual([
      { width: 450, descriptor: '1x' },
      { width: 512, descriptor: '1.13x' },
    ]);
    expect(getEdgeUrlSrcSet(SRC, { width: 450, sourceWidth: 460 })).toBeUndefined();
  });

  it('keeps emitting a candidate when the source width is unknown', () => {
    expect(descriptors(getEdgeUrlSrcSet(SRC, { width: 450 }))).toEqual([
      { width: 450, descriptor: '1x' },
      { width: 800, descriptor: '1.77x' },
    ]);
  });

  it('never emits sourceWidth into the URL', () => {
    expect(getEdgeUrl(SRC, { width: 800, sourceWidth: 4096 })).not.toContain('sourceWidth');
    for (const c of (getEdgeUrlSrcSet(SRC, { width: 800, sourceWidth: 4096 }) ?? '').split(', ')) {
      expect(c).not.toContain('sourceWidth');
    }
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
      expect(descriptor).toMatch(/^\d+(\.\d+)?x$/);
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

describe('resolveOptimized', () => {
  it('compresses every derived variant, at every width', () => {
    expect(resolveOptimized({ width: 96 })).toBe(true);
    expect(resolveOptimized({ width: 450 })).toBe(true);
    expect(resolveOptimized({ width: 800 })).toBe(true);
    expect(resolveOptimized({ width: 1600 })).toBe(true);
    expect(resolveOptimized({ height: 400 })).toBe(true);
  });

  it('never flags an original request', () => {
    expect(resolveOptimized({ original: true })).toBe(false);
    // `getEdgeUrl` infers `original` from the absence of both dimensions; `resolveOptimized` has to
    // mirror that or every width-less call starts carrying the flag.
    expect(resolveOptimized({})).toBe(false);
    expect(resolveOptimized({ original: true, width: 450 })).toBe(false);
  });

  it('leaves the download shape on the original', () => {
    // The download button renders `DownloadImage`, which calls `useEdgeUrl` with neither width nor
    // height. Downloads must keep returning the stored file.
    const download = { type: 'image' as const, name: 'a.png' };
    expect(resolveOptimized(download)).toBe(false);
    const url = getEdgeUrl('KEY', download);
    expect(url).toContain('original=true');
    expect(url).not.toContain('optimized');
  });
});
