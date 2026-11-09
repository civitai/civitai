import { describe, expect, it } from 'vitest';
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
  it('leaves the profanity fields out of the indexed details', async () => {
    const [record] = await transformData({
      bounties: [
        bounty({
          baseModel: 'SD 1.5',
          profanityMatches: ['term'],
          profanityEvaluation: { reason: 'test reason' },
        }),
      ],
      imageTags: [],
      profilePictures: [],
    });

    expect(record.details).toEqual({ baseModel: 'SD 1.5' });
  });
});
