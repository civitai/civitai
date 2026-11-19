import { childBrowsingTagIds } from '@civitai/shared';
import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { PublicCoverImage } from '~/server/utils/public-cover-image';
import { isPublicCoverImage, publicCoverImageSelect } from '~/server/utils/public-cover-image';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

const ALL_LEVELS = 31;
const CHILD_TAG = childBrowsingTagIds[0];

const cover = (over: Partial<PublicCoverImage>): PublicCoverImage => ({
  id: 1,
  url: 'cover',
  type: MediaType.image,
  width: 100,
  height: 100,
  nsfwLevel: NsfwLevel.R,
  ingestion: ImageIngestionStatus.Scanned,
  scannedAt: new Date(),
  tosViolation: false,
  needsReview: null,
  blockedFor: null,
  poi: false,
  minor: false,
  acceptableMinor: false,
  postId: null,
  tags: [],
  ...over,
});

describe('isPublicCoverImage and child tags', () => {
  it('refuses an R cover carrying a child tag', () => {
    expect(isPublicCoverImage(cover({ tags: [{ tagId: CHILD_TAG }] }), ALL_LEVELS)).toBe(false);
  });

  it('refuses an R cover whose tags were not selected', () => {
    expect(isPublicCoverImage(cover({ tags: undefined }), ALL_LEVELS)).toBe(false);
  });

  it.each([
    ['an R cover with no tags', cover({})],
    ['an R cover with another tag', cover({ tags: [{ tagId: 777 }] })],
    [
      'a PG-13 cover with a child tag',
      cover({ nsfwLevel: NsfwLevel.PG13, tags: [{ tagId: CHILD_TAG }] }),
    ],
    [
      'a PG-13 cover whose tags were not selected',
      cover({ nsfwLevel: NsfwLevel.PG13, tags: undefined }),
    ],
  ])('serves %s', (_, image) => {
    expect(isPublicCoverImage(image, ALL_LEVELS)).toBe(true);
  });

  it('selects only enabled tags', () => {
    expect(publicCoverImageSelect.tags).toEqual({
      where: { disabled: false },
      select: { tagId: true },
    });
  });
});
