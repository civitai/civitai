import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

const { getModel3DById } = await import('~/server/services/model3d.service');

// Blocked-level images stay with their uploader (civitai/civitai#9809).
const UPLOADER = 5;
const blockedImage = (blockedFor: string | null) => ({
  id: 1,
  url: 'u',
  userId: UPLOADER,
  nsfwLevel: NsfwLevel.Blocked,
  modelRestricted: false,
  blockedFor,
});

const imagesFor = async (
  blockedFor: string | null,
  user: { id: number; isModerator?: boolean }
) => {
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({
    id: 9,
    userId: UPLOADER,
    status: Model3DStatus.Published,
    deletedAt: null,
    thumbnailImage: blockedImage(blockedFor),
    sourceImage: blockedImage(blockedFor),
    tags: [],
  } as never);
  dbMock.dbRead.model3DReview.findUnique.mockResolvedValue(null as never);
  const model = await getModel3DById({ id: 9, user: user as never });
  return { thumbnail: model.thumbnailImage, source: model.sourceImage };
};

const blocks = [BlockedReason.CSAM, BlockedReason.Moderated, null];

describe('getModel3DById images rated Blocked', () => {
  it.each(blocks)('are withheld from a moderator (blockedFor %s)', async (blockedFor) => {
    expect(await imagesFor(blockedFor, { id: 6, isModerator: true })).toEqual({
      thumbnail: null,
      source: null,
    });
  });

  it('are kept for their uploader', async () => {
    expect((await imagesFor(null, { id: UPLOADER })).thumbnail).toEqual(blockedImage(null));
  });
});
