import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import {
  RATING_CHANGE_ACTION,
  listingRatingChangeReason,
  loadListingRatingAssets,
  recordListingRatingChange,
  recordListingRatingChangeAfterCommit,
  resolveReDerivedListingRating,
  type ListingRatingAsset,
} from '~/server/services/blocks/app-listing-rating';
import { moderationActionChip } from '~/components/Apps/appListingModerationView';

const scanned = (imageId: number, nsfwLevel: number): ListingRatingAsset => ({
  imageId,
  nsfwLevel,
  ingestion: 'Scanned',
});

describe('resolveReDerivedListingRating', () => {
  const assets = [scanned(1, NsfwLevel.PG), scanned(2, NsfwLevel.PG13), scanned(3, NsfwLevel.PG)];
  const base = {
    assets,
    reratedImageId: 3,
    previousNsfwLevel: NsfwLevel.R,
    reviewedRating: null as string | null,
    mediaSplit: false,
  };

  it('lowers to max(declared, derived) when the re-rated image explains the stored rating', () => {
    expect(resolveReDerivedListingRating({ ...base, stored: 'r', declared: 'g' })).toBe('pg13');
  });

  it('🔴 on a split listing a correction lowers by the civitai.com media, on both sides of the guard', () => {
    // Icon PG, screenshot 2 R, screenshot 1 corrected PG-13 → PG. Split, the R screenshot floors
    // nothing: before the correction the media explained pg13, after it g. Unsplit, R raises.
    const split = {
      assets: [scanned(1, NsfwLevel.PG), scanned(2, NsfwLevel.PG), scanned(3, NsfwLevel.R)],
      reratedImageId: 2,
      previousNsfwLevel: NsfwLevel.PG13,
      reviewedRating: null,
      stored: 'pg13',
      declared: 'g',
    };
    expect(resolveReDerivedListingRating({ ...split, mediaSplit: true })).toBe('g');
    expect(resolveReDerivedListingRating({ ...split, mediaSplit: false })).toBe('r');
  });

  it('on a split listing an unsettled image above SFW does not block a lowering', () => {
    const assets = [
      scanned(1, NsfwLevel.PG),
      scanned(2, NsfwLevel.PG),
      { imageId: 3, nsfwLevel: NsfwLevel.R, ingestion: 'Pending' },
    ];
    const args = {
      assets,
      reratedImageId: 2,
      previousNsfwLevel: NsfwLevel.PG13,
      reviewedRating: null,
      stored: 'pg13',
      declared: 'g',
    };
    expect(resolveReDerivedListingRating({ ...args, mediaSplit: true })).toBe('g');
  });

  it('never lowers past the newest review decision; lowers to it when it sits between', () => {
    expect(
      resolveReDerivedListingRating({ ...base, stored: 'r', declared: 'g', reviewedRating: 'r' })
    ).toBeNull();
    expect(
      resolveReDerivedListingRating({ ...base, stored: 'r', declared: 'g', reviewedRating: 'x' })
    ).toBeNull();
    expect(
      resolveReDerivedListingRating({
        ...base,
        stored: 'x',
        declared: 'g',
        previousNsfwLevel: NsfwLevel.X,
        reviewedRating: 'r',
      })
    ).toBe('r');
    // Below the target it changes nothing, and an out-of-ladder value is ignored.
    expect(
      resolveReDerivedListingRating({ ...base, stored: 'r', declared: 'g', reviewedRating: 'g' })
    ).toBe('pg13');
    expect(
      resolveReDerivedListingRating({
        ...base,
        stored: 'r',
        declared: 'g',
        reviewedRating: 'mature',
      })
    ).toBe('pg13');
  });

  it('lowers to the declared rating when the media is tamer than it', () => {
    expect(
      resolveReDerivedListingRating({
        ...base,
        stored: 'x',
        declared: 'r',
        previousNsfwLevel: NsfwLevel.X,
      })
    ).toBe('r');
  });

  it('leaves a rating already at the target alone, including a g/pg label difference', () => {
    expect(resolveReDerivedListingRating({ ...base, stored: 'pg13', declared: 'g' })).toBeNull();
    expect(
      resolveReDerivedListingRating({
        stored: 'pg',
        declared: 'g',
        assets: [scanned(3, NsfwLevel.PG)],
        reratedImageId: 3,
        previousNsfwLevel: NsfwLevel.PG,
      })
    ).toBeNull();
  });

  it('does not lower a stored rating above what the previous level produced', () => {
    expect(resolveReDerivedListingRating({ ...base, stored: 'x', declared: 'g' })).toBeNull();
  });

  it('does not lower a stored rating BELOW what the previous level produced either', () => {
    // Stored r, previous level X: the image never drove this rating.
    expect(
      resolveReDerivedListingRating({
        ...base,
        stored: 'r',
        declared: 'g',
        previousNsfwLevel: NsfwLevel.X,
      })
    ).toBeNull();
  });

  it('raises to the declared rating when the stored one sits below it', () => {
    expect(resolveReDerivedListingRating({ ...base, stored: 'pg13', declared: 'x' })).toBe('x');
  });

  it('with no declared rating: raises to the media, never lowers', () => {
    expect(resolveReDerivedListingRating({ ...base, stored: 'g', declared: null })).toBe('pg13');
    expect(resolveReDerivedListingRating({ ...base, stored: 'r', declared: null })).toBeNull();
  });

  it.each(['mature', 'xxx', ''])(
    'an out-of-ladder declared value (%j) is no floor: nothing is lowered to or past it',
    (declared) => {
      // 'xxx' maps to a level ABOVE the ladder; read as a floor it would "raise" r to the
      // derived g. '' and 'mature' map to the lowest rung and would let r drop to g.
      expect(
        resolveReDerivedListingRating({
          stored: 'r',
          declared,
          assets: [scanned(3, NsfwLevel.PG)],
          reratedImageId: 3,
          previousNsfwLevel: NsfwLevel.R,
        })
      ).toBeNull();
    }
  );

  it('an out-of-ladder declared value still lets the media raise the rating', () => {
    expect(
      resolveReDerivedListingRating({
        stored: 'pg',
        declared: 'mature',
        assets: [scanned(3, NsfwLevel.X)],
        reratedImageId: 3,
        previousNsfwLevel: NsfwLevel.PG,
      })
    ).toBe('x');
  });
});

