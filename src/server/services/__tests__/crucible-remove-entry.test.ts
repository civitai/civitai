import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PostService from '~/server/services/post.service';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { dbMock, loggingMock } from '~/__tests__/mocks';

const refundMultiAccountTransaction = vi.fn();
const createNotification = vi.fn();
const afterPostsPublish = vi.fn();

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const { removeCrucibleEntry } = await import('~/server/services/crucible.service');

const MODERATOR = 3;
const remove = () => removeCrucibleEntry({ entryId: 5, moderatorId: MODERATOR });

const findEntry = dbMock.dbWrite.crucibleEntry.findUnique;
// Its own client, so a statement that should run inside the transaction can't pass outside it.
const tx = { $executeRaw: vi.fn(), crucibleEntry: { delete: vi.fn() } };
const executeRaw = tx.$executeRaw;
const deleteEntry = tx.crucibleEntry.delete;

const entry = (
  overrides: Record<string, unknown> = {},
  crucible: Record<string, unknown> = {}
) => ({
  crucibleId: 7,
  userId: 42,
  imageId: 70,
  buzzTransactionId: 'crucible-entry-7-42-abc',
  crucible: {
    status: CrucibleStatus.Active,
    endAt: new Date(Date.now() + 60 * 60_000),
    entryFee: 50,
    name: 'Neon',
    ingestion: CrucibleIngestionStatus.Scanned,
    textNsfw: false,
    ...crucible,
  },
  ...overrides,
});

const runningCheck = () => {
  const [strings, ...values] = executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?').replace(/\s+/g, ' ').trim(), values };
};
const notice = () => createNotification.mock.calls[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  findEntry.mockResolvedValue(entry());
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  executeRaw.mockResolvedValue(1);
  deleteEntry.mockResolvedValue({});
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  createNotification.mockResolvedValue(undefined);
  afterPostsPublish.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

describe('removeCrucibleEntry', () => {
  it('refunds the fee first, then takes it out of the stored pool and deletes the entry under the crucible row lock', async () => {
    const result = await remove();

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'crucible-entry-7-42-abc',
        description: 'Crucible entry fee refund - entry removed: Neon',
      })
    );
    expect(runningCheck().sql).toBe(
      'UPDATE "Crucible" SET "prizePool" = "prizePool" - ? WHERE id = ? AND status = ?::"CrucibleStatus" AND ("endAt" IS NULL OR "endAt" > statement_timestamp())'
    );
    expect(runningCheck().values.slice(0, 2)).toEqual([50, 7]);
    expect(deleteEntry).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(refundMultiAccountTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0]
    );
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      deleteEntry.mock.invocationCallOrder[0]
    );
    expect(result).toEqual({ entryId: 5, crucibleId: 7, refundedAmount: 50 });
  });

  it('tells the entrant, and records which moderator did it', async () => {
    await remove();

    expect(notice()).toMatchObject({
      userId: 42,
      type: 'crucible-entry-removed',
      key: 'crucible-entry-removed:5',
      details: { crucibleId: 7, crucibleName: 'Neon', refundedAmount: 50 },
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'crucible-entry-removed',
        entryId: 5,
        moderatorId: MODERATOR,
      })
    );
  });

  it('keeps the entry, so the moderator can try again, when the refund fails', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(remove()).rejects.toThrow(/couldn't be refunded, so the entry was kept/);

    expect(executeRaw).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.crucibleEntry.delete).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.crucibleEntry.deleteMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-entry-removal-refund-failed',
        entryId: 5,
        moderatorId: MODERATOR,
      })
    );
  });

  it('finishes a removal whose refund an earlier attempt already made', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'duplicate'));

    await expect(remove()).resolves.toMatchObject({ refundedAmount: 50 });
    expect(deleteEntry).toHaveBeenCalled();
  });

  it('refunds nothing for a free entry, and leaves the pool alone', async () => {
    findEntry.mockResolvedValue(entry({ buzzTransactionId: null }));

    const result = await remove();

    expect(runningCheck().values[0]).toBe(0);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(result.refundedAmount).toBe(0);
  });

  it.each([
    ['completed', { status: CrucibleStatus.Completed }],
    ['past its end', { endAt: new Date(Date.now() - 1000) }],
  ])('refuses a crucible that is %s before any money moves', async (_, crucible) => {
    findEntry.mockResolvedValue(entry({}, crucible));

    await expect(remove()).rejects.toThrow(/only be removed while/);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('logs a fee refunded for an entry the end then kept in the pool', async () => {
    executeRaw.mockResolvedValue(0);

    await expect(remove()).rejects.toThrow(/only be removed while/);
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-entry-removal-raced-end',
        entryId: 5,
      })
    );
  });

  it("refuses a moderator's own entry", async () => {
    findEntry.mockResolvedValue(entry({ userId: MODERATOR }));

    await expect(remove()).rejects.toThrow("You can't remove your own entry");
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('is not found for an entry that does not exist, or that another moderator just removed', async () => {
    findEntry.mockResolvedValueOnce(null);
    await expect(remove()).rejects.toThrow('Entry not found');

    deleteEntry.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
        code: 'P2025',
        clientVersion: 'test',
      })
    );
    await expect(remove()).rejects.toThrow('Entry not found');
  });

  it('leaves a name flagged as adult text out of the notice and the ledger', async () => {
    findEntry.mockResolvedValue(entry({}, { textNsfw: true }));

    await remove();

    expect(notice().details.crucibleName).toBeNull();
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Crucible entry fee refund - entry removed' })
    );
  });
});

describe('removeCrucibleEntry — entry post', () => {
  const revealQuery = () => {
    const call = dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]) =>
      (strings as string[]).join('').includes('entry_posts')
    );
    if (!call) return undefined;
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    const query = Prisma.sql(strings, ...values);
    return { sql: query.text, values: query.values };
  };

  it("publishes the removed entry's hidden post now, after the entry is gone", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 300, userId: 42 }]);

    await remove();

    const query = revealQuery();
    expect(query?.sql).toMatch(
      /UPDATE "Post" p SET "publishedAt" = now\(\)\s+FROM entry_posts e\s+WHERE p\.id = e\.id AND e\.hidden/
    );
    expect(query?.sql).toMatch(/i\.id = \$\d/);
    expect(query?.values).toEqual(expect.arrayContaining([70, 'crucibleEntryDraft']));
    expect(afterPostsPublish).toHaveBeenCalledTimes(1);
    expect(afterPostsPublish).toHaveBeenCalledWith([{ postId: 300, userId: 42 }]);
    const revealCall = dbMock.dbWrite.$queryRaw.mock.calls.findIndex(([strings]) =>
      (strings as string[]).join('').includes('entry_posts')
    );
    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[revealCall]).toBeGreaterThan(
      deleteEntry.mock.invocationCallOrder[0]
    );
  });

  it('reveals nothing when the entry was kept', async () => {
    executeRaw.mockResolvedValue(0);

    await expect(remove()).rejects.toThrow();
    expect(revealQuery()).toBeUndefined();
  });

  it('reveals nothing for an entry whose image was deleted', async () => {
    findEntry.mockResolvedValue(entry({ imageId: null }));

    await remove();

    expect(revealQuery()).toBeUndefined();
  });
});
