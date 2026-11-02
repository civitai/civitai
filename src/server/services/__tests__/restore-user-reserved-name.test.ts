import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AccountDeletionImages from '~/server/services/account-deletion-images';
import type * as HatSync from '~/server/events/points/sync';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

/** Restoring a closed account cannot hand it the shared moderation account's reserved username. */

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
