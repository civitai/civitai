import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency sweep — the generation hot-path readers in
 * generation.service.ts. These reads all run on the generation submit / config
 * path (four together in getGenerationConfig's Promise.all), so a single
 * un-deadlined member parking on a silent sysRedis half-open would park the whole
 * gen submit ~11min on every request.
 *
 * Each already fail-opens (try/catch or a chained `.catch`); the gap this PR
 * closes is the missing wall-clock deadline. The SLOW tests are fail-on-revert:
 * the underlying sysRedis op NEVER settles, so if the `withSysReadDeadline(...)`
 * wrap were removed the caller would hang and the test would TIME OUT.
 */

const {
  mockHGet,
  mockGet,
  mockHGetAll,
  mockHSetNX,
  mockSet,
  mockHSet,
  mockHDel,
  mockWithSysReadDeadline,
  mockLogSysRedisFailOpen,
} = vi.hoisted(() => ({
  mockHGet: vi.fn(),
  mockGet: vi.fn(),
  mockHGetAll: vi.fn(),
  mockHSetNX: vi.fn(),
  mockSet: vi.fn(),
  mockHSet: vi.fn(),
  mockHDel: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', async () => {
  const real = await import('@civitai/redis/client');
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: {
      hGet: mockHGet,
      get: mockGet,
      hGetAll: mockHGetAll,
      hSetNX: mockHSetNX,
      set: mockSet,
      hSet: mockHSet,
      hDel: mockHDel,
    },
    REDIS_KEYS: real.REDIS_KEYS,
    REDIS_SYS_KEYS: real.REDIS_SYS_KEYS,
    REDIS_SUB_KEYS: real.REDIS_SUB_KEYS,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

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
  deleteGateRule,
  getGenerationStatus,
  getGeneratorMessages,
  getUnstableResources,
  getGateRules,
  saveGateRule,
  saveGeneratorMessage,
} from '~/server/services/generation/generation.service';
import type { GateRule } from '~/shared/data-graph/generation/gates';
import { dbMock } from '~/__tests__/mocks/db.mock';

beforeEach(() => {
  // reset, not clear: a never-settling implementation must not leak into the next test.
  vi.resetAllMocks();
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

describe('getGateRules — sysRedis soft-dependency', () => {
  it('happy path: returns [] through withSysReadDeadline when no rules stored, no fail-open', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockResolvedValue({});

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGetAll throws → fails open to [], no throw, logs read-degraded', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getGateRules');
  });

  it('SLOW/half-open: the read NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockHGetAll.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getGateRules();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

const rule = (id: string): GateRule => ({
  id,
  name: 'Ideogram pre-launch',
  availableTo: 'moderators',
  presentation: 'hidden',
  message: undefined,
  ecosystems: ['Ideogram'],
  workflows: [],
  modelVersionIds: [],
});

const message = {
  id: 'm1',
  name: 'MiniMax H3 price change',
  kind: 'pricing' as const,
  message: 'Prices change on the 15th.',
  dismissible: true,
  audiences: [],
  ecosystems: ['MiniMaxH3'],
  workflows: [],
  modelVersionIds: [],
};

/** In-memory sysRedis, so a migration's writes are visible to the read that follows it. */
function fakeSysRedis(legacy: Record<string, unknown[]>) {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  };
  for (const [field, entries] of Object.entries(legacy))
    hash('system:features').set(field, JSON.stringify(entries));

  mockGet.mockImplementation(async (key: string) => strings.get(key) ?? null);
  mockSet.mockImplementation(async (key: string, value: string) => {
    strings.set(key, value);
    return 'OK';
  });
  mockHGet.mockImplementation(async (key: string, field: string) => hash(key).get(field) ?? null);
  mockHGetAll.mockImplementation(async (key: string) => Object.fromEntries(hash(key)));
  mockHSet.mockImplementation(async (key: string, field: string, value: string) => {
    hash(key).set(field, value);
  });
  mockHSetNX.mockImplementation(async (key: string, field: string, value: string) => {
    if (hash(key).has(field)) return false;
    hash(key).set(field, value);
    return true;
  });
  mockHDel.mockImplementation(async (key: string, field: string) => {
    hash(key).delete(field);
  });
  return { strings, hash };
}

describe('gate-rule storage migration', () => {
  it('migrates on the first read and returns the legacy rules from the new hash', async () => {
    const redis = fakeSysRedis({ 'generation:gate-rules': [rule('r1'), rule('r2')] });

    const result = await getGateRules();

    expect(result.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(redis.strings.get('generation:gate-rules:migrated')).toBe('1');
    expect([...redis.hash('generation:gate-rules:by-id').keys()].sort()).toEqual(['r1', 'r2']);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('serves the same rules on the next read, from the hash alone', async () => {
    fakeSysRedis({ 'generation:gate-rules': [rule('r1')] });
    await getGateRules();
    mockHGet.mockClear();
    mockHSetNX.mockClear();

    const result = await getGateRules();

    expect(result.map((r) => r.id)).toEqual(['r1']);
    expect(mockHGet).not.toHaveBeenCalled();
    expect(mockHSetNX).not.toHaveBeenCalled();
  });

  it('keeps an entry only a newer build understands, and drops unreadable ones on read', async () => {
    const future = { id: 'future', presentation: 'from-a-newer-build' };
    const redis = fakeSysRedis({ 'generation:gate-rules': [rule('r1'), future, 'no id'] });

    const result = await getGateRules();

    expect(result.map((r) => r.id)).toEqual(['r1']);
    expect([...redis.hash('generation:gate-rules:by-id').keys()].sort()).toEqual(['future', 'r1']);
  });

  it('never overwrites a rule already in the hash', async () => {
    const redis = fakeSysRedis({ 'generation:gate-rules': [{ ...rule('r1'), name: 'stale' }] });
    redis
      .hash('generation:gate-rules:by-id')
      .set('r1', JSON.stringify({ ...rule('r1'), name: 'fresh' }));

    const [result] = await getGateRules();

    expect(result.name).toBe('fresh');
  });

  // The legacy array is never read once the marker is set, so a copy that fails
  // after it would lose that rule for good.
  it('a failed copy leaves the marker unset, fails open, and the next read recovers', async () => {
    const redis = fakeSysRedis({ 'generation:gate-rules': [rule('r1'), rule('r2')] });
    const copy = mockHSetNX.getMockImplementation()!;
    mockHSetNX.mockImplementationOnce(async () => {
      throw new Error('ECONNRESET');
    });

    expect(await getGateRules()).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(redis.strings.has('generation:gate-rules:migrated')).toBe(false);

    mockHSetNX.mockImplementation(copy);
    expect((await getGateRules()).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('saves one rule after migrating', async () => {
    const redis = fakeSysRedis({ 'generation:gate-rules': [rule('r1'), rule('r2')] });

    await saveGateRule({ ...rule('r1'), name: 'renamed' });

    expect(redis.strings.get('generation:gate-rules:migrated')).toBe('1');
    const result = await getGateRules();
    expect(result.map((r) => [r.id, r.name]).sort()).toEqual([
      ['r1', 'renamed'],
      ['r2', 'Ideogram pre-launch'],
    ]);
  });

  // Without migrating first, the later copy would undo a delete.
  it('a delete as the very first write stays deleted', async () => {
    fakeSysRedis({ 'generation:gate-rules': [rule('r1'), rule('r2')] });

    await deleteGateRule('r2');

    expect((await getGateRules()).map((r) => r.id)).toEqual(['r1']);
  });

  it('gate rules and messages migrate independently', async () => {
    fakeSysRedis({ 'generation:gate-rules': [rule('r1')], 'generation:messages': [message] });

    await getGateRules();
    const messages = await getGeneratorMessages();

    expect(messages.map((m) => m.id)).toEqual(['m1']);
    expect((await getGateRules()).map((r) => r.id)).toEqual(['r1']);
  });
});

describe('generator-message storage migration', () => {
  it('migrates on the first read and returns the legacy messages', async () => {
    fakeSysRedis({ 'generation:messages': [message] });

    const result = await getGeneratorMessages();

    expect(result.map((m) => m.id)).toEqual(['m1']);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it('migrates before the first save, keeping the legacy messages', async () => {
    fakeSysRedis({ 'generation:messages': [{ ...message, id: 'existing', createdAt: 1 }] });

    await saveGeneratorMessage(message);

    const result = await getGeneratorMessages();
    expect(result.map((m) => m.id).sort()).toEqual(['existing', 'm1']);
  });

  // hGetAll has no order, so createdAt is the only one messages have.
  it('returns messages oldest first whatever order they are stored in', async () => {
    fakeSysRedis({
      'generation:messages': [
        { ...message, id: 'new', createdAt: 2 },
        { ...message, id: 'old', createdAt: 1 },
      ],
    });

    expect((await getGeneratorMessages()).map((m) => m.id)).toEqual(['old', 'new']);
  });

  it('DOWN: hGetAll throws → fails open to [], logs read-degraded', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await getGeneratorMessages()).toEqual([]);
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('getGeneratorMessages');
  });

  it('SLOW/half-open: the read NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockHGetAll.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    expect(await getGeneratorMessages()).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });
});
