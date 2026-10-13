import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PostService from '~/server/services/post.service';
import { dbMock, loggingMock } from '~/__tests__/mocks';

const refundMultiAccountTransaction = vi.fn();
const afterPostsPublish = vi.fn();

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
}));

const { withdrawCrucibleEntry } = await import('~/server/services/crucible.service');

const ENTRANT = 42;
const withdraw = (userId = ENTRANT) => withdrawCrucibleEntry({ entryId: 5, userId });

const findEntry = dbMock.dbWrite.crucibleEntry.findUnique;
// Its own client, so a statement that should run inside the transaction can't pass outside it.
const tx = { $queryRaw: vi.fn(), crucibleEntry: { updateMany: vi.fn() } };
const lockCrucible = tx.$queryRaw;
const updateEntries = tx.crucibleEntry.updateMany;

const lockSql = () => {
  const [strings] = lockCrucible.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return strings.join('?').replace(/\s+/g, ' ').trim();
};

beforeEach(() => {
  vi.clearAllMocks();
  findEntry.mockResolvedValue({ crucibleId: 7, userId: ENTRANT, imageId: 70 });
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  lockCrucible.mockResolvedValue([{ id: 7 }]);
  updateEntries.mockResolvedValue({ count: 1 });
  afterPostsPublish.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 300, userId: ENTRANT }]);
});

describe('withdrawCrucibleEntry', () => {
  it('detaches the image under the crucible row lock, keeping the row and its fee', async () => {
    const result = await withdraw();

    expect(lockSql()).toBe(
      'SELECT id FROM "Crucible" WHERE id = ? AND status = ?::"CrucibleStatus" AND ("endAt" IS NULL OR "endAt" > statement_timestamp()) FOR UPDATE'
    );
    expect(updateEntries).toHaveBeenCalledWith({
      where: { id: 5, userId: ENTRANT, imageId: { not: null } },
      data: { imageId: null },
    });
    expect(lockCrucible.mock.invocationCallOrder[0]).toBeLessThan(
      updateEntries.mock.invocationCallOrder[0]
    );
    expect(dbMock.dbWrite.crucibleEntry.delete).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({ entryId: 5, crucibleId: 7 });
    // The entry's hidden post is published now rather than at the crucible's end.
    const [, imageFilter] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [unknown, Prisma.Sql];
    expect(imageFilter.values).toEqual([70]);
    expect(afterPostsPublish).toHaveBeenCalledWith([{ postId: 300, userId: ENTRANT }]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-withdrawn', entryId: 5, imageId: 70 })
    );
  });

  it("refuses someone else's entry as not found", async () => {
    await expect(withdraw(99)).rejects.toThrow('Entry not found');
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an entry that was already withdrawn', async () => {
    findEntry.mockResolvedValue({ crucibleId: 7, userId: ENTRANT, imageId: null });

    await expect(withdraw()).rejects.toThrow('Entry not found');
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses once the crucible is no longer running', async () => {
    lockCrucible.mockResolvedValue([]);

    await expect(withdraw()).rejects.toThrow(/only be removed while the crucible is running/);
    expect(updateEntries).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports not found when a concurrent withdraw got there first', async () => {
    updateEntries.mockResolvedValue({ count: 0 });

    await expect(withdraw()).rejects.toThrow('Entry not found');
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-withdrawn' })
    );
  });
});
