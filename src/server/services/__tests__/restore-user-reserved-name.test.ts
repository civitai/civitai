import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AccountDeletionImages from '~/server/services/account-deletion-images';
import type * as HatSync from '~/server/events/points/sync';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

/**
 * Restoring a closed account cannot hand it the shared moderation account's reserved username,
 * and cannot restore a banned account at all.
 */

vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  reopenGenerationRestrictionsOfRestoredAccount: vi.fn(async () => 0),
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
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: vi.fn(),
}));

import { restoreUser } from '~/server/services/user.service';

const USER_ID = 7;
const LOOKALIKES = [
  'Civ1taiModeration',
  'Civitai_Moderation',
  'CivitaiModerat\u0456on',
  'Civitai\u200bModeration',
];

const restore = (username: string) =>
  restoreUser({ id: USER_ID, username, email: 'back@x.com', restoreModels: false });

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ CIVITAI_MODERATION_USER_ID: '' });
  dbMock.dbWrite.user.findFirst.mockImplementation(async ({ where }: { where: { id?: number } }) =>
    where.id === USER_ID
      ? { id: USER_ID, deletedAt: new Date('2026-07-28T00:00:00Z'), meta: {} }
      : null
  );
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
});

describe('restoreUser and the reserved username', () => {
  it.each(['CivitaiModeration', 'civitaimoderation'])(
    'refuses restoring another account as %s',
    async (username) => {
      await expect(restore(username)).rejects.toThrow(/reserved/);
      expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(LOOKALIKES)('refuses restoring another account as the lookalike %j', async (username) => {
    await expect(restore(username)).rejects.toThrow(/reserved/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses restoring the shared account under a lookalike of its name', async () => {
    setEnv({ CIVITAI_MODERATION_USER_ID: USER_ID });
    await expect(restore(LOOKALIKES[0])).rejects.toThrow(/keeps its reserved username/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses restoring the shared account under another name', async () => {
    setEnv({ CIVITAI_MODERATION_USER_ID: USER_ID });
    await expect(restore('back')).rejects.toThrow(/keeps its reserved username/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('restores the shared account itself under its name, and other accounts under other names', async () => {
    await expect(restore('back')).resolves.toEqual(expect.objectContaining({ id: USER_ID }));
    setEnv({ CIVITAI_MODERATION_USER_ID: USER_ID });
    await expect(restore('CivitaiModeration')).resolves.toEqual(
      expect.objectContaining({ id: USER_ID })
    );
  });
});

describe('restoreUser and a banned account', () => {
  const DELETED_AT = new Date('2026-07-28T00:00:00Z');
  const deleted = (bannedAt: Date | null) =>
    dbMock.dbWrite.user.findFirst.mockImplementation(
      async ({ where, select }: { where: { id?: number }; select?: Record<string, boolean> }) =>
        where.id === USER_ID
          ? {
              id: USER_ID,
              deletedAt: DELETED_AT,
              meta: {},
              // Only what the read selects, so a read that stops selecting the ban cannot see it.
              ...(select?.bannedAt ? { bannedAt } : {}),
            }
          : null
    );
  const landsFirst = () =>
    dbMock.dbWrite.user.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('No record found', {
        code: 'P2025',
        clientVersion: 'test',
      })
    );
  const guardedWrite = expect.objectContaining({
    where: expect.objectContaining({ id: USER_ID, deletedAt: DELETED_AT, bannedAt: null }),
  });

  it('refuses a banned account and leaves its images hidden', async () => {
    deleted(new Date('2026-07-27T00:00:00Z'));
    await expect(restore('back')).rejects.toThrow(/is banned; unban the account/);
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses, in the purge-disarm transaction, when a ban lands before the write', async () => {
    deleted(null);
    landsFirst();
    await expect(restore('back')).rejects.toThrow(/banned, restored or deleted again meanwhile/);
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledWith(guardedWrite);
    // The guarded write and the purge disarm commit or roll back together.
    expect(dbMock.dbWrite.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('refuses the model reclaim too, in the same transaction, when a ban lands first', async () => {
    deleted(null);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ id: 501 }]);
    landsFirst();
    await expect(
      restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: true })
    ).rejects.toThrow(/banned, restored or deleted again meanwhile/);
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledWith(guardedWrite);
    // One batch: the guarded write, the purge disarm, the reclaim and its ownership record.
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$transaction.mock.calls[0][0]).toHaveLength(4);
  });

  it('restores an account that is not banned', async () => {
    deleted(null);
    await expect(restore('back')).resolves.toEqual(expect.objectContaining({ id: USER_ID }));
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: null }) })
    );
  });
});
