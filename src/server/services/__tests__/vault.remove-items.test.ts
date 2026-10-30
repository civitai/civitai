import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

const { mockDeleteManyObjects } = vi.hoisted(() => ({ mockDeleteManyObjects: vi.fn() }));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  deleteManyObjects: mockDeleteManyObjects,
  getS3Client: () => ({}),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { removeModelVersionsFromVault } from '~/server/services/vault.service';

describe('removeModelVersionsFromVault', () => {
  beforeEach(() => {
    setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
    mockDeleteManyObjects.mockReset();
    dbMock.dbWrite.vaultItem.deleteMany.mockReset().mockResolvedValue({ count: 1 } as any);
  });

  it('reports an error, and removes only the items whose objects deleted, when some fail', async () => {
    mockDeleteManyObjects.mockResolvedValueOnce({
      Errors: [{ Key: '2/7/images.zip', Code: 'InternalError' }],
    });

    await expect(
      removeModelVersionsFromVault({ userId: 7, modelVersionIds: [1, 2] })
    ).rejects.toThrow('Some items could not be removed from your Vault');

    expect(dbMock.dbWrite.vaultItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.vaultItem.deleteMany).toHaveBeenCalledWith({
      where: { vaultId: 7, modelVersionId: { in: [1] } },
    });
  });

  it('resolves when every item is removed', async () => {
    mockDeleteManyObjects.mockResolvedValueOnce({ Errors: [] });

    await expect(
      removeModelVersionsFromVault({ userId: 7, modelVersionIds: [1, 2] })
    ).resolves.toBeUndefined();
  });
});
