import { describe, expect, it } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import {
  appDeclaredListingRating,
  assetRating,
  declaredListingRating,
  describeRatingAssets,
  listingRatingAssetLabel,
  listingRatingAssetsFromView,
  summarizeListingRating,
  type ListingRatingDisplayAsset,
} from '~/shared/utils/listing-rating-display';

/** Pairwise-distinct levels, so an asset picked by the wrong field changes the answer. */
const icon: ListingRatingDisplayAsset = { kind: 'icon', nsfwLevel: NsfwLevel.PG };
const cover: ListingRatingDisplayAsset = { kind: 'cover', nsfwLevel: NsfwLevel.PG13 };
const shotR: ListingRatingDisplayAsset = {
  kind: 'screenshot',
  position: 2,
  nsfwLevel: NsfwLevel.R,
};
const shotX: ListingRatingDisplayAsset = {
  kind: 'screenshot',
  position: 3,
  nsfwLevel: NsfwLevel.X,
};

describe('summarizeListingRating', () => {
  it('declared g + one R screenshot: raised to r, hidden, and names only that screenshot', () => {
    const s = summarizeListingRating({
      declaredRating: 'g',
      listingRating: 'r',
      assets: [icon, cover, shotR],
    });
    expect(s.derived).toBe('r');
    expect(s.current).toEqual({ rating: 'r', raised: true, hiddenOnSfw: true });
    expect(s.projected).toEqual({ rating: 'r', raised: true, hiddenOnSfw: true });
    expect(s.drivingAssets).toEqual([shotR]);
    expect(s.projectedExceedsCurrent).toBe(false);
    expect(s.currentExceedsProjected).toBe(false);
    expect(s.allAssetsRated).toBe(true);
  });

  it('a listing rated above what its images require is not explained by them alone', () => {
    const s = summarizeListingRating({
      declaredRating: 'g',
      listingRating: 'x',
      assets: [icon, shotR],
    });
    expect(s.projected.rating).toBe('r');
    expect(s.drivingAssets).toEqual([shotR]);
    expect(s.currentExceedsProjected).toBe(true);
    expect(s.projectedExceedsCurrent).toBe(false);
  });

  it('declared r, every asset PG: mature and hidden, but NOT raised and nothing drives it', () => {
    const s = summarizeListingRating({
      declaredRating: 'r',
      listingRating: 'r',
      assets: [icon, { kind: 'cover', nsfwLevel: NsfwLevel.PG }],
    });
    expect(s.derived).toBe('g');
    expect(s.current).toEqual({ rating: 'r', raised: false, hiddenOnSfw: true });
    expect(s.projected).toEqual({ rating: 'r', raised: false, hiddenOnSfw: true });
    expect(s.drivingAssets).toEqual([]);
  });

  it('declared g, PG-13 max: raised to pg13 but NOT hidden', () => {
    const s = summarizeListingRating({ declaredRating: 'g', assets: [icon, cover] });
    expect(s.derived).toBe('pg13');
    expect(s.projected).toEqual({ rating: 'pg13', raised: true, hiddenOnSfw: false });
    expect(s.drivingAssets).toEqual([cover]);
  });

  it('unscanned (null / 0) levels raise nothing and are reported as not all rated', () => {
    const s = summarizeListingRating({
      declaredRating: 'g',
      listingRating: 'g',
      assets: [
        { kind: 'icon', nsfwLevel: null },
        { kind: 'cover', nsfwLevel: 0 },
        { kind: 'screenshot', position: 1, nsfwLevel: undefined },
      ],
    });
    expect(s.derived).toBe('g');
    expect(s.projected).toEqual({ rating: 'g', raised: false, hiddenOnSfw: false });
    expect(s.drivingAssets).toEqual([]);
    expect(s.allAssetsRated).toBe(false);
  });

  it('with no assets supplied, derives nothing and projects the declared rating', () => {
    const s = summarizeListingRating({ declaredRating: 'pg13', listingRating: 'x' });
    expect(s.derived).toBeNull();
    expect(s.current).toEqual({ rating: 'x', raised: true, hiddenOnSfw: true });
    expect(s.projected).toEqual({ rating: 'pg13', raised: false, hiddenOnSfw: false });
    expect(s.drivingAssets).toEqual([]);
    expect(s.allAssetsRated).toBe(false);
  });

  it('an empty asset list derives g but is not "every image rated"', () => {
    const s = summarizeListingRating({ declaredRating: 'g', listingRating: 'r', assets: [] });
    expect(s.derived).toBe('g');
    expect(s.allAssetsRated).toBe(false);
    expect(s.drivingAssets).toEqual([]);
  });

  it('only the assets at the TOP level drive the rating, not every asset above declared', () => {
    const s = summarizeListingRating({ declaredRating: 'pg', assets: [cover, shotR, shotX] });
    expect(s.derived).toBe('x');
    expect(s.drivingAssets).toEqual([shotX]);
  });

  it('a listing still rated below what its assets need has a raise pending', () => {
    const s = summarizeListingRating({
      declaredRating: 'g',
      listingRating: 'g',
      assets: [icon, shotR],
    });
    expect(s.current).toEqual({ rating: 'g', raised: false, hiddenOnSfw: false });
    expect(s.projected).toEqual({ rating: 'r', raised: true, hiddenOnSfw: true });
    expect(s.projectedExceedsCurrent).toBe(true);
    expect(s.currentExceedsProjected).toBe(false);
  });

  it('g and pg permit the same level, so neither counts as a raise over the other', () => {
    expect(
      summarizeListingRating({ declaredRating: 'g', listingRating: 'pg' }).current.raised
    ).toBe(false);
    expect(summarizeListingRating({ declaredRating: 'pg', assets: [icon] }).projected).toEqual({
      rating: 'pg',
      raised: false,
      hiddenOnSfw: false,
    });
  });

  it('an unknown declared rating is treated as SFW, so mature assets still raise it', () => {
    const s = summarizeListingRating({ declaredRating: null, assets: [shotR] });
    expect(s.declared).toBeNull();
    expect(s.projected).toEqual({ rating: 'r', raised: true, hiddenOnSfw: true });
    expect(s.drivingAssets).toEqual([shotR]);
  });
});

