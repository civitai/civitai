import { describe, expect, it } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';
import { transformData } from '~/server/search-index/bounties.search-index';

const bounty = (details: Record<string, unknown>) =>
  ({
    id: 1,
    details,
    nsfwLevel: 1,
    cosmetics: [],
    user: { id: 2, profilePictureId: null },
    tags: [],
    images: [],
    stats: null,
  } as never);

describe('bounties search index transformData', () => {
  it('leaves the profanity fields and the text scan record out of the indexed details', async () => {
    const [record] = await transformData({
      bounties: [
        bounty({
          baseModel: 'SD 1.5',
          profanityMatches: ['term'],
          profanityEvaluation: { reason: 'test reason' },
          textScanNsfw: { workflowId: 'w', level: 4 },
        }),
      ],
      imageTags: [],
      profilePictures: [],
    });

    expect(record.details).toEqual({ baseModel: 'SD 1.5' });
  });
});

describe('bounties search index images', () => {
  const CHILD_TAG = childBrowsingTagIds[0];
  const OTHER_TAG = 999001;
  const withImages = (images: { id: number; nsfwLevel: number; minor?: boolean }[]) =>
    ({ ...(bounty({}) as object), images } as never);
  const tag = (imageId: number, tagId: number) => ({ imageId, tagId, tag: { name: 't' } });

  it('keeps an image above PG13 carrying a child tag', async () => {
    const [record] = await transformData({
      bounties: [
        withImages([
          { id: 10, nsfwLevel: NsfwLevel.R },
          { id: 11, nsfwLevel: NsfwLevel.R },
          { id: 12, nsfwLevel: NsfwLevel.PG13 },
        ]),
      ],
      imageTags: [tag(10, CHILD_TAG), tag(11, OTHER_TAG), tag(12, CHILD_TAG)],
      profilePictures: [],
    });

    expect(record.images.map((i: { id: number }) => i.id)).toEqual([10, 11, 12]);
  });

  it('🔴 leaves out a restricted minor image, without the flag on the rest', async () => {
    const [record] = await transformData({
      bounties: [
        withImages([
          { id: 10, nsfwLevel: NsfwLevel.R, minor: true },
          { id: 11, nsfwLevel: NsfwLevel.PG13, minor: true },
          { id: 12, nsfwLevel: NsfwLevel.R, minor: false },
        ]),
      ],
      imageTags: [],
      profilePictures: [],
    });

    expect(record.images.map((i: { id: number }) => i.id)).toEqual([11, 12]);
    expect(record.images[0]).not.toHaveProperty('minor');
  });

  it('counts every image of a bounty marked nsfw as mature, as the feed does', async () => {
    const images = [{ id: 12, nsfwLevel: NsfwLevel.PG13, minor: true }];
    const [marked, unmarked] = await transformData({
      bounties: [
        { ...(withImages(images) as object), nsfw: true } as never,
        { ...(withImages(images) as object), id: 2, nsfw: false } as never,
      ],
      imageTags: [],
      profilePictures: [],
    });

    expect(marked.images).toEqual([]);
    expect(unmarked.images.map((i: { id: number }) => i.id)).toEqual([12]);
    expect(marked).not.toHaveProperty('nsfw');
  });
});
