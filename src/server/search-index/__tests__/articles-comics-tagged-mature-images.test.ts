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

  it('indexes the article without a cover above PG13 carrying a child tag, nor its banner', async () => {
    expect(await coverOf(image(10, NsfwLevel.R, [OTHER_TAG, CHILD_TAG]), image(11, 1))).toEqual([
      null,
    ]);
  });

  it('carries no banner above PG13 carrying a child tag', async () => {
    expect(await coverOf(null, image(11, NsfwLevel.X, [CHILD_TAG]))).toEqual([]);
  });

  it('keeps a PG13 cover with a child tag, and an R cover without one', async () => {
    expect(await coverOf(image(10, NsfwLevel.PG13, [CHILD_TAG]))).toEqual([10]);
    expect(await coverOf(image(10, NsfwLevel.R, [OTHER_TAG]))).toEqual([10]);
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

  it('drops a cover above PG13 carrying a child tag, and keeps the comic', async () => {
    const record = await recordFor(NsfwLevel.R, [CHILD_TAG]);
    expect(record).toMatchObject({ id: 3, coverImageUrl: null, coverImageNsfwLevel: null });
    expect(record).not.toHaveProperty('coverImageTagIds');
  });

  it('keeps a PG13 cover with a child tag, and an R cover without one', async () => {
    expect((await recordFor(NsfwLevel.PG13, [CHILD_TAG]))?.coverImageUrl).toBe('key-30');
    expect((await recordFor(NsfwLevel.R, [OTHER_TAG]))?.coverImageUrl).toBe('key-30');
  });
});
