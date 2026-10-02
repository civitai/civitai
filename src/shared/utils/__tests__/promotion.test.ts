import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import {
  galleryPromotionRefusal,
  isPromotionLive,
  parseGalleryPromotionData,
  parseHostModelId,
  sponsoredBrowsingLevel,
  sponsoredSlotIndex,
  parseModelPromotionData,
  promotionDeclineTerms,
  promotionAmount,
  promotionRunEndsAt,
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

  it('refuses an image above the page level', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [pg, r],
        host: noHostSettings,
        maxLevel: sfwBrowsingLevelsFlag,
      })
    ).toBe('aboveMaxLevel');
  });

  it('refuses an unrated image rather than reading 0 as allowed', () => {
    expect(
      galleryPromotionRefusal({
        placerId: 7,
        images: [pg, { id: 3, nsfwLevel: 0, tagIds: [] }],
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

  it('ends at the end frozen at accept, not at accept plus the run length', () => {
    const endsAt = '2026-10-01T12:00:00.000Z';
    expect(isPromotionLive({ acceptedAt, days: 1, endsAt }, new Date('2026-10-01T11:59:59Z'))).toBe(
      true
    );
    expect(isPromotionLive({ acceptedAt, days: 1, endsAt }, new Date('2026-10-01T12:00:00Z'))).toBe(
      false
    );
  });
});

describe('promotion payloads', () => {
  it('reads a well-formed gallery payload and refuses a malformed one', () => {
    const gallery = { postId: 5, days: 3, modelVersionIds: [9], imageIds: [11, 12] };
    expect(parseGalleryPromotionData(gallery)).toEqual(gallery);
    expect(parseGalleryPromotionData({ ...gallery, days: 2 })).toBeNull();
    expect(parseGalleryPromotionData({ ...gallery, modelVersionIds: [] })).toBeNull();
    // A post with no approved images could only ever show nothing.
    expect(parseGalleryPromotionData({ ...gallery, imageIds: [] })).toBeNull();
  });

  it('carries the acceptance frozen at accept, and refuses a half-written one', () => {
    const accepted = { acceptedLevel: 3, endsAt: '2026-10-04T00:00:00.000Z' };
    expect(parseModelPromotionData({ modelId: 4, days: 3, ...accepted })).toEqual({
      modelId: 4,
      days: 3,
      ...accepted,
    });
    expect(parseModelPromotionData({ modelId: 4, days: 3, acceptedLevel: 3 })).toBeNull();
    expect(
      parseModelPromotionData({ modelId: 4, days: 3, ...accepted, endsAt: 'soon' })
    ).toBeNull();
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

describe('parseHostModelId', () => {
  it('refuses a download link, whose number is a version, and another site', () => {
    expect(parseHostModelId('https://civitai.com/api/download/models/123')).toBeNull();
    expect(parseHostModelId('https://example.com/models/5')).toBeNull();
  });

  it('reads a model page link or a bare id', () => {
    expect(parseHostModelId('https://civitai.com/models/4201/some-model?modelVersionId=9')).toBe(
      4201
    );
    expect(parseHostModelId(' 4201 ')).toBe(4201);
  });

  it('refuses anything that does not name one model', () => {
    expect(parseHostModelId('https://civitai.com/posts/4201')).toBeNull();
    expect(parseHostModelId('0')).toBeNull();
    expect(parseHostModelId('')).toBeNull();
  });
});

describe('sponsoredBrowsingLevel', () => {
  it("sees past today's gallery cap, up to what the run may be served at", () => {
    expect(
      sponsoredBrowsingLevel({
        browsingLevel: NsfwLevel.PG,
        preCapBrowsingLevel: NsfwLevel.PG | NsfwLevel.R | NsfwLevel.X,
        servingLevel: NsfwLevel.PG | NsfwLevel.R,
      })
    ).toBe(NsfwLevel.PG | NsfwLevel.R);
  });

  it('falls back to the gallery-capped level from a client that sends no viewer level', () => {
    expect(sponsoredBrowsingLevel({ browsingLevel: NsfwLevel.PG, servingLevel: allLevels })).toBe(
      NsfwLevel.PG
    );
  });
});

describe('sponsoredSlotIndex', () => {
  it('goes after the pinned items, else second, else first in an empty list', () => {
    expect(sponsoredSlotIndex(3, 10)).toBe(3);
    expect(sponsoredSlotIndex(0, 10)).toBe(1);
    expect(sponsoredSlotIndex(0, 0)).toBe(0);
  });
});

describe('promotionDeclineTerms', () => {
  it('names the percent and the Buzz a host keeps', () => {
    expect(promotionDeclineTerms(20, 42)).toBe(
      'If they decline, they keep 20% (42 Buzz) and the rest comes back.'
    );
  });

  // Keyed on the Buzz, which is what is held: a held fee is never described as
  // "all of it comes back", whatever the percent says.
  it('promises everything back only when no Buzz is kept', () => {
    expect(promotionDeclineTerms(0, 0)).toBe('If they decline, all of it comes back.');
    expect(promotionDeclineTerms(0, 5)).toBe(
      'If they decline, they keep 0% (5 Buzz) and the rest comes back.'
    );
  });
});
