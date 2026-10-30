import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PostService from '~/server/services/post.service';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { dbMock, loggingMock } from '~/__tests__/mocks';
import { CRUCIBLE_OWNER_REMOVAL_CAP } from '~/utils/crucible-helpers';

const refundMultiAccountTransaction = vi.fn();
const getMultiAccountTransactionsByPrefix = vi.fn();
const getTransactionByExternalId = vi.fn();
const refundTransaction = vi.fn();
const createNotification = vi.fn();
const afterPostsPublish = vi.fn();

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
  refundTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const { removeCrucibleEntry, removeCrucibleEntryAsOwner } = await import(
  '~/server/services/crucible.service'
);

const MODERATOR = 3;
const OWNER = 9;
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
    userId: OWNER,
    ownerRemovalCount: 0,
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

const REFUNDED = { refundedTransactions: [{ amount: 50 }], totalRefunded: 1 };

/** One leg per prefix, already refunded: a 409 then reads as settled. */
function legsAlreadyRefunded() {
  getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) => [
    { transactionId: `${prefix}-leg`, externalTransactionId: `${prefix}-User`, amount: 50 },
  ]);
  getTransactionByExternalId.mockResolvedValue({ type: 'Refund' });
  refundTransaction.mockResolvedValue({ transactionId: 'refunded' });
}

beforeEach(() => {
  vi.clearAllMocks();
  findEntry.mockResolvedValue(entry());
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  deleteEntry.mockResolvedValue({});
  refundMultiAccountTransaction.mockResolvedValue(REFUNDED);
  legsAlreadyRefunded();
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

describe('removeCrucibleEntryAsOwner', () => {
  const removeAsOwner = (overrides: Record<string, unknown> = {}) =>
    removeCrucibleEntryAsOwner({
      entryId: 5,
      ownerId: OWNER,
      reason: 'off-topic',
      ...overrides,
    });
  const reserve = dbMock.dbWrite.$executeRaw;
  const sqlOf = (call: unknown[]) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join('?').replace(/\s+/g, ' ').trim(), values };
  };
  const capMessage = new RegExp(`${CRUCIBLE_OWNER_REMOVAL_CAP} entries`);

  it('takes a cap slot before the refund, and tells the entrant why', async () => {
    const result = await removeAsOwner();

    const { sql, values } = sqlOf(reserve.mock.calls[0]);
    expect(sql).toContain('"ownerRemovalCount" = "ownerRemovalCount" + 1');
    expect(sql).toContain('"ownerRemovalCount" < ?');
    expect(values).toContain(CRUCIBLE_OWNER_REMOVAL_CAP);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      refundMultiAccountTransaction.mock.invocationCallOrder[0]
    );
    expect(runningCheck().sql).not.toContain('ownerRemovalCount');
    expect(deleteEntry).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(notice()).toMatchObject({
      userId: 42,
      type: 'crucible-entry-removed',
      details: {
        refundedAmount: 50,
        removedBy: 'owner',
        reason: 'Off-topic for this crucible',
      },
    });
    expect(result).toEqual({ entryId: 5, crucibleId: 7, refundedAmount: 50 });
  });

  it('still allows the last removal under the cap', async () => {
    findEntry.mockResolvedValue(entry({}, { ownerRemovalCount: CRUCIBLE_OWNER_REMOVAL_CAP - 1 }));

    await expect(removeAsOwner()).resolves.toMatchObject({ entryId: 5 });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('gives the owner\'s own words to the entrant for "other"', async () => {
    await removeAsOwner({ reason: 'other', note: 'Not a Neon-style piece' });

    expect(notice().details.reason).toBe('Not a Neon-style piece');
  });

  it.each([
    ['missing', undefined],
    ['empty markup', '<b></b>'],
    ['blank', '   '],
  ])('rejects "other" with a %s note before any money moves', async (_, note) => {
    await expect(removeAsOwner({ reason: 'other', note })).rejects.toThrow(/reason/i);

    expect(reserve).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('strips markup from the note the entrant sees', async () => {
    await removeAsOwner({ reason: 'other', note: '<b>spam</b> <script>x()</script>' });

    expect(notice().details.reason).not.toMatch(/</);
  });

  it('refuses anyone but the crucible owner, before any money moves', async () => {
    await expect(removeAsOwner({ ownerId: 77 })).rejects.toThrow(/your own crucible/);

    expect(reserve).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("refuses the owner's own entry", async () => {
    findEntry.mockResolvedValue(entry({ userId: OWNER }));

    await expect(removeAsOwner()).rejects.toThrow("You can't remove your own entry");
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('turns a removal away when no slot is left, without refunding, deleting or notifying', async () => {
    reserve.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ capped: true }]);

    await expect(removeAsOwner()).rejects.toThrow(capMessage);

    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('reports an ended crucible, not the cap, when it ended before the slot was taken', async () => {
    reserve.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ capped: false }]);

    await expect(removeAsOwner()).rejects.toThrow(/only be removed while/);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('gives the slot back when the refund fails', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(removeAsOwner()).rejects.toThrow(/entry was kept/);

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(sqlOf(reserve.mock.calls[1]).sql).toContain('GREATEST("ownerRemovalCount" - 1, 0)');
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('gives the slot back when the crucible ends after it was taken', async () => {
    executeRaw.mockResolvedValue(0);

    await expect(removeAsOwner()).rejects.toThrow(/only be removed while/);

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(sqlOf(reserve.mock.calls[1]).sql).toContain('GREATEST("ownerRemovalCount" - 1, 0)');
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-removal-raced-end' })
    );
  });

  it('gives the slot back when another removal already took the entry', async () => {
    deleteEntry.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
        code: 'P2025',
        clientVersion: 'test',
      })
    );

    await expect(removeAsOwner()).rejects.toThrow('Entry not found');
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('logs a slot it could not give back instead of hiding the original error', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));
    reserve.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('db down'));

    await expect(removeAsOwner()).rejects.toThrow(/entry was kept/);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-removal-slot-release-failed' })
    );
  });

  it('never touches the owner cap for a moderator removal, even in their own crucible', async () => {
    findEntry.mockResolvedValue(
      entry({}, { userId: MODERATOR, ownerRemovalCount: CRUCIBLE_OWNER_REMOVAL_CAP })
    );

    await remove();

    expect(reserve).not.toHaveBeenCalled();
    expect(runningCheck().sql).not.toContain('ownerRemovalCount');
    expect(notice().details).not.toHaveProperty('reason');
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
