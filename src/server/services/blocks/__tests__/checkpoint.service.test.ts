import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the checkpoint service. validateBlockCheckpoint exercises
 * every failure mode the install form needs to render distinctly.
 * resolveBlockCheckpoint exercises the four-rung precedence chain and the
 * drop-on-invalid behavior that keeps users from being stuck on a stale
 * override.
 */

const { mockDbRead, mockRedis, mockResolveBlockInstance } = vi.hoisted(() => ({
  mockDbRead: {
    modelVersion: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    blockUserSettings: { findUnique: vi.fn() },
    modelMetric: { findFirst: vi.fn() },
  },
  // Platform-fallback path uses redis for the popular-checkpoint cache.
  // Default to "miss" so each test exercises the DB query unless it sets
  // a cached value explicitly. Typed loosely so individual tests can
  // override with string (cache hit) or rejection (outage).
  mockRedis: {
    get: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    set: vi.fn(async () => undefined),
  },
  // The publisher-install settings now flow through
  // BlockRegistry.resolveBlockInstance (post kill_per_model_installs:
  // model_block_installs was absorbed into block_user_subscriptions, and
  // synthetic blockInstanceIds resolve their settings from the source row).
  // checkpoint.service reads `install.settings` from this resolver, so the
  // tests drive the publisher default through it rather than the retired
  // dbRead.modelBlockInstall.findUnique seam.
  mockResolveBlockInstance: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: { BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } },
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveBlockInstance: mockResolveBlockInstance },
}));

import {
  getPopularCheckpointForEcosystem,
  getRepresentativeBaseModel,
  resolveBlockCheckpoint,
  validateBlockCheckpoint,
} from '../checkpoint.service';

beforeEach(() => {
  mockDbRead.modelVersion.findUnique.mockReset();
  mockDbRead.modelVersion.findFirst.mockReset();
  mockDbRead.modelVersion.findMany.mockReset();
  mockDbRead.blockUserSettings.findUnique.mockReset();
  mockDbRead.modelMetric.findFirst.mockReset();
  mockRedis.get.mockReset().mockImplementation(async () => null);
  mockRedis.set.mockReset().mockImplementation(async () => undefined);
  // Default: no publisher install row resolved. Tests that exercise the
  // publisher-default rung override this with a settings-bearing row.
  mockResolveBlockInstance.mockReset().mockResolvedValue(null);
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

describe('getPopularCheckpointForEcosystem', () => {
  // Fixture shape mirrors the rewritten query that starts from
  // modelMetric.findFirst (Prisma can't orderBy a scalar through a 1:many
  // relation, so we project the model + its top version through the metric).
  const topMetricFixture = {
    modelId: 618692,
    model: {
      id: 618692,
      name: 'FLUX',
      modelVersions: [{ id: 691639, name: 'v1.0', baseModel: 'Flux.1 D' }],
    },
  };

  it('returns the top-thumbed Checkpoint mapped to its latest published version', async () => {
    mockDbRead.modelMetric.findFirst.mockResolvedValue(topMetricFixture);
    const result = await getPopularCheckpointForEcosystem('Flux.1 D');
    expect(result).toMatchObject({
      versionId: 691639,
      modelId: 618692,
      baseModel: 'Flux.1 D',
      modelName: 'FLUX',
      versionName: 'v1.0',
    });
    // Should have queried Published ModelMetrics whose related model is a
    // Checkpoint with at least one version in the family, ordered by
    // thumbsUpCount.
    expect(mockDbRead.modelMetric.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'Published' }),
        orderBy: { thumbsUpCount: 'desc' },
      })
    );
  });

  it('uses the redis cache when present (no DB hit on warm cache)', async () => {
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({
        versionId: 999,
        modelId: 99,
        baseModel: 'Flux.1 D',
        modelName: 'cached',
        versionName: 'v1',
      })
    );
    const result = await getPopularCheckpointForEcosystem('Flux.1 D');
    expect(result?.versionId).toBe(999);
    expect(mockDbRead.modelMetric.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when the ecosystem has no Published Checkpoints', async () => {
    mockDbRead.modelMetric.findFirst.mockResolvedValue(null);
    const result = await getPopularCheckpointForEcosystem('Flux.1 D');
    expect(result).toBeNull();
    // Null shouldn't be cached — let the next call re-check (a new
    // Checkpoint may have shipped in the meantime).
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('survives redis outages by falling through to the DB query', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('redis down'));
    mockDbRead.modelMetric.findFirst.mockResolvedValue(topMetricFixture);
    const result = await getPopularCheckpointForEcosystem('Flux.1 D');
    expect(result?.versionId).toBe(691639);
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
    expect(mockResolveBlockInstance).not.toHaveBeenCalled();
    expect(mockDbRead.blockUserSettings.findUnique).not.toHaveBeenCalled();
    expect(result.versionId).toBe(555);
  });

  it('uses the viewer override when set and valid (publisher default is ignored)', async () => {
    mockResolveBlockInstance.mockResolvedValue({
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
    mockResolveBlockInstance.mockResolvedValue({
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
    mockResolveBlockInstance.mockResolvedValue({
      settings: { default_checkpoint_version_id: 691639 },
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    mockDbRead.modelVersion.findUnique.mockResolvedValue(validCheckpoint);
    const result = await resolveBlockCheckpoint(loraOpts);
    expect(result.versionId).toBe(691639);
  });

  it('falls back to platform per-ecosystem popular Checkpoint when neither is set', async () => {
    mockResolveBlockInstance.mockResolvedValue({ settings: {} });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    // Platform fallback queries modelMetric.findFirst for the top
    // Checkpoint by thumbsUpCount.
    mockDbRead.modelMetric.findFirst.mockResolvedValue({
      modelId: 618692,
      model: {
        id: 618692,
        name: 'FLUX',
        modelVersions: [{ id: 691639, name: 'v1.0', baseModel: 'Flux.1 D' }],
      },
    });
    const result = await resolveBlockCheckpoint(loraOpts);
    expect(result.versionId).toBe(691639);
    expect(result.modelName).toBe('FLUX');
  });

  it('throws BAD_REQUEST only when the ecosystem has no published Checkpoints at all', async () => {
    mockResolveBlockInstance.mockResolvedValue({ settings: {} });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    // Ecosystem genuinely empty (no Checkpoints exist for this family).
    mockDbRead.modelMetric.findFirst.mockResolvedValue(null);
    await expect(resolveBlockCheckpoint(loraOpts)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('surfaces publisher-default validation failures (publisher must fix)', async () => {
    mockResolveBlockInstance.mockResolvedValue({
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
