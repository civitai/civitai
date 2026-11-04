import { describe, expect, it } from 'vitest';
import { badgeKeysFrom, RANK_BADGE_COSMETICS } from './rank-badges';

describe('badgeKeysFrom', () => {
  it('maps each rank to the image key of its cosmetic, Acolyte included', () => {
    const keys = badgeKeysFrom([
      { id: RANK_BADGE_COSMETICS.Acolyte, data: { url: 'acolyte-key' } },
      { id: RANK_BADGE_COSMETICS.Knight, data: { url: 'knight-key' } },
      { id: RANK_BADGE_COSMETICS.Templar, data: { url: 'templar-key' } },
    ]);
    expect(keys).toEqual({ Acolyte: 'acolyte-key', Knight: 'knight-key', Templar: 'templar-key' });
  });

  it('leaves out a rank whose cosmetic is missing or has no url (Paladin has none yet)', () => {
    const keys = badgeKeysFrom([
      { id: RANK_BADGE_COSMETICS.Knight, data: { url: '' } },
      { id: RANK_BADGE_COSMETICS.Templar, data: null },
    ]);
    expect(keys).toEqual({});
    expect('Paladin' in RANK_BADGE_COSMETICS).toBe(false);
  });
});
