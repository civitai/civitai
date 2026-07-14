import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeRaw, deleteFilesForModelVersionCache } = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $executeRaw: executeRaw },
}));
vi.mock('~/server/services/model-file.service', () => ({ deleteFilesForModelVersionCache }));

import { persistModelWeightPrecision } from '~/server/services/tensor-metadata-persistence.service';

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
  deleteFilesForModelVersionCache.mockResolvedValue(undefined);
});

describe('persistModelWeightPrecision', () => {
  it('skips empty or already-current precision values', async () => {
    await expect(
      persistModelWeightPrecision({
        fileId: 42,
        fileUrl: 'https://example.com/model.gguf',
        modelVersionId: 7,
        currentWeightPrecision: 'Q4',
        weightPrecision: 'Q4',
      })
    ).resolves.toBe(false);

    expect(executeRaw).not.toHaveBeenCalled();
    expect(deleteFilesForModelVersionCache).not.toHaveBeenCalled();
  });

  it('atomically merges precision for the current file content and busts the file cache', async () => {
    await expect(
      persistModelWeightPrecision({
        fileId: 42,
        fileUrl: 'https://example.com/model.gguf',
        modelVersionId: 7,
        currentWeightPrecision: null,
        weightPrecision: 'Q4',
      })
    ).resolves.toBe(true);

    const query = executeRaw.mock.calls[0][0];
    expect(query.sql).toContain('jsonb_build_object');
    expect(query.sql).toContain('"url" =');
    expect(query.values).toEqual(
      expect.arrayContaining(['Q4', 42, 'https://example.com/model.gguf'])
    );
    expect(deleteFilesForModelVersionCache).toHaveBeenCalledWith(7);
  });

  it('busts stale model-file cache data when another request won the database write', async () => {
    executeRaw.mockResolvedValue(0);

    await expect(
      persistModelWeightPrecision({
        fileId: 42,
        fileUrl: 'https://example.com/model.safetensors',
        modelVersionId: 7,
        weightPrecision: 'BF16',
      })
    ).resolves.toBe(false);

    expect(deleteFilesForModelVersionCache).toHaveBeenCalledWith(7);
  });
});
