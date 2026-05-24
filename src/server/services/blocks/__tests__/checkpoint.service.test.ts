import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the checkpoint service. validateBlockCheckpoint exercises
 * every failure mode the install form needs to render distinctly.
 * resolveBlockCheckpoint exercises the four-rung precedence chain and the
 * drop-on-invalid behavior that keeps users from being stuck on a stale
 * override.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelVersion: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    blockUserSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import {
  getRepresentativeBaseModel,
  resolveBlockCheckpoint,
  validateBlockCheckpoint,
} from '../checkpoint.service';

beforeEach(() => {
  mockDbRead.modelVersion.findUnique.mockReset();
  mockDbRead.modelVersion.findFirst.mockReset();
  mockDbRead.modelVersion.findMany.mockReset();
  mockDbRead.modelBlockInstall.findUnique.mockReset();
  mockDbRead.blockUserSettings.findUnique.mockReset();
});

describe('validateBlockCheckpoint', () => {
  it('returns resolved fields for a valid published Checkpoint in the same family', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 691639,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      status: 'Published',
      modelId: 618692,
      model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
    });
    const result = await validateBlockCheckpoint({
      checkpointVersionId: 691639,
      forBaseModel: 'Flux.1 D',
      reason: 'publisher-default',
    });
    expect(result).toEqual({
      versionId: 691639,
      modelId: 618692,
      baseModel: 'Flux.1 D',
      modelName: 'FLUX',
      versionName: 'v1.0',
    });
  });

  it('matches across baseModel strings within the same ecosystem (Flux.1 D ↔ Flux.1 S)', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 691639,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      status: 'Published',
      modelId: 618692,
      model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
    });
    // Bound model is Flux.1 S — different baseModel string, same family.
    const result = await validateBlockCheckpoint({
      checkpointVersionId: 691639,
      forBaseModel: 'Flux.1 S',
      reason: 'publisher-default',
    });
    expect(result.versionId).toBe(691639);
  });

  it('throws not-found when the version row is missing', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect(
      validateBlockCheckpoint({
        checkpointVersionId: 691639,
        forBaseModel: 'Flux.1 D',
        reason: 'publisher-default',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { reason: 'not-found' },
    });
  });

  it('throws not-published when the version is in Draft', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 691639,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      status: 'Draft',
      modelId: 618692,
      model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
    });
    await expect(
      validateBlockCheckpoint({
        checkpointVersionId: 691639,
        forBaseModel: 'Flux.1 D',
        reason: 'publisher-default',
      })
    ).rejects.toMatchObject({ cause: { reason: 'not-published' } });
  });

  it('throws not-a-checkpoint when the model is a LoRA', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      status: 'Published',
      modelId: 7,
      model: { id: 7, name: 'My LoRA', type: 'LORA' },
    });
    await expect(
      validateBlockCheckpoint({
        checkpointVersionId: 99,
        forBaseModel: 'Flux.1 D',
        reason: 'publisher-default',
      })
    ).rejects.toMatchObject({ cause: { reason: 'not-a-checkpoint' } });
  });

  it('throws wrong-ecosystem when the family does not match', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 100,
      name: 'v1.0',
      baseModel: 'SDXL 1.0',
      status: 'Published',
      modelId: 8,
      model: { id: 8, name: 'SDXL Base', type: 'Checkpoint' },
    });
    await expect(
      validateBlockCheckpoint({
        checkpointVersionId: 100,
        forBaseModel: 'Flux.1 D',
        reason: 'publisher-default',
      })
    ).rejects.toMatchObject({ cause: { reason: 'wrong-ecosystem' } });
  });
});

describe('getRepresentativeBaseModel', () => {
  it('returns the most recent published version baseModel', async () => {
    mockDbRead.modelVersion.findFirst.mockResolvedValueOnce({ baseModel: 'Flux.1 D' });
    const result = await getRepresentativeBaseModel(7);
    expect(result).toBe('Flux.1 D');
  });

  it('falls back to any version when no published exists yet', async () => {
    mockDbRead.modelVersion.findFirst
      .mockResolvedValueOnce(null) // published lookup
      .mockResolvedValueOnce({ baseModel: 'SDXL 1.0' }); // fallback any
    const result = await getRepresentativeBaseModel(7);
    expect(result).toBe('SDXL 1.0');
  });

  it('returns null when the model has no versions', async () => {
    mockDbRead.modelVersion.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const result = await getRepresentativeBaseModel(7);
    expect(result).toBeNull();
  });
});

describe('resolveBlockCheckpoint precedence chain', () => {
  const loraOpts = {
    blockInstanceId: 'bki_test',
    modelId: 7,
    modelVersionId: 99,
    baseModel: 'Flux.1 D',
    modelType: 'LORA',
    userId: 42,
  };
  const validCheckpoint = {
    id: 691639,
    name: 'v1.0',
    baseModel: 'Flux.1 D',
    status: 'Published',
    modelId: 618692,
    model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
  };

  it('short-circuits to the model itself for Checkpoint-bound installs (atomic)', async () => {
    const result = await resolveBlockCheckpoint({
      ...loraOpts,
      modelType: 'Checkpoint',
      modelVersionId: 555,
    });
    // No DB calls — Checkpoint-self is computed from the inputs.
    expect(mockDbRead.modelBlockInstall.findUnique).not.toHaveBeenCalled();
    expect(mockDbRead.blockUserSettings.findUnique).not.toHaveBeenCalled();
    expect(result.versionId).toBe(555);
  });

  it('uses the viewer override when set and valid (publisher default is ignored)', async () => {
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 111 }, // publisher default
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue({
      settings: { checkpoint_version_id: 691639 }, // viewer override
    });
    mockDbRead.modelVersion.findUnique.mockResolvedValue(validCheckpoint);
    const result = await resolveBlockCheckpoint(loraOpts);
    expect(result.versionId).toBe(691639);
    // validateBlockCheckpoint should have been called with the override id,
    // not the publisher's.
    expect(mockDbRead.modelVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 691639 } })
    );
  });

  it('falls through to publisher default when the viewer override is invalid (drop-on-stale)', async () => {
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 691639 },
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue({
      settings: { checkpoint_version_id: 222 }, // stale: maps to nothing
    });
    // First lookup (override) → null = not found. Second lookup (publisher) → valid.
    mockDbRead.modelVersion.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(validCheckpoint);
    const result = await resolveBlockCheckpoint(loraOpts);
    expect(result.versionId).toBe(691639);
  });

  it('uses publisher default when no viewer override row exists', async () => {
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 691639 },
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    mockDbRead.modelVersion.findUnique.mockResolvedValue(validCheckpoint);
    const result = await resolveBlockCheckpoint(loraOpts);
    expect(result.versionId).toBe(691639);
  });

  it('throws when no override AND no publisher default — install is misconfigured', async () => {
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({ settings: {} });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    await expect(resolveBlockCheckpoint(loraOpts)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // No platform-wide fallback should have been attempted.
    expect(mockDbRead.modelVersion.findUnique).not.toHaveBeenCalled();
  });

  it('surfaces publisher-default validation failures (publisher must fix)', async () => {
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 999 },
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    // Publisher's checkpoint is now unpublished — don't silently fall to
    // BAD_REQUEST below, surface the specific reason so the publisher can
    // fix it.
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 999,
      name: 'v1.0',
      baseModel: 'Flux.1 D',
      status: 'Draft',
      modelId: 618692,
      model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
    });
    await expect(resolveBlockCheckpoint(loraOpts)).rejects.toMatchObject({
      cause: { reason: 'not-published' },
    });
  });
});
