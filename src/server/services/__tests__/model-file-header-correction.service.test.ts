import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelFileService from '~/server/services/model-file.service';

const { deleteFilesForModelVersionCache } = vi.hoisted(() => ({
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  deleteFilesForModelVersionCache,
}));

const executeRaw = dbMock.dbWrite.$executeRaw;

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
const fp8Counts = [{ dtype: 'F8_E4M3FN', count: 300, bytes: 4_000_000 }];
const mxfp8Counts = [
  { dtype: 'F8_E4M3', count: 300, bytes: 4_000_000 },
  { dtype: 'F8_E8M0', count: 300, bytes: 125_000 },
];
/** How bitsandbytes stores an nf4 checkpoint: 4-bit weights packed into U8, which the
 *  dtype map deliberately does not resolve, plus F16 auxiliary tensors that do. */
const nf4Counts = [
  { dtype: 'U8', count: 300, bytes: 4_000_000 },
  { dtype: 'F16', count: 60, bytes: 200_000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
  deleteFilesForModelVersionCache.mockResolvedValue(undefined);
});

describe('getModelFileHeaderCorrections — precision', () => {
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

  // The backlog this feature exists to fill: a file with no precision recorded at all.
  it.each([undefined, null] as const)('fills in a missing precision (%s)', (currentFp) => {
    expect(
      getModelFileHeaderCorrections({ format: 'SafeTensor', dtypeCounts: bf16Counts, currentFp })
    ).toEqual({ fp: 'bf16' });
  });

  it('corrects an fp16 record whose header is plain fp8', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: fp8Counts,
        currentFp: 'fp16',
      })
    ).toEqual({ fp: 'fp8' });
  });

  it('reads MXFP8 from its scale tensors rather than byte share', () => {
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: mxfp8Counts,
        currentFp: 'fp16',
      })
    ).toEqual({ fp: 'mxfp8' });
  });

  // 🔴 The whole point of FP_HEADER_CANNOT_STATE. Each of these is a value no safetensors
  // header can express, so the header is SILENT about it rather than disagreeing. Because
  // the correction runs on read, overwriting one re-applies over any manual fix — the
  // creator can never get their record back. Do not "fix" these to expect a correction.
  it.each([
    ['fp8_scaled', fp8Counts],
    ['fp8_mixed', fp8Counts],
    ['nf4', nf4Counts],
    ['nvfp4', mxfp8Counts],
    ['int4', nf4Counts],
  ] as const)('never overwrites a stored %s', (currentFp, dtypeCounts) => {
    expect(getModelFileHeaderCorrections({ format: 'SafeTensor', dtypeCounts, currentFp })).toEqual(
      {}
    );
  });

  // The complement: the list must not be so wide it protects values the header CAN state.
  it.each(['fp32', 'fp16', 'bf16', 'fp8', 'mxfp8', 'int8'] as const)(
    'still corrects a stored %s, which the header can state',
    (currentFp) => {
      expect(
        getModelFileHeaderCorrections({
          format: 'SafeTensor',
          dtypeCounts: bf16Counts,
          currentFp,
        }).fp ?? 'bf16'
      ).toBe('bf16');
    }
  );

  it('proposes nothing for a GGUF file even when its dtypes would map', () => {
    // F16 maps to fp16, so this fails the moment the `format !== 'SafeTensor'` guard goes.
    expect(
      getModelFileHeaderCorrections({
        format: 'GGUF',
        dtypeCounts: [{ dtype: 'F16', count: 300, bytes: 4_000_000 }],
        currentFp: 'fp32',
      })
    ).toEqual({});
  });
});

describe('getModelFileHeaderCorrections — type', () => {
  it('leaves type alone when the caller has no detected type', () => {
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

  // 🔴 The detection misreads whole architectures: an LLM's own weights match the
  // embed_tokens + layers.N text-encoder rule, and a vision-language model's match
  // VisionEncoder. Relabelling those drops the file out of primaryFileTypesByModelType,
  // so it stops being the version's primary file on the download path. A correction may
  // never demote a file that is already primary. Do not remove this guard.
  it.each([
    ['LLM', 'Model', 'TextEncoder'],
    ['VisionLanguage', 'Model', 'VisionEncoder'],
    ['MotionModule', 'Model', 'LoRA'],
  ] as const)(
    'refuses a %s correction that would drop the file out of the primary set',
    (modelType, currentFileType, detectedModelType) => {
      expect(
        getModelFileHeaderCorrections({
          format: 'SafeTensor',
          dtypeCounts: bf16Counts,
          detectedModelType,
          currentFp: 'bf16',
          currentFileType,
          modelType,
        })
      ).toEqual({});
    }
  );

  it('still corrects a non-primary file on a model type with a primary set', () => {
    // 'Other' is not primary for LLM, so nothing is demoted and the fix goes through.
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        detectedModelType: 'TextEncoder',
        currentFp: 'bf16',
        currentFileType: 'Other',
        modelType: 'LLM',
      })
    ).toEqual({ type: 'Text Encoder' });
  });

  it('allows a correction that stays inside the primary set', () => {
    // 'Diffusion Model' is primary for Checkpoint alongside 'Model', so this is not a demotion.
    expect(
      getModelFileHeaderCorrections({
        format: 'SafeTensor',
        dtypeCounts: bf16Counts,
        detectedModelType: 'DiffusionModel',
        currentFp: 'bf16',
        currentFileType: 'Model',
        modelType: 'Checkpoint',
      })
    ).toEqual({ type: 'Diffusion Model' });
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
    // A plain `||` onto SQL NULL yields NULL, so dropping the COALESCE/NULLIF wipes the
    // whole metadata object instead of merging into it.
    expect(query.sql).toContain("COALESCE(NULLIF(\"metadata\", 'null'::jsonb), '{}'::jsonb)");
    // Without the shape guard the statement throws on a row whose metadata is a scalar.
    expect(query.sql).toContain('jsonb_typeof');
    expect(query.values).toEqual([
      JSON.stringify({ fp: 'bf16' }),
      target.fileId,
      target.fileUrl,
      'bf16',
    ]);
    expect(deleteFilesForModelVersionCache).toHaveBeenCalledTimes(1);
    expect(deleteFilesForModelVersionCache).toHaveBeenCalledWith(7);
  });

  // 🔴 Postgres counts rows MATCHED, so a no-op UPDATE returns 1. Without these
  // predicates every viewer in the replica-lag window rewrites the same values and busts
  // the cache again, and `updated > 0` stops meaning "something changed".
  it('makes the statement a genuine no-op when the stored values already match', async () => {
    await expect(
      applyModelFileHeaderCorrections({ ...target, corrections: { fp: 'bf16', type: 'VAE' } })
    ).resolves.toBe(true);

    const { sql } = executeRaw.mock.calls[0][0];
    expect(sql).toContain(`"metadata"->>'fp' IS DISTINCT FROM`);
    expect(sql).toContain('"type" IS DISTINCT FROM');
  });

  // The shape guard belongs to the jsonb merge only. Gating a type-only correction on it
  // gave rows with scalar metadata an UPDATE matching 0 rows on every read, forever.
  it('does not gate a type-only correction on the metadata shape', async () => {
    await expect(
      applyModelFileHeaderCorrections({ ...target, corrections: { type: 'VAE' } })
    ).resolves.toBe(true);

    const { sql, values } = executeRaw.mock.calls[0][0];
    expect(sql).not.toContain('jsonb_typeof');
    expect(sql).toContain('"type" =');
    expect(values).toEqual(['VAE', target.fileId, target.fileUrl, 'VAE']);
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
      'bf16',
      'VAE',
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
