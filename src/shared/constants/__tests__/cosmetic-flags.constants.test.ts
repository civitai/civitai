import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { CosmeticFlag, isStickerKeptOffImage } from '~/shared/constants/cosmetic-flags.constants';

const keptOff = (cosmeticFlags: number, imageNsfwLevel: number) =>
  isStickerKeptOffImage({ cosmeticFlags, imageNsfwLevel });

describe('isStickerKeptOffImage', () => {
  it.each([
    ['PG', NsfwLevel.PG, false],
    ['PG-13', NsfwLevel.PG13, false],
    ['R', NsfwLevel.R, true],
    ['X', NsfwLevel.X, true],
    ['XXX', NsfwLevel.XXX, true],
    ['Blocked', NsfwLevel.Blocked, true],
    ['unrated', 0, true],
    ['a PG | R composite', NsfwLevel.PG | NsfwLevel.R, true],
  ])('flagged sticker on %s (level %i) is kept off: %s', (_label, level, expected) => {
    expect(keptOff(CosmeticFlag.SfwPlacementsOnly, level)).toBe(expected);
  });

  it('never keeps an unflagged sticker off anything', () => {
    for (const level of [0, NsfwLevel.R, NsfwLevel.XXX, NsfwLevel.Blocked])
      expect(keptOff(CosmeticFlag.None, level)).toBe(false);
  });

  it('reads its own bit, not any bit', () => {
    expect(keptOff(1 << 5, NsfwLevel.XXX)).toBe(false);
    expect(keptOff(CosmeticFlag.SfwPlacementsOnly | (1 << 5), NsfwLevel.XXX)).toBe(true);
  });
});