describe('listingRatingChangeReason', () => {
  it.each([
    ['store-media', 'g', 'r', 'Rating changed G → R: store imagery was rated R.'],
    ['review', 'r', 'pg13', 'Rating changed R → PG-13 at review.'],
    ['image-review', 'r', 'pg13', 'Rating lowered R → PG-13 after a moderator reviewed an image.'],
    ['image-review', 'pg', 'x', 'Rating raised PG → X after a moderator reviewed an image.'],
    ['store-media', null, 'x', 'Rating changed unrated → X: store imagery was rated X.'],
  ] as const)('%s %s → %s', (cause, before, after, sentence) => {
    expect(listingRatingChangeReason({ cause, before, after })).toBe(sentence);
  });
});

describe('the rating-change event', () => {
  const create = dbMock.dbWrite.appListingModerationEvent.create;
  const change = {
    appListingId: 'apl_1',
    slug: 'an-app',
    before: 'g' as string | null,
    after: 'r' as string | null,
    actorUserId: 55,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.appListing.findUnique.mockResolvedValue({ iconId: 1, coverId: 2 } as never);
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: 3 }] as never);
    // Returns only the selected columns, so a dropped `select` key reads undefined here too.
    dbMock.dbWrite.image.findMany.mockImplementation((async (args: {
      select: Record<string, true>;
    }) =>
      [
        { id: 1, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' },
        { id: 2, nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned' },
        { id: 3, nsfwLevel: NsfwLevel.R, ingestion: 'Scanned' },
      ].map((row) =>
        Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k as keyof typeof row]]))
      )) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('is a registered action with a readable badge', () => {
    expect(APP_LISTING_MODERATION_ACTIONS).toContain(RATING_CHANGE_ACTION);
    expect(moderationActionChip('rating-change')).toEqual({
      label: 'Content rating changed',
      color: 'blue',
    });
  });

  it('recordListingRatingChange writes one event, and none when the value is unchanged', async () => {
    const written = await recordListingRatingChange(dbMock.dbWrite, {
      ...change,
      cause: 'image-review',
    });
    expect(written).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);

    create.mockClear();
    const skipped = await recordListingRatingChange(dbMock.dbWrite, {
      ...change,
      after: 'g',
      cause: 'image-review',
    });
    expect(skipped).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('after commit: a raise onto the media level is attributed to the media', async () => {
    await recordListingRatingChangeAfterCommit(change);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^alme_/),
        appListingId: 'apl_1',
        slug: 'an-app',
        action: 'rating-change',
        actorUserId: 55,
        reason: 'Rating changed G → R: store imagery was rated R.',
        detail: 'store-media',
        before: { contentRating: 'g' },
        after: { contentRating: 'r' },
      },
    });
  });

  it('after commit: on a split listing the cause is judged by the civitai.com media only', async () => {
    // Icon PG, cover PG-13, screenshot R. Split, the media floor is pg13, so g → pg13 is the
    // media's doing; unsplit it is r, so the same move reads as a review decision.
    const splitAnswer = (split: boolean) =>
      dbMock.dbWrite.$queryRaw.mockImplementation((async (
        strings: TemplateStringsArray,
        ...v: unknown[]
      ) =>
        strings.join('').includes('to_regclass')
          ? [{ present: true, can_select: true, can_insert: true, can_update: true }]
          : [{ split: split && v[0] === 'apl_1' }]) as never);

    splitAnswer(true);
    await recordListingRatingChangeAfterCommit({ ...change, after: 'pg13' });
    splitAnswer(false);
    await recordListingRatingChangeAfterCommit({ ...change, after: 'pg13' });

    expect(create.mock.calls.map((c) => c[0].data.detail)).toEqual(['store-media', 'review']);
  });

  it.each([
    ['a raise above the media (a review override)', 'g', 'x'],
    ['a lowering', 'x', 'r'],
  ])('after commit: %s is attributed to the review, not to an image', async (_l, before, after) => {
    await recordListingRatingChangeAfterCommit({ ...change, before, after });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      detail: 'review',
      after: { contentRating: after },
    });
  });

  it('after commit: an unchanged value reads nothing and writes nothing', async () => {
    await recordListingRatingChangeAfterCommit({ ...change, after: 'g' });

    expect(dbMock.dbWrite.appListing.findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('after commit: a failed asset read is swallowed, and warned about', async () => {
    dbMock.dbWrite.appListing.findUnique.mockRejectedValue(new Error('connection refused'));

    await expect(recordListingRatingChangeAfterCommit(change)).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '[listing-rating] rating changed (g → r) on apl_1 but its history event was not written: connection refused'
    );
  });

  it('loadListingRatingAssets keeps each image’s scan state beside its level', async () => {
    expect(await loadListingRatingAssets(dbMock.dbWrite, 'apl_1')).toEqual([
      { imageId: 1, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' },
      { imageId: 2, nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned' },
      { imageId: 3, nsfwLevel: NsfwLevel.R, ingestion: 'Scanned' },
    ]);
  });

  it('loadListingRatingAssets lists an image filling two slots once', async () => {
    dbMock.dbWrite.appListing.findUnique.mockResolvedValue({ iconId: 3, coverId: 3 } as never);

    expect(await loadListingRatingAssets(dbMock.dbWrite, 'apl_1')).toEqual([
      { imageId: 3, nsfwLevel: NsfwLevel.R, ingestion: 'Scanned' },
    ]);
  });

  it('after commit: a rejected insert is swallowed', async () => {
    create.mockRejectedValue(Object.assign(new Error('check constraint'), { code: '23514' }));

    await expect(recordListingRatingChangeAfterCommit(change)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
