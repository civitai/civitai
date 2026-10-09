import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as AccountDeletionImages from '~/server/services/account-deletion-images';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

const { reopenRestrictions } = vi.hoisted(() => ({ reopenRestrictions: vi.fn() }));

vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  reopenGenerationRestrictionsOfRestoredAccount: reopenRestrictions,
}));
vi.mock('~/server/services/account-deletion-images', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountDeletionImages>()),
  disarmAccountDeletionImagePurge: vi.fn(() => 'disarm-statement'),
  recordPendingImageRestore: vi.fn(async () => true),
  countPendingAccountDeletionImageRestores: vi.fn(async () => 0),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  userBasicCache: { refresh: vi.fn(async () => undefined) },
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));

import { restoreUser } from '~/server/services/user.service';

const USER_ID = 7;

const restore = () =>
  restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: false });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findFirst.mockImplementation(async ({ where }: { where: { id?: number } }) =>
    where.id === USER_ID
      ? { id: USER_ID, deletedAt: new Date('2026-07-28T00:00:00Z'), meta: {} }
      : null
  );
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  reopenRestrictions.mockResolvedValue(1);
});

describe('restoreUser — restrictions closed by the deletion', () => {
  // The mute survives deletion, so a restored account with its case still closed stays muted with
  // nothing in the queue to lift it.
  it('reopens them once the account is restored', async () => {
    await restore();

    expect(reopenRestrictions).toHaveBeenCalledWith(USER_ID);
    expect(reopenRestrictions.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });

  it('a failing reopen is logged and the restore still succeeds', async () => {
    reopenRestrictions.mockRejectedValue(new Error('db down'));

    await expect(restore()).resolves.toEqual(expect.objectContaining({ id: USER_ID }));

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reopen-pending-restrictions',
        source: 'restoreUser',
        userId: USER_ID,
        message: 'db down',
      })
    );
  });
});
