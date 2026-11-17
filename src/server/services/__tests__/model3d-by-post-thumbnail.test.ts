import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

const { getModel3DByPostId } = await import('~/server/services/model3d.service');

const UPLOADER = 5;
const thumbnailFor = async (nsfwLevel: number, userId?: number) => {
  dbMock.dbRead.post.findUnique.mockResolvedValue({
    model3d: {
      id: 9,
      name: 'm',
      userId: UPLOADER,
      status: Model3DStatus.Published,
      deletedAt: null,
      thumbnailImage: {
        id: 1,
        url: 'u',
        name: null,
        userId: UPLOADER,
        nsfwLevel,
        modelRestricted: true,
      },
    },
  } as never);
  return (await getModel3DByPostId({ postId: 3, userId }))?.thumbnailImage ?? null;
};

describe("getModel3DByPostId's thumbnail restricted by its base model", () => {
  it('withholds a mature one from everyone but its uploader', async () => {
    expect(await thumbnailFor(4)).toBeNull();
    expect(await thumbnailFor(4, 6)).toBeNull();
    expect(await thumbnailFor(4, UPLOADER)).toEqual({ id: 1, url: 'u', name: null });
  });

  it('keeps a SFW one', async () => {
    expect(await thumbnailFor(1, 6)).toEqual({ id: 1, url: 'u', name: null });
  });
});
