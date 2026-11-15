import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn(async () => []) }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { addModelVersionToVault } from '~/server/services/vault.service';

describe('addModelVersionToVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.user.findUnique.mockResolvedValue({ filePreferences: {} } as never);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { userId: 7, storageKb: 1_000_000, usedStorageKb: 0, updatedAt: new Date() },
    ] as never);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      id: 9,
      name: 'v1',
      status: 'Published',
      usageControl: 'Download',
      baseModel: 'SDXL 1.0',
      modelId: 3,
      createdAt: new Date(),
      model: {
        name: 'm',
        type: 'Checkpoint',
        userId: 5,
        user: { id: 5, username: 'u' },
        tagsOnModels: [],
      },
      files: [
        {
          id: 1,
          type: 'Model',
          url: 'files/model.safetensors',
          name: 'model.safetensors',
          sizeKB: 10,
          metadata: {},
          pickleScanResult: 'Success',
          virusScanResult: 'Danger',
          hashes: [],
        },
      ],
    } as never);
    dbMock.dbWrite.vaultItem.create.mockImplementation((async (args: unknown) => args) as never);
  });

  it('stores each file with its scan verdict', async () => {
    await addModelVersionToVault({ userId: 7, modelVersionId: 9 });
    const { data } = dbMock.dbWrite.vaultItem.create.mock.calls[0][0] as {
      data: { files: Record<string, unknown>[] };
    };
    expect(data.files).toEqual([
      expect.objectContaining({ id: 1, pickleScanResult: 'Success', virusScanResult: 'Danger' }),
    ]);
  });
});
