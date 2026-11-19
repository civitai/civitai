import { childBrowsingTagIds } from '@civitai/shared';
import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { transformData } from '~/server/search-index/articles.search-index';
import { getComicSearchRecords } from '~/server/search-index/comics.search-index';

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = 7;

describe("an article's search document cover, by tag and level", () => {
  type Input = Parameters<typeof transformData>[0];
  const image = (id: number, nsfwLevel: NsfwLevel, tagIds: number[] = []) => ({
    id,
    url: `key-${id}`,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null,
    modelRestricted: false,
    meta: null,
    tags: tagIds.map((tagId) => ({ tag: { id: tagId, name: `t${tagId}` } })),
  });
  const coverOf = async (coverImage: unknown, bannerImage: unknown = null) => {
    const { records } = await transformData({
      articles: [
        {
          id: 1,
          nsfwLevel: 1,
          content: '<p>Hi</p>',
          tags: [],
          stats: null,
          coverImage,
          bannerImage,
        } as unknown as Input['articles'][number],
      ],
      cosmetics: {},
    });
    return records.map((r) => r.coverImage?.id ?? null);
  };

  it('keeps a cover above PG13 carrying a child tag', async () => {
    expect(await coverOf(image(10, NsfwLevel.R, [OTHER_TAG, CHILD_TAG]), image(11, 1))).toEqual([
      10,
    ]);
  });

  it('falls back to a banner above PG13 carrying a child tag', async () => {
    expect(await coverOf(null, image(11, NsfwLevel.X, [CHILD_TAG]))).toEqual([11]);
  });
});

describe("a comic's search document cover, by tag and level", () => {
  const recordFor = async (coverImageNsfwLevel: number, coverImageTagIds: number[]) => {
    const row = {
      id: 3,
      name: 'c',
      description: null,
      genre: null,
      nsfwLevel: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userId: 9,
      coverImageUrl: 'key-30',
      coverImageNsfwLevel,
      coverImageTagIds,
      user: { id: 9, username: 'u', deletedAt: null, image: null, profilePictureId: null },
      stats: null,
    };
    const [record] = await getComicSearchRecords({ $queryRaw: vi.fn(async () => [row]) } as never, [
      3,
    ]);
    return record;
  };

  it('keeps a cover above PG13 carrying a child tag', async () => {
    const record = await recordFor(NsfwLevel.R, [CHILD_TAG]);
    expect(record).toMatchObject({
      id: 3,
      coverImageUrl: 'key-30',
      coverImageNsfwLevel: NsfwLevel.R,
      coverImageTagIds: [CHILD_TAG],
    });
  });
});
