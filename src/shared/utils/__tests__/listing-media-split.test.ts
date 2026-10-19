import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  isComEligibleLevel,
  listingAssetAudience,
  ratingFloorAssets,
  resolveListingMediaSplitDecision,
  summarizeListingMediaSplit,
} from '~/shared/utils/listing-media-split';

describe('isComEligibleLevel — which images still floor a split listing', () => {
  it.each([
    ['unrated (0)', 0, true],
    ['missing', null, true],
    ['PG', NsfwLevel.PG, true],
    ['PG-13', NsfwLevel.PG13, true],
    ['R', NsfwLevel.R, false],
    ['X', NsfwLevel.X, false],
    ['XXX', NsfwLevel.XXX, false],
    ['Blocked', NsfwLevel.Blocked, false],
    // 🔴 A composite civitai.com could show stays in the floor, so its R bit floors the rating.
    ['PG | R', NsfwLevel.PG | NsfwLevel.R, true],
  ])('%s → %s', (_label, level, eligible) => {
    expect(isComEligibleLevel(level)).toBe(eligible);
  });
});

describe('ratingFloorAssets', () => {
  const assets = [
    { id: 'icon', nsfwLevel: NsfwLevel.PG13 },
    { id: 'shot-r', nsfwLevel: NsfwLevel.R },
    { id: 'shot-unrated', nsfwLevel: 0 },
    { id: 'shot-x', nsfwLevel: NsfwLevel.X },
  ];

  it('without a split every asset floors the rating', () => {
    expect(ratingFloorAssets(assets, false).map((a) => a.id)).toEqual([
      'icon',
      'shot-r',
      'shot-unrated',
      'shot-x',
    ]);
  });

  it('with a split only the civitai.com-eligible ones do, in order', () => {
    expect(ratingFloorAssets(assets, true).map((a) => a.id)).toEqual(['icon', 'shot-unrated']);
  });
});

describe('listingAssetAudience', () => {
  it.each([
    [NsfwLevel.PG, 'g', 'com-and-red'],
    [NsfwLevel.PG13, 'pg13', 'com-and-red'],
    // Within SFW but above the listing's own rating: civitai.com does not show it.
    [NsfwLevel.PG13, 'g', 'red-only'],
    [NsfwLevel.R, 'pg13', 'red-only'],
    [NsfwLevel.XXX, 'g', 'red-only'],
    // A mature-rated listing is not on civitai.com at all.
    [NsfwLevel.PG, 'r', 'red-only'],
    // A composite reads as the public gate reads it: any bit inside the ceiling shows it.
    [NsfwLevel.PG | NsfwLevel.R, 'g', 'com-and-red'],
    [0, 'g', 'unrated'],
    [null, 'r', 'unrated'],
  ] as const)('level %s on a %s listing → %s', (level, rating, audience) => {
    expect(listingAssetAudience(level, rating)).toBe(audience);
  });
});

describe('summarizeListingMediaSplit', () => {
  it('names the two floors and whether a split would be accepted', () => {
    expect(
      summarizeListingMediaSplit([
        { kind: 'icon', nsfwLevel: NsfwLevel.PG },
        { kind: 'cover', nsfwLevel: NsfwLevel.PG13 },
        { kind: 'screenshot', position: 1, nsfwLevel: NsfwLevel.X },
      ])
    ).toEqual({
      allMediaRating: 'x',
      comMediaRating: 'pg13',
      splitChangesFloor: true,
      faceEligible: true,
    });
  });

  it('a mature cover makes the split unavailable', () => {
    expect(
      summarizeListingMediaSplit([
        { kind: 'icon', nsfwLevel: NsfwLevel.PG },
        { kind: 'cover', nsfwLevel: NsfwLevel.R },
      ])
    ).toMatchObject({ splitChangesFloor: true, faceEligible: false });
  });

  it('all-SFW media: a split would change nothing', () => {
    expect(
      summarizeListingMediaSplit([
        { kind: 'icon', nsfwLevel: NsfwLevel.PG },
        { kind: 'screenshot', position: 1, nsfwLevel: NsfwLevel.PG13 },
      ])
    ).toEqual({
      allMediaRating: 'pg13',
      comMediaRating: 'pg13',
      splitChangesFloor: false,
      faceEligible: true,
    });
  });
});

describe('resolveListingMediaSplitDecision — what an approve sends', () => {
  const mature = [
    { kind: 'icon' as const, nsfwLevel: NsfwLevel.PG },
    { kind: 'screenshot' as const, position: 1, nsfwLevel: NsfwLevel.R },
  ];
  const sfw = [{ kind: 'icon' as const, nsfwLevel: NsfwLevel.PG }];
  const matureFace = [{ kind: 'cover' as const, nsfwLevel: NsfwLevel.X }];

  it.each([
    ['never split, no choice: default-closed', mature, false, null, true, 'rate-mature'],
    ['already split, no choice: keeps the split', mature, true, null, true, 'split'],
    ['already split, mature face: cannot keep it', matureFace, true, null, true, 'rate-mature'],
    ['an explicit choice wins', mature, true, 'rate-mature', true, 'rate-mature'],
    [
      'a split choice with a mature face is not sent',
      matureFace,
      false,
      'split',
      true,
      'rate-mature',
    ],
    [
      '🔴 all-SFW and never split: hidden, so a stale split choice is not sent',
      sfw,
      false,
      'split',
      false,
      'rate-mature',
    ],
    ['all-SFW but already split: still shown', sfw, true, null, true, 'split'],
  ] as const)('%s', (_l, assets, currentlySplit, choice, shown, value) => {
    expect(resolveListingMediaSplitDecision({ assets, currentlySplit, choice })).toEqual({
      shown,
      value,
    });
  });
});
