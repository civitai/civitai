import { describe, expect, it } from 'vitest';
import {
  boxPackTermsOf,
  packBoxSourceKey,
  packBoxSourcePrefix,
  parsePackBoxSourceKey,
} from '../mystery-box';

describe('boxPackTermsOf', () => {
  it('reads a pack, and nothing from a listing selling one box', () => {
    expect(boxPackTermsOf({ pack: { size: 10, guaranteedTierIds: [6, 7] } })).toEqual({
      size: 10,
      guaranteedTierIds: [6, 7],
    });
    expect(boxPackTermsOf({})).toBeUndefined();
    expect(boxPackTermsOf(null)).toBeUndefined();
  });

  // A pack that parsed as no pack would sell one box at the pack's price.
  it.each([
    ['a pack of one', { size: 1, guaranteedTierIds: [6] }],
    ['a pack past the cap', { size: 21, guaranteedTierIds: [6] }],
    ['a fractional size', { size: 2.5, guaranteedTierIds: [6] }],
    ['no guaranteed tiers', { size: 10, guaranteedTierIds: [] }],
    ['a guaranteed tier that is not an id', { size: 10, guaranteedTierIds: ['6'] }],
    ['no size', { guaranteedTierIds: [6] }],
  ])('throws on %s', (_, pack) => {
    expect(() => boxPackTermsOf({ pack })).toThrow('Malformed box pack terms');
  });
});

describe('pack box keys', () => {
  it('round-trip, and every box key starts with the prefix', () => {
    const key = packBoxSourceKey('item-purchase-v1-1-43-k', 3);
    expect(key.startsWith(packBoxSourcePrefix('item-purchase-v1-1-43-k'))).toBe(true);
    expect(parsePackBoxSourceKey(key)).toEqual({ transactionId: 'item-purchase-v1-1-43-k', n: 3 });
  });

  it('reads no pack box from a single purchase key or a moderator grant key', () => {
    expect(parsePackBoxSourceKey('item-purchase-v1-1-42-k')).toBeUndefined();
    expect(parsePackBoxSourceKey('mod-grant-abc-1-1')).toBeUndefined();
  });

  // The guaranteed boxes a buyer holds are counted by this suffix.
  it("only a pack's first box ends with the first box's suffix", () => {
    const boxes = Array.from({ length: 20 }, (_, i) => packBoxSourceKey('t', i + 1));
    expect(boxes.filter((key) => key.endsWith(packBoxSourceKey('', 1)))).toEqual([boxes[0]]);
  });
});
