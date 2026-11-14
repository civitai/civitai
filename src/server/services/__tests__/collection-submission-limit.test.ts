import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { withCollectionSubmissionLimits } from '../collection-submission-limit';

type Row = { collectionId: number; addedById: number; imageId: number; status: string };
let rows: Row[];
const collectionId = 10;
const userId = 7;
const collections = [{ id: collectionId, metadata: { maxItemsPerUser: 2 } }];
const item = (imageId: number, status = 'REVIEW'): Row => ({
  collectionId,
  addedById: userId,
  imageId,
  status,
});

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  dbMock.dbWrite.collectionItem.findMany.mockImplementation(
    async ({ where }: { where: { collectionId: number; OR: { imageId: number }[] } }) =>
      rows.filter(
        (r) =>
          r.collectionId === where.collectionId && where.OR.some((q) => q.imageId === r.imageId)
      )
  );
  dbMock.dbWrite.collectionItem.count.mockImplementation(
    async ({
      where,
    }: {
      where: { collectionId?: number; addedById?: number; status?: { in: string[] } };
    }) =>
      rows.filter(
        (r) =>
          (where.collectionId === undefined || r.collectionId === where.collectionId) &&
          (where.addedById === undefined || r.addedById === where.addedById) &&
          (!where.status || where.status.in.includes(r.status))
      ).length
  );
});

async function submit(ids: number[], isModerator = false) {
  const items = ids.map((id) => ({ ...item(id), status: 'REVIEW' as const }));
  return withCollectionSubmissionLimits({ collections, items, userId, isModerator }, async () => {
    for (const entry of items)
      if (!rows.some((r) => r.collectionId === entry.collectionId && r.imageId === entry.imageId))
        rows.push(entry);
    return 'saved';
  });
}

describe('normal collection submission limit', () => {
  it('allows two entries and refuses the third', async () => {
    await expect(submit([1, 2])).resolves.toBe('saved');
    await expect(submit([3])).rejects.toThrow('maximum number');
    expect(rows.map((r) => r.imageId)).toEqual([1, 2]);
  });

  it('counts approved and pending entries together', async () => {
    rows = [item(1, 'ACCEPTED'), item(2, 'REVIEW')];
    await expect(submit([3])).rejects.toThrow('maximum number');
  });

  it('does not charge a slot for a rejected entry or another user or collection', async () => {
    rows = [item(1, 'REJECTED'), { ...item(2), addedById: 99 }, { ...item(3), collectionId: 99 }];
    await expect(submit([4, 5])).resolves.toBe('saved');
  });

  it('allows saving an existing entry at capacity', async () => {
    rows = [item(1), item(2)];
    await expect(submit([1])).resolves.toBe('saved');
  });

  it('keeps the moderator exemption', async () => {
    rows = [item(1), item(2)];
    await expect(submit([3], true)).resolves.toBe('saved');
  });
});
