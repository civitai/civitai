import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency sweep — the generation hot-path readers in
 * generation.service.ts. These five reads all run on the generation submit /
 * config path (four together in getGenerationConfig's Promise.all), so a single
 * un-deadlined member parking on a silent sysRedis half-open would park the whole
 * gen submit ~11min on every request.
 *
 * Each already fail-opens (try/catch or a chained `.catch`); the gap this PR
 * closes is the missing wall-clock deadline. The SLOW tests are fail-on-revert:
 * the underlying sysRedis op NEVER settles, so if the `withSysReadDeadline(...)`
 * wrap were removed the caller would hang and the test would TIME OUT.
 */

const { mockHGet, mockWithSysReadDeadline, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockHGet: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: mockHGet },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// Collapse the heavy sibling-service graph: these are only used at runtime by
// code paths the five readers under test never reach, so empty/vi.fn stubs keep
// the import light without touching DB / search-index / image feed infra.
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
vi.mock('~/server/services/model-version.service', () => ({ getLinkedVaeIds: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
// NB: leave ~/server/services/feature-flags.service REAL — it exports `userTiers`
// (a constant consumed by user.schema at module load). resolveTestingAccess only
// reaches its isFlipt at runtime for a NON-empty user; the tests pass `{}`, so the
// flag call is short-circuited and never opens a connection.

import {
  getGenerationStatus,
  getUnstableResources,
  getGenerationEcosystemConfig,
  getGateRules,
  getUnavailableResources,
} from '~/server/services/generation/generation.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
});

describe('getGenerationStatus — sysRedis soft-dependency', () => {
  it('happy path: returns the parsed status through withSysReadDeadline, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify({ available: false }));

    const result = await getGenerationStatus();

    expect(result.available).toBe(false);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to schema defaults (available=true), no throw, logs defaults-firing', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await getGenerationStatus();

    expect(result.available).toBe(true); // schema default — service appears enabled
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('defaults-firing');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getGenerationStatus generation.service');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to defaults (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getGenerationStatus();

    expect(result.available).toBe(true);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('defaults-firing');
  });
});

describe('getUnstableResources — sysRedis soft-dependency', () => {
  it('happy path: returns the parsed list through withSysReadDeadline, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify([1, 2, 3]));

    const result = await getUnstableResources();

    expect(result).toEqual([1, 2, 3]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to [], no throw, logs read-degraded', async () => {
    mockHGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getUnstableResources();

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getUnstableResources');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getUnstableResources();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

describe('getGenerationEcosystemConfig — sysRedis soft-dependency', () => {
  it('happy path: returns the parsed config through withSysReadDeadline, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify({ experimentalEcosystems: ['flux'] }));

    const result = await getGenerationEcosystemConfig({});

    expect(result.experimentalEcosystems).toEqual(['flux']);
    expect(result.hasTestingAccess).toBe(false);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to defaults, no throw, logs read-degraded', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await getGenerationEcosystemConfig({});

    expect(result.hasTestingAccess).toBe(false);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getGenerationEcosystemConfig');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to defaults (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getGenerationEcosystemConfig({});

    expect(result.hasTestingAccess).toBe(false);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

describe('getGateRules — sysRedis soft-dependency', () => {
  it('happy path: returns [] through withSysReadDeadline when no rules cached, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify([]));

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to [], no throw, logs read-degraded', async () => {
    mockHGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getGateRules');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

describe('getUnavailableResources — sysRedis soft-dependency', () => {
  it('happy path: returns the deduped list through withSysReadDeadline, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify([1, 1, 2]));

    const result = await getUnavailableResources();

    expect(result).toEqual([1, 2]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to [], no throw, logs read-degraded', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await getUnavailableResources();

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getUnavailableResources');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getUnavailableResources();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});
