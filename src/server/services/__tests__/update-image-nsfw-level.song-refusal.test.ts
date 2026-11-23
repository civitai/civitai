import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * A song is published only by its own scan. A moderator's rating locks the level, and a locked level
 * counts as reviewed, so a lock on a song would publish it without that scan: the moderator branch
 * refuses a song before it writes. The rating level and lock of a picture are covered in
 * update-image-nsfw-level.listing-rating.test.ts.
 */

const { updateImageNsfwLevel } = await import('../image.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    type: 'audio',
    metadata: {},
    postId: 1,
    nsfwLevel: NsfwLevel.PG,
  } as never);
});

describe("a moderator's rating of a song", () => {
  it('is refused, and nothing is written', async () => {
    await expect(
      updateImageNsfwLevel({
        id: 990000101,
        nsfwLevel: NsfwLevel.X,
        userId: 990000040,
        isModerator: true,
      } as never)
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('A song is published only by its own scan'),
    });

    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageRatingRequest.updateMany).not.toHaveBeenCalled();
  });
});
