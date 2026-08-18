import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A 3D-model review is user-authored text on someone else's model, the same shape as a resource
 * review — but it called no block guard on either branch, so a blocked user could review, and keep
 * editing a review of, a model whose owner had blocked them. Comment threads hanging off such a
 * review were already guarded, which made the surface look covered.
 */

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));

import { upsertModel3DReview } from '../model3d-review.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const OWNER = 100;
const REVIEWER = 7;
const MODEL_3D_ID = 3;
const REVIEW_ID = 5;

const user = ({ isModerator = false } = {}) =>
  ({ id: REVIEWER, isModerator } as unknown as Parameters<typeof upsertModel3DReview>[0]['user']);

const input = { model3dId: MODEL_3D_ID, recommended: true, details: null } as Parameters<
  typeof upsertModel3DReview
>[0]['input'];

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
  // Published model owned by OWNER. `status` matches the published check the service makes.
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({
    id: MODEL_3D_ID,
    userId: OWNER,
    status: 'Published',
    deletedAt: null,
  });
  dbMock.dbRead.model3DReview.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.model3DReview.findUnique.mockResolvedValue({
    id: REVIEW_ID,
    userId: REVIEWER,
    model3dId: MODEL_3D_ID,
  });
  dbMock.dbWrite.model3DReview.create.mockResolvedValue({ id: REVIEW_ID });
  dbMock.dbWrite.model3DReview.update.mockResolvedValue({ id: REVIEW_ID });
});

describe('upsertModel3DReview — block enforcement', () => {
  it('refuses a new review when the 3D model owner blocks the reviewer', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(upsertModel3DReview({ input, user: user() })).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: REVIEWER, targetUserId: OWNER });
    expect(dbMock.dbWrite.model3DReview.create).not.toHaveBeenCalled();
  });

  it('writes the review when nobody blocks', async () => {
    await expect(upsertModel3DReview({ input, user: user() })).resolves.toBeDefined();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: REVIEWER, targetUserId: OWNER });
    expect(dbMock.dbWrite.model3DReview.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an edit of a review written before the block', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(
      upsertModel3DReview({ input: { ...input, id: REVIEW_ID }, user: user() })
    ).rejects.toThrow();
    expect(dbMock.dbWrite.model3DReview.update).not.toHaveBeenCalled();
  });

  it('lets a non-blocked author edit', async () => {
    await expect(
      upsertModel3DReview({ input: { ...input, id: REVIEW_ID }, user: user() })
    ).resolves.toBeDefined();
    expect(dbMock.dbWrite.model3DReview.update).toHaveBeenCalledTimes(1);
  });

  it('exempts moderators', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(
      upsertModel3DReview({ input, user: user({ isModerator: true }) })
    ).resolves.toBeDefined();
    expect(amIBlockedByUser).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model3DReview.create).toHaveBeenCalledTimes(1);
  });
});
