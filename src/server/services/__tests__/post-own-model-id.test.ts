import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getOwnModelId } from '~/server/services/post.service';

type Db = NonNullable<Parameters<typeof getOwnModelId>[0]['db']>;
const dbWith = (model: { id: number; userId: number } | null) => {
  const findUnique = vi.fn(async () => (model ? { model } : null));
  return { db: { modelVersion: { findUnique } } as unknown as Db, findUnique };
};

describe('getOwnModelId', () => {
  it("is the post's model when the post's owner owns it", async () => {
    const { db, findUnique } = dbWith({ id: 99, userId: 7 });
    expect(await getOwnModelId({ modelVersionId: 5, postOwnerId: 7, db })).toBe(99);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { model: { select: { id: true, userId: true } } },
    });
  });

  it("is null for a review post on someone else's model", async () => {
    const { db } = dbWith({ id: 99, userId: 8 });
    expect(await getOwnModelId({ modelVersionId: 5, postOwnerId: 7, db })).toBeNull();
  });

  it('reads the client it is given, and the replica when it is given none', async () => {
    // createPost passes dbWrite so a post just created is found before the replica catches up.
    vi.mocked(dbMock.dbRead.modelVersion.findUnique).mockResolvedValue({
      model: { id: 1, userId: 7 },
    } as never);
    vi.mocked(dbMock.dbWrite.modelVersion.findUnique).mockResolvedValue({
      model: { id: 2, userId: 7 },
    } as never);

    expect(await getOwnModelId({ modelVersionId: 5, postOwnerId: 7 })).toBe(1);
    expect(
      await getOwnModelId({ modelVersionId: 5, postOwnerId: 7, db: dbMock.dbWrite as never })
    ).toBe(2);
  });

  it('is null, asking nothing, for a post without a version, and for a missing version', async () => {
    const none = dbWith(null);
    expect(await getOwnModelId({ modelVersionId: null, postOwnerId: 7, db: none.db })).toBeNull();
    expect(none.findUnique).not.toHaveBeenCalled();
    expect(await getOwnModelId({ modelVersionId: 5, postOwnerId: 7, db: none.db })).toBeNull();
  });
});
