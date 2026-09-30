import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the GenerationDisabled flag gate.
 *
 * The generation blacklist lives on `ModelVersion.flags` (bit 1 / value 2). This
 * matrix pins the ONE thing that must never silently regress: a version carrying
 * that bit is not generatable, and a version carrying a DIFFERENT flag still is
 * (guards against bit confusion when a new flag is added to the shared column).
 */

// Collapse the heavy sibling-service graph — `getResourceCanGenerate` is pure,
// but importing generation.service pulls in DB / search-index / image infra.
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/ecosystems/wan.handler', () => ({
  wanBaseModelGroupIdMap: {},
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import {
  getResourceCanGenerate,
  toggleEvictable,
  toggleGenerationDisabled,
} from '~/server/services/generation/generation.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

const noHiddenGates = { ecosystems: new Set<string>(), versionIds: new Set<number>() };

// A published, covered, public version owned by someone else — generatable in
// every respect EXCEPT whatever `flags` says.
const baseResource = {
  id: 1,
  status: 'Published',
  availability: 'Public',
  baseModel: 'SD 1.5',
  covered: true,
  modelUserId: 999,
};

const canGenerate = (flags: number) =>
  getResourceCanGenerate({
    resource: { ...baseResource, flags },
    user: { id: 123, isModerator: false },
    hiddenGates: noHiddenGates,
  });

describe('getResourceCanGenerate — GenerationDisabled flag', () => {
  it('allows generation when no flags are set', () => {
    expect(canGenerate(ModelVersionFlag.None)).toBe(true);
  });

  it('BLOCKS generation when GenerationDisabled is set', () => {
    expect(canGenerate(ModelVersionFlag.GenerationDisabled)).toBe(false);
  });

  it('blocks when GenerationDisabled is combined with another flag', () => {
    expect(canGenerate(ModelVersionFlag.GenerationDisabled | ModelVersionFlag.NotDerivative)).toBe(
      false
    );
  });

  it('does NOT block on an unrelated flag (bit-confusion guard)', () => {
    expect(canGenerate(ModelVersionFlag.NotDerivative)).toBe(true);
    // Retired bit 0 (was DisablePayout) — rows in the wild still carry it.
    expect(canGenerate(1)).toBe(true);
  });

  it('blocks a moderator too — the flag is not a visibility gate', () => {
    const result = getResourceCanGenerate({
      resource: { ...baseResource, flags: ModelVersionFlag.GenerationDisabled },
      user: { id: 123, isModerator: true },
      hiddenGates: noHiddenGates,
    });
    expect(result).toBe(false);
  });
});

describe('moderator flag toggles', () => {
  const VERSION_ID = 7;
  const MODEL_ID = 70;
  const queryRaw = () => vi.mocked(dbMock.dbWrite.$queryRaw);
  const flippedBit = () => queryRaw().mock.calls[0]?.[1];

  beforeEach(() => {
    queryRaw().mockReset();
    vi.mocked(bustMvCache).mockReset();
  });

  it.each([
    ['toggleGenerationDisabled', toggleGenerationDisabled, ModelVersionFlag.GenerationDisabled],
    ['toggleEvictable', toggleEvictable, ModelVersionFlag.NotEvictable],
  ] as const)('%s XORs only its own bit and busts the version cache', async (_, toggle, bit) => {
    queryRaw().mockResolvedValueOnce([{ modelId: MODEL_ID, flags: bit }] as never);
    await toggle({ id: VERSION_ID, isModerator: true });
    expect(flippedBit()).toBe(bit);
    expect(queryRaw().mock.calls[0]?.[2]).toBe(VERSION_ID);
    expect(bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID);
  });

  it('reports generationDisabled from the returned flags', async () => {
    queryRaw().mockResolvedValueOnce([
      {
        modelId: MODEL_ID,
        flags: ModelVersionFlag.GenerationDisabled | ModelVersionFlag.NotEvictable,
      },
    ] as never);
    expect(await toggleGenerationDisabled({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      generationDisabled: true,
    });
    queryRaw().mockResolvedValueOnce([
      { modelId: MODEL_ID, flags: ModelVersionFlag.NotEvictable },
    ] as never);
    expect(await toggleGenerationDisabled({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      generationDisabled: false,
    });
  });

  it('reports evictable from the returned flags', async () => {
    queryRaw().mockResolvedValueOnce([
      {
        modelId: MODEL_ID,
        flags: ModelVersionFlag.NotEvictable | ModelVersionFlag.GenerationDisabled,
      },
    ] as never);
    expect(await toggleEvictable({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      evictable: false,
    });
    queryRaw().mockResolvedValueOnce([
      { modelId: MODEL_ID, flags: ModelVersionFlag.GenerationDisabled },
    ] as never);
    expect(await toggleEvictable({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      evictable: true,
    });
  });

  it.each([
    ['toggleGenerationDisabled', toggleGenerationDisabled],
    ['toggleEvictable', toggleEvictable],
  ] as const)('%s refuses a non-moderator without writing', async (_, toggle) => {
    await expect(toggle({ id: VERSION_ID, isModerator: false })).rejects.toThrow();
    expect(queryRaw()).not.toHaveBeenCalled();
    expect(bustMvCache).not.toHaveBeenCalled();
  });

  it.each([
    ['toggleGenerationDisabled', toggleGenerationDisabled],
    ['toggleEvictable', toggleEvictable],
  ] as const)('%s 404s on a missing version and busts nothing', async (_, toggle) => {
    queryRaw().mockResolvedValueOnce([] as never);
    await expect(toggle({ id: VERSION_ID, isModerator: true })).rejects.toThrow(
      `No model version with id ${VERSION_ID}`
    );
    expect(bustMvCache).not.toHaveBeenCalled();
  });
});
