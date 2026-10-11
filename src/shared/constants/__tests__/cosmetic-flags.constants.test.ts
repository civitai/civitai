import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  CosmeticFlag,
  getStickerPlacementRating,
  isStickerKeptOffImage,
  STICKER_NSFW_ONLY_REFUSAL,
  STICKER_SFW_ONLY_REFUSAL,
  stickerPlacementRefusal,
} from '~/shared/constants/cosmetic-flags.constants';

const keptOff = (cosmeticFlags: number, imageNsfwLevel: number) =>
  isStickerKeptOffImage({ cosmeticFlags, imageNsfwLevel });

const BOTH = CosmeticFlag.SfwPlacementsOnly | CosmeticFlag.NsfwPlacementsOnly;

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
  ])('SFW-only sticker on %s (level %i) is kept off: %s', (_label, level, expected) => {
    expect(keptOff(CosmeticFlag.SfwPlacementsOnly, level)).toBe(expected);
  });

  it.each([
    ['PG', NsfwLevel.PG, true],
    ['PG-13', NsfwLevel.PG13, true],
    ['R', NsfwLevel.R, false],
    ['X', NsfwLevel.X, false],
    ['XXX', NsfwLevel.XXX, false],
    ['unrated', 0, true],
    ['a PG | R composite', NsfwLevel.PG | NsfwLevel.R, false],
    ['a non-number', Number.NaN, true],
  ])('NSFW-only sticker on %s (level %i) is kept off: %s', (_label, level, expected) => {
    expect(keptOff(CosmeticFlag.NsfwPlacementsOnly, level)).toBe(expected);
  });

  it('never keeps an unflagged sticker off anything', () => {
    for (const level of [0, NsfwLevel.PG, NsfwLevel.R, NsfwLevel.XXX, NsfwLevel.Blocked])
      expect(keptOff(CosmeticFlag.None, level)).toBe(false);
  });

  it('reads its own bits, not any bit', () => {
    expect(keptOff(1 << 5, NsfwLevel.XXX)).toBe(false);
    expect(keptOff(1 << 5, NsfwLevel.PG)).toBe(false);
    expect(keptOff(CosmeticFlag.SfwPlacementsOnly | (1 << 5), NsfwLevel.XXX)).toBe(true);
    expect(keptOff(CosmeticFlag.NsfwPlacementsOnly | (1 << 5), NsfwLevel.PG)).toBe(true);
  });

  it('keeps a sticker carrying both bits off every rating', () => {
    for (const level of [0, NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.XXX])
      expect(keptOff(BOTH, level)).toBe(true);
  });
});

describe('getStickerPlacementRating', () => {
  it.each([
    [CosmeticFlag.None, 'any'],
    [CosmeticFlag.SfwPlacementsOnly, 'sfwOnly'],
    [CosmeticFlag.NsfwPlacementsOnly, 'nsfwOnly'],
    [1 << 5, 'any'],
  ])('reads flags %i as %s', (flags, rating) => {
    expect(getStickerPlacementRating(flags)).toBe(rating);
  });
});

describe('stickerPlacementRefusal', () => {
  it('names the rule that refused it', () => {
    expect(stickerPlacementRefusal(CosmeticFlag.SfwPlacementsOnly)).toBe(STICKER_SFW_ONLY_REFUSAL);
    expect(stickerPlacementRefusal(CosmeticFlag.NsfwPlacementsOnly)).toBe(
      STICKER_NSFW_ONLY_REFUSAL
    );
  });
});
