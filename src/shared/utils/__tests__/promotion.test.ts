import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import {
  galleryPromotionRefusal,
  isPromotionLive,
  parseGalleryPromotionData,
  parseModelPromotionData,
  promotionAmount,
  promotionRunEndsAt,
  PROMOTION_REMOVAL_LOCK_HOURS,
  PROMOTION_RUN_DAYS,
  PROMOTION_SURFACES,
} from '~/shared/utils/promotion';

const noHostSettings = { hiddenUserIds: [], hiddenTagIds: [], hiddenImageIds: [] };
const pg = { id: 1, nsfwLevel: NsfwLevel.PG, tagIds: [10] };
const r = { id: 2, nsfwLevel: NsfwLevel.R, tagIds: [20] };
const allLevels = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;

describe('galleryPromotionRefusal', () => {
  it('accepts a rated post the host has not hidden', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [pg, r],
        host: noHostSettings,
        maxLevel: allLevels,
      })
    ).toBeNull();
  });

  it('refuses an image above the page level, so a minor-flagged host stays PG/PG-13', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [pg, r],
        host: noHostSettings,
        maxLevel: sfwBrowsingLevelsFlag,
      })
    ).toBe('aboveMaxLevel');
  });

  it("refuses an image above the host's gallery level cap", () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [pg, r],
        host: { ...noHostSettings, level: sfwBrowsingLevelsFlag },
        maxLevel: allLevels,
      })
    ).toBe('aboveGalleryLevel');
  });

  it('refuses an unrated image rather than reading 0 as allowed', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [{ id: 3, nsfwLevel: 0, tagIds: [] }],
        host: noHostSettings,
        maxLevel: allLevels,
      })
    ).toBe('unrated');
  });

  it.each([
    ['the promoter', { ...noHostSettings, hiddenUserIds: [7] }],
    ['a tag', { ...noHostSettings, hiddenTagIds: [20] }],
    ['an image', { ...noHostSettings, hiddenImageIds: [2] }],
  ])('gives one answer when the host has hidden %s, so no private list is revealed', (_, host) => {
    expect(
      galleryPromotionRefusal({ placerId: 7, images: [pg, r], host, maxLevel: allLevels })
    ).toBe('hiddenByHost');
  });

  it('refuses a post with no images', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [],
        host: noHostSettings,
        maxLevel: allLevels,
      })
    ).toBe('noImages');
  });
});

describe('promotion runs', () => {
  const acceptedAt = new Date('2026-10-01T00:00:00Z');

  it('charges the daily price for every day', () => {
    expect(promotionAmount(120, 3)).toBe(360);
  });

  it('ends exactly N days after accept', () => {
    expect(promotionRunEndsAt(acceptedAt, 7).toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('is live from accept until the end, and not after', () => {
    expect(isPromotionLive({ acceptedAt, days: 1 }, new Date('2026-10-01T23:59:59Z'))).toBe(true);
    expect(isPromotionLive({ acceptedAt, days: 1 }, new Date('2026-10-02T00:00:00Z'))).toBe(false);
    expect(isPromotionLive({ acceptedAt, days: 1 }, new Date('2026-09-30T23:59:59Z'))).toBe(false);
  });

  // Decision 19: a host is held to an accepted run. If a longer run is added,
  // or the lock shortened, a host could end a paid run early and keep the Buzz.
  it('holds the host for at least the longest run', () => {
    expect(PROMOTION_REMOVAL_LOCK_HOURS).toBeGreaterThanOrEqual(
      Math.max(...PROMOTION_RUN_DAYS) * 24
    );
  });
});

describe('promotion payloads', () => {
  it('reads a well-formed gallery payload and refuses a malformed one', () => {
    expect(parseGalleryPromotionData({ postId: 5, days: 3, modelVersionIds: [9] })).toEqual({
      postId: 5,
      days: 3,
      modelVersionIds: [9],
    });
    expect(parseGalleryPromotionData({ postId: 5, days: 2, modelVersionIds: [9] })).toBeNull();
    expect(parseGalleryPromotionData({ postId: 5, days: 3, modelVersionIds: [] })).toBeNull();
  });

  it('reads a well-formed model payload and refuses a malformed one', () => {
    expect(parseModelPromotionData({ modelId: 4, days: 7 })).toEqual({ modelId: 4, days: 7 });
    expect(parseModelPromotionData({ modelId: -1, days: 7 })).toBeNull();
  });
});

describe('promotion surfaces', () => {
  it.each(PROMOTION_SURFACES)('%s is reviewed, never free, and never auto-accepted', (surface) => {
    const config = PLACEMENT_SURFACES[surface];
    expect(config.allowedModes).not.toContain('auto');
    expect(config.defaultFreeSlots).toBe(0);
    expect(config.targets).toEqual(['model']);
  });
});
