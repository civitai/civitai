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
  getEdgeUrl,
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