describe('assetRating', () => {
  it('maps a detected level to the listing rating it requires, and no level to null', () => {
    expect(assetRating(NsfwLevel.PG)).toBe('g');
    expect(assetRating(NsfwLevel.PG13)).toBe('pg13');
    expect(assetRating(NsfwLevel.R)).toBe('r');
    expect(assetRating(NsfwLevel.XXX)).toBe('x');
    expect(assetRating(0)).toBeNull();
    expect(assetRating(null)).toBeNull();
  });
});

describe('describeRatingAssets', () => {
  it('names each asset with its rating, joined as prose', () => {
    expect(describeRatingAssets([shotR])).toBe('Screenshot 2 (R)');
    expect(describeRatingAssets([cover, shotR])).toBe('Cover (PG-13) and Screenshot 2 (R)');
    expect(describeRatingAssets([icon, cover, shotX])).toBe(
      'Icon (G), Cover (PG-13) and Screenshot 3 (X)'
    );
    expect(describeRatingAssets([])).toBe('');
  });
});

describe('listingRatingAssetsFromView', () => {
  it('skips an absent icon/cover and numbers only screenshots that still have an image', () => {
    expect(
      listingRatingAssetsFromView({
        iconId: null,
        iconNsfwLevel: null,
        coverId: 53,
        coverNsfwLevel: NsfwLevel.PG13,
        screenshots: [
          { imageId: 61, nsfwLevel: NsfwLevel.PG },
          { imageId: null, nsfwLevel: null },
          { imageId: 67, nsfwLevel: NsfwLevel.R },
        ],
      })
    ).toEqual([
      { kind: 'cover', nsfwLevel: NsfwLevel.PG13 },
      { kind: 'screenshot', position: 1, nsfwLevel: NsfwLevel.PG },
      { kind: 'screenshot', position: 2, nsfwLevel: NsfwLevel.R },
    ]);
  });

  it('🔴 appends the civitai.red overrides last, each marked as one, with its own level', () => {
    expect(
      listingRatingAssetsFromView({
        iconId: 51,
        iconNsfwLevel: NsfwLevel.PG,
        coverId: null,
        coverNsfwLevel: null,
        screenshots: [],
        redIconId: 71,
        redIconNsfwLevel: NsfwLevel.XXX,
        redCoverId: 72,
        redCoverNsfwLevel: NsfwLevel.R,
      })
    ).toEqual([
      { kind: 'icon', nsfwLevel: NsfwLevel.PG },
      { kind: 'red-icon', nsfwLevel: NsfwLevel.XXX, redSlot: true },
      { kind: 'red-cover', nsfwLevel: NsfwLevel.R, redSlot: true },
    ]);
  });

  it('labels the overrides by host', () => {
    expect(listingRatingAssetLabel({ kind: 'red-icon', nsfwLevel: 1, redSlot: true })).toBe(
      'civitai.red icon'
    );
    expect(listingRatingAssetLabel({ kind: 'red-cover', nsfwLevel: 1, redSlot: true })).toBe(
      'civitai.red cover'
    );
  });
});

describe('appDeclaredListingRating', () => {
  it('an on-site listing declares through its app row', () => {
    expect(appDeclaredListingRating({ kind: 'onsite', appRating: 'pg13' })).toBe('pg13');
  });

  it('an on-site listing with no app row declares nothing', () => {
    expect(appDeclaredListingRating({ kind: 'onsite', appRating: null })).toBe(null);
    expect(appDeclaredListingRating({ kind: 'onsite', appRating: undefined })).toBe(null);
  });

  it('an off-site listing declares nothing, even with an app row', () => {
    expect(appDeclaredListingRating({ kind: 'offsite', appRating: 'pg13' })).toBe(null);
  });
});

describe('declaredListingRating', () => {
  it('an on-site listing declares through its app row, not through the listing rating', () => {
    expect(declaredListingRating({ kind: 'onsite', appRating: 'g', listingRating: 'r' })).toBe('g');
  });

  it('before the first approval there is no app row: the listing still carries the submitted rating', () => {
    expect(declaredListingRating({ kind: 'onsite', appRating: null, listingRating: 'pg13' })).toBe(
      'pg13'
    );
    expect(
      declaredListingRating({ kind: 'onsite', appRating: undefined, listingRating: null })
    ).toBe(null);
  });

  it('an off-site listing has no separate declaration, whatever columns it carries', () => {
    expect(declaredListingRating({ kind: 'offsite', appRating: 'g', listingRating: 'r' })).toBe(
      null
    );
  });
});
