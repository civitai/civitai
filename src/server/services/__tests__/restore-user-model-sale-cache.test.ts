import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as AccountDeletionImages from '~/server/services/account-deletion-images';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

const { bustForModels, auditRows } = vi.hoisted(() => ({
  bustForModels: vi.fn(),
  auditRows: vi.fn(),
}));

vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  bustModelSaleCacheForModels: bustForModels,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: auditRows } }));
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

import { restoreUser } from '~/server/services/user.service';

const USER_ID = 7;
// The audit names three models; only two are still orphaned, so only those two are restored.
const AUDITED = [31, 52, 83];
const ORPHANED = [31, 83];

const restore = () =>
  restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: true });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findFirst.mockImplementation(async ({ where }: { where: { id?: number } }) =>
    where.id === USER_ID
      ? { id: USER_ID, deletedAt: new Date('2026-07-28T00:00:00Z'), meta: {} }
      : null
  );
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  auditRows.mockResolvedValue(AUDITED.map((modelId) => ({ modelId })));
  dbMock.dbWrite.model.findMany.mockResolvedValue(ORPHANED.map((id) => ({ id })));
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: ORPHANED.length });
  bustForModels.mockResolvedValue(undefined);
});

describe('restoreUser -> model sale badge cache', () => {
  // While the models sat at userId -1 their sales did not count, so the badge cache holds a
  // "no sale" marker for each of them.
  it('busts the restored models after the restore commits', async () => {
    await expect(restore()).resolves.toMatchObject({ modelIds: ORPHANED });

    expect(bustForModels.mock.calls).toEqual([[ORPHANED]]);
    expect(bustForModels.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });

  it('a failing bust is logged and the restore still succeeds', async () => {
    bustForModels.mockRejectedValue(new Error('redis down'));

    await expect(restore()).resolves.toMatchObject({ id: USER_ID, modelIds: ORPHANED });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'restore-user-model-sale-cache',
        source: 'restoreUser',
        userId: USER_ID,
        message: 'redis down',
      })
    );
  });
});
