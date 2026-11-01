import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A file's display name is shown to everyone who downloads it, so it is scanned when it changes.
// Only when it changes: the editor re-sends the stored name with every save. Scaffold mirrors
// model-file.update-scope.test.ts.

const { throwOnBlockedUserContent } = vi.hoisted(() => ({
  // Stands in for the blocklist: refuses any string containing BLOCKED.
  throwOnBlockedUserContent: vi.fn(async (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === 'string' && v.includes('BLOCKED')))
      throw new Error('blocked');
  }),
}));

vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent }));
vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  createCachedObject: () => ({ bust: vi.fn(), fetch: vi.fn() }),
}));

import { createFile, updateFile } from '~/server/services/model-file.service';

const STORED_NAME = 'stored BLOCKED name';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({
    id: 1,
    name: 'a.safetensors',
    overrideName: STORED_NAME,
    url: 'https://example.test/a.safetensors',
    type: 'Model',
    visibility: 'Public',
    metadata: {},
    modelVersionId: 10,
    sizeKB: 1,
    modelVersion: {
      modelId: 5,
      baseModel: 'SDXL 1.0',
      status: 'Draft',
      trainingStatus: null,
      uploadType: 'Created',
      model: { type: 'LORA', userId: 7 },
    },
  });
  dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });
});

const save = (overrideName: string | null | undefined) =>
  updateFile({ id: 1, userId: 7, overrideName } as never);

describe('updateFile — the display name', () => {
  it('saves when the stored name is re-sent unchanged, even one that would be refused', async () => {
    await expect(save(STORED_NAME)).resolves.toBeDefined();
    expect(dbMock.dbWrite.modelFile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed name the blocklist refuses, before writing', async () => {
    await expect(save('new BLOCKED name')).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });

  it('saves a changed name the blocklist accepts', async () => {
    await expect(save('clean name')).resolves.toBeDefined();
    expect(throwOnBlockedUserContent).toHaveBeenCalledWith(['clean name'], expect.anything());
  });
});

describe('createFile — the display name', () => {
  it('refuses a new file whose name the blocklist refuses', async () => {
    await expect(
      createFile({
        select: { id: true },
        userId: 7,
        modelVersionId: 10,
        name: 'a.safetensors',
        url: 'https://example.test/a.safetensors',
        type: 'Model',
        sizeKB: 1,
        overrideName: 'BLOCKED',
      } as never)
    ).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
  });
});

describe('the uploaded file name, published as the download name for some model types', () => {
  it('refuses a changed upload name the blocklist refuses', async () => {
    await expect(
      updateFile({ id: 1, userId: 7, name: 'BLOCKED.safetensors' } as never)
    ).rejects.toThrow('blocked');
  });

  it('does not rescan the stored upload name', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValueOnce({
      ...(await dbMock.dbWrite.modelFile.findUnique()),
      name: 'stored BLOCKED.safetensors',
    });
    await expect(
      updateFile({ id: 1, userId: 7, name: 'stored BLOCKED.safetensors' } as never)
    ).resolves.toBeDefined();
  });

  it('refuses a new file whose upload name the blocklist refuses', async () => {
    await expect(
      createFile({
        select: { id: true },
        userId: 7,
        modelVersionId: 10,
        name: 'BLOCKED.safetensors',
        url: 'https://example.test/a.safetensors',
        type: 'Model',
        sizeKB: 1,
      } as never)
    ).rejects.toThrow('blocked');
  });
});
