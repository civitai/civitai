import { describe, expect, it } from 'vitest';

import { subListingImageCeiling } from '~/server/services/blocks/app-sub-listing-store.service';

/**
 * One ceiling for every image on a sub-listing card. Off a red-capable host it is the viewer's
 * browsing level ∩ SFW ∩ the card's own rating; each case there leaves two caps wide open so the
 * third alone decides. On a red-capable host it is that same ceiling ∪ the viewer's opted-in
 * levels (Blocked excluded) — the card's rating no longer caps it there.
 */
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;
const BLOCKED = 32;
const ALL = PG | PG13 | R | X | XXX;

describe('subListingImageCeiling', () => {
  it('the viewer’s browsing level caps it', () => {
    expect(subListingImageCeiling({ browsingLevel: PG, redCapable: true }, 'x')).toBe(PG);
    expect(subListingImageCeiling({ browsingLevel: PG, redCapable: false }, 'x')).toBe(PG);
  });

  it('a non-red host caps it at SFW', () => {
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: false }, 'x')).toBe(PG | PG13);
  });

  it('off a red host the card’s rating caps it', () => {
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: false }, 'g')).toBe(PG);
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: false }, 'pg13')).toBe(
      PG | PG13
    );
  });

  it('🔴 on a red host the card’s rating does NOT cap it — the viewer’s own levels do', () => {
    expect(subListingImageCeiling({ browsingLevel: PG | R, redCapable: true }, 'pg')).toBe(PG | R);
    expect(subListingImageCeiling({ browsingLevel: ALL, redCapable: true }, 'g')).toBe(ALL);
  });

  it('on a red host Blocked is never admitted, whatever the viewer asked for', () => {
    expect(
      subListingImageCeiling({ browsingLevel: ALL | BLOCKED, redCapable: true }, 'x') & BLOCKED
    ).toBe(0);
  });

  it('an anonymous viewer gets the public floor, on either host', () => {
    expect(subListingImageCeiling({ browsingLevel: null, redCapable: true }, 'x')).toBe(PG);
    expect(subListingImageCeiling({ browsingLevel: null, redCapable: false }, 'x')).toBe(PG);
  });
});
