import { describe, expect, it, vi } from 'vitest';

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
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
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

import { getResourceCanGenerate } from '~/server/services/generation/generation.service';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';

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
    expect(canGenerate(ModelVersionFlag.GenerationDisabled | ModelVersionFlag.DisablePayout)).toBe(
      false
    );
  });

  it('does NOT block on an unrelated flag (bit-confusion guard)', () => {
    expect(canGenerate(ModelVersionFlag.DisablePayout)).toBe(true);
    expect(canGenerate(ModelVersionFlag.NotDerivative)).toBe(true);
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
