import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelFileService from '~/server/services/model-file.service';

const { executeRaw, deleteFilesForModelVersionCache } = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbWrite: { $executeRaw: executeRaw } }));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  deleteFilesForModelVersionCache,
}));

import {
  applyModelFileHeaderCorrections,
  correctModelFileFromTensorHeader,
  getModelFileHeaderCorrections,
} from '~/server/services/model-file-header-correction.service';

const target = {
  fileId: 42,
  fileUrl: 'https://example.com/model.safetensors',
  modelVersionId: 7,
};

const bf16Counts = [{ dtype: 'BF16', count: 300, bytes: 4_000_000 }];

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
  deleteFilesForModelVersionCache.mockResolvedValue(undefined);
});

describe('getModelFileHeaderCorrections', () => {
  it('corrects a stored precision the header disagrees with', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        currentFp: 'fp16',
      })
    ).toEqual({ fp: 'bf16' });
  });

  it('proposes nothing when the stored precision already matches the header', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        currentFp: 'bf16',
      })
    ).toEqual({});
  });

  // 🔴 Deliberate, and the reason is in FP_CONSISTENT_WITH_HEADER: an F8 dtype is
  // equally fp8, fp8_scaled or fp8_mixed, so "header wins" would round every scaled
  // file down to plain fp8 on every read. Do not "fix" this to expect { fp: 'fp8' }.
  it('keeps a scaled fp8 value that an F8 header cannot contradict', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: [{ dtype: 'F8_E4M3FN', count: 300, bytes: 4_000_000 }],
        currentFp: 'fp8_scaled',
      })
    ).toEqual({});
  });

  it('still corrects a stored fp8_scaled when the header positively says mxfp8', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: [
          { dtype: 'F8_E4M3', count: 300, bytes: 4_000_000 },
          { dtype: 'F8_E8M0', count: 300, bytes: 125_000 },
        ],
        currentFp: 'fp8_scaled',
      })
    ).toEqual({ fp: 'mxfp8' });
  });

  it('corrects an fp16 record whose header is plain fp8', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: [{ dtype: 'F8_E4M3FN', count: 300, bytes: 4_000_000 }],
        currentFp: 'fp16',
      })
    ).toEqual({ fp: 'fp8' });
  });

  it('reads MXFP8 from its scale tensors rather than byte share', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: [
          { dtype: 'F8_E4M3', count: 300, bytes: 4_000_000 },
          { dtype: 'F8_E8M0', count: 300, bytes: 125_000 },
        ],
        currentFp: 'fp16',
      })
    ).toEqual({ fp: 'mxfp8' });
  });

  it('leaves type alone when the caller does not know the detected type', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        currentFp: 'bf16',
        currentFileType: 'Other',
        modelType: 'Checkpoint',
      })
    ).toEqual({});
  });

  it('corrects an unambiguous file type', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        detectedModelType: 'VAE',
        currentFp: 'bf16',
        currentFileType: 'Other',
        modelType: 'Checkpoint',
      })
    ).toEqual({ type: 'VAE' });
  });

  it('proposes nothing for a GGUF file', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'GGUF',
        dtypeCounts: [{ dtype: 'Q4_K', count: 300, bytes: 4_000_000 }],
        currentFp: 'fp16',
      })
    ).toEqual({});
  });
});

describe('applyModelFileHeaderCorrections', () => {
  it('does not touch the database or the cache when there is nothing to correct', async () => {
    await expect(applyModelFileHeaderCorrections({ ...target, corrections: {} })).resolves.toBe(
      false
    );

    expect(executeRaw).not.toHaveBeenCalled();
    expect(deleteFilesForModelVersionCache).not.toHaveBeenCalled();
  });

  it('merges precision into metadata under a url guard and busts the file cache', async () => {
    await expect(
      applyModelFileHeaderCorrections({ ...target, corrections: { fp: 'bf16' } })
    ).resolves.toBe(true);

    const query = executeRaw.mock.calls[0][0];
    expect(query.sql).toContain('"url" =');
    expect(query.sql).not.toContain('"type" =');
    expect(query.values).toEqual([JSON.stringify({ fp: 'bf16' }), target.fileId, target.fileUrl]);
    expect(deleteFilesForModelVersionCache).toHaveBeenCalledWith(7);
  });

  it('writes precision and type in the same statement', async () => {
    await expect(
      applyModelFileHeaderCorrections({ ...target, corrections: { fp: 'bf16', type: 'VAE' } })
    ).resolves.toBe(true);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const query = executeRaw.mock.calls[0][0];
    expect(query.sql).toContain('"type" =');
    expect(query.values).toEqual([
      JSON.stringify({ fp: 'bf16' }),
      'VAE',
      target.fileId,
      target.fileUrl,
    ]);
  });

  it('does not bust the cache when the url guard rejected the write', async () => {
    executeRaw.mockResolvedValue(0);

    await expect(
      applyModelFileHeaderCorrections({ ...target, corrections: { fp: 'bf16' } })
    ).resolves.toBe(false);

    expect(deleteFilesForModelVersionCache).not.toHaveBeenCalled();
  });
});

describe('correctModelFileFromTensorHeader', () => {
  it('derives and writes the corrected precision in one call', async () => {
    await expect(
      correctModelFileFromTensorHeader({
        ...target,
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        currentFp: 'fp16',
        currentFileType: 'Model',
        modelType: 'Checkpoint',
      })
    ).resolves.toEqual({ corrections: { fp: 'bf16' }, applied: true });

    expect(executeRaw.mock.calls[0][0].values).toContain(JSON.stringify({ fp: 'bf16' }));
  });

  it('writes nothing when the record already agrees with the header', async () => {
    await expect(
      correctModelFileFromTensorHeader({
        ...target,
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        detectedModelType: 'Checkpoint',
        currentFp: 'bf16',
        currentFileType: 'Model',
        modelType: 'Checkpoint',
      })
    ).resolves.toEqual({ corrections: {}, applied: false });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
