import { describe, expect, it } from 'vitest';

import { subListingImageCeiling } from '~/server/services/blocks/app-sub-listing-store.service';

/**
 * The item image is shown only within three independent caps: the viewer's browsing level, the
 * host (SFW off a red-capable host), and the card's own rating. Each case leaves two caps wide
 * open so the third alone decides.
 */
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const ALL = PG | PG13 | R | X | 16;

describe('subListingImageCeiling', () => {
  it('the viewer’s browsing level caps it', () => {
    expect(subListingImageCeiling({ browsingLevel: PG, redCapable: true }, 'x')).toBe(PG);
  });

  it('a non-red host caps it at SFW', () => {
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: false }, 'x')).toBe(PG | PG13);
  });

  it('the card’s rating caps it', () => {
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: true }, 'pg13')).toBe(
      PG | PG13
    );
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: true }, 'r')).toBe(
      PG | PG13 | R
    );
  });

  it('an anonymous viewer gets the public floor', () => {
    expect(subListingImageCeiling({ browsingLevel: null, redCapable: true }, 'x')).toBe(PG);
  });
});
