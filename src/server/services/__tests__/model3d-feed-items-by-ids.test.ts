import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { SessionUser } from '~/types/session';

const { getModel3DFeedItemsByIds } = await import('~/server/services/model3d.service');

const r = dbMock.dbRead;

beforeEach(() => {
  r.model3D.findMany.mockReset().mockResolvedValue([
    { id: 1, userId: 5, tags: [{ tagId: 3 }, { tagId: 4 }] },
    { id: 2, userId: 6, tags: [] },
  ] as never);
  r.model3DReview.findMany
    .mockReset()
    .mockResolvedValue([{ id: 70, model3dId: 2, recommended: true }] as never);
});

describe('getModel3DFeedItemsByIds', () => {
  it('reads nothing for no ids', async () => {
    await expect(getModel3DFeedItemsByIds({ ids: [] })).resolves.toEqual([]);
    expect(r.model3D.findMany).not.toHaveBeenCalled();
  });

  it("returns the feed card: tags as ids, and the viewer's own recommend", async () => {
    const items = await getModel3DFeedItemsByIds({ ids: [1, 2], user: { id: 44 } as SessionUser });
    expect(r.model3D.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2] } } })
    );
    expect(r.model3DReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 44, model3dId: { in: [1, 2] } } })
    );
    expect(items).toEqual([
      { id: 1, userId: 5, tags: [3, 4], userReview: null },
      { id: 2, userId: 6, tags: [], userReview: { id: 70, recommended: true } },
    ]);
  });

  it('reads no reviews for a signed-out viewer', async () => {
    const items = await getModel3DFeedItemsByIds({ ids: [1, 2] });
    expect(r.model3DReview.findMany).not.toHaveBeenCalled();
    expect(items.map((m) => m.userReview)).toEqual([null, null]);
  });
});
