import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

const { getModel3DById } = await import('~/server/services/model3d.service');

const UPLOADER = 5;
const blockedImage = {
  id: 1,
  url: 'u',
  userId: UPLOADER,
  nsfwLevel: NsfwLevel.Blocked,
  modelRestricted: false,
};

const thumbnailFor = async (user: { id: number; isModerator?: boolean }) => {
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({
    id: 9,
    userId: UPLOADER,
    status: Model3DStatus.Published,
    deletedAt: null,
    thumbnailImage: blockedImage,
    sourceImage: blockedImage,
    tags: [],
  } as never);
  dbMock.dbRead.model3DReview.findUnique.mockResolvedValue(null as never);
  const model = await getModel3DById({ id: 9, user: user as never });
  return { thumbnail: model.thumbnailImage, source: model.sourceImage };
};

describe('getModel3DById images rated Blocked', () => {
  it('keeps them for a moderator', async () => {
    expect(await thumbnailFor({ id: 6, isModerator: true })).toEqual({
      thumbnail: blockedImage,
      source: blockedImage,
    });
  });

  it('withholds them from another signed-in user', async () => {
    expect(await thumbnailFor({ id: 6, isModerator: false })).toEqual({
      thumbnail: null,
      source: null,
    });
  });
});
