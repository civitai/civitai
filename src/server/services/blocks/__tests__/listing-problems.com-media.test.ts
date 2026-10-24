import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  computeListingProblems,
  type ListingAssetScan,
  type ListingProblemInput,
} from '~/server/services/blocks/listing-problems';

/** Complete in every other dimension, so only the civitai.com media problems can fire. */
const base: ListingProblemInput = {
  kind: 'offsite',
  iconId: 61,
  coverId: 62,
  screenshotCount: 3,
  description: 'A useful app.',
  tagline: 'Does the thing',
  category: 'utility',
  status: 'approved',
  contentRating: 'g',
  declaredContentRating: null,
};

const scan = (kind: ListingAssetScan['kind'], nsfwLevel: number): ListingAssetScan => ({
  kind,
  status: 'scanned',
  nsfwLevel,
});

const problems = (over: Partial<ListingProblemInput>) =>
  computeListingProblems({ ...base, ...over }).problems;

describe('computeListingProblems — civitai.com media', () => {
  it('🔴 an icon rated above the listing says civitai.com shows a placeholder for it', () => {
    expect(
      problems({ assetScans: [scan('icon', NsfwLevel.R), scan('cover', NsfwLevel.PG)] })
    ).toEqual([
      {
        code: 'sfw-slot-mature',
        severity: 'advisory',
        label:
          "Your icon is rated R, above this listing's rating, so civitai.com shows a placeholder instead (civitai.red still shows it). Replace it with an image within the listing's rating.",
      },
    ]);
  });

  it('a cover rated above the listing says civitai.com shows another image', () => {
    expect(problems({ assetScans: [scan('cover', NsfwLevel.X)] })).toEqual([
      {
        code: 'sfw-slot-mature',
        severity: 'advisory',
        label:
          "Your cover is rated X, above this listing's rating, so civitai.com shows another image instead (civitai.red still shows it). Replace it with an image within the listing's rating.",
      },
    ]);
  });

  it('screenshots rated above the listing raise no problem; the icon beside them still does', () => {
    expect(
      problems({
        assetScans: [
          scan('icon', NsfwLevel.R),
          scan('screenshot', NsfwLevel.R),
          scan('screenshot', NsfwLevel.PG),
          scan('screenshot', NsfwLevel.XXX),
        ],
      }).map((p) => p.code)
    ).toEqual(['sfw-slot-mature']);
  });

  it('measures against the listing rating, not SFW: a PG-13 icon on a g listing is flagged, on a pg13 one it is not', () => {
    const assetScans = [scan('icon', NsfwLevel.PG13)];
    expect(problems({ assetScans }).map((p) => p.code)).toEqual(['sfw-slot-mature']);
    expect(problems({ assetScans, contentRating: 'pg13' })).toEqual([]);
  });

  it.each([
    ['not live', { status: 'pending' }],
    ['hidden from civitai.com by its own rating', { contentRating: 'r' }],
  ])('a listing %s raises none of them', (_label, over) => {
    expect(
      problems({
        ...over,
        assetScans: [scan('icon', NsfwLevel.R), scan('screenshot', NsfwLevel.R)],
      })
    ).toEqual([]);
  });

  it('an unrated asset, or a scan with no level, raises none', () => {
    expect(
      problems({
        assetScans: [scan('icon', 0), { kind: 'screenshot', status: 'scanned' }],
      })
    ).toEqual([]);
  });
});
