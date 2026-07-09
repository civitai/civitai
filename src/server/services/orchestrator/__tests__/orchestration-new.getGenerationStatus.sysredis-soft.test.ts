import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency — the LOCAL getGenerationStatus dup in
 * orchestration-new.service.ts, exercised through its exported caller
 * buildGenerationContext. Same contract as the generation.service reader: it
 * already try/catch fail-opens to schema defaults; STEP-6 adds the wall-clock
 * deadline so a silent half-open rejects instead of parking ~11min while the
 * generation context is built.
 *
 * getGenerationEcosystemConfig + getGateRules are imported from generation.service
 * and mocked here, so the ONLY withSysReadDeadline call is the local status read
 * under test. The SLOW test is fail-on-revert (hGet never settles).
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
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: mockHGet },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// Keep the DB / infra layer inert (avoids booting Prisma / kysely / pools at
// import — buildGenerationContext never touches them on the status path).
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({ createLagTracker: vi.fn(() => ({})), loadDbEnv: vi.fn(() => ({})) }));

// The two sibling readers buildGenerationContext composes — mock so the only
// deadline-wrapped read is the local getGenerationStatus under test, and so the
// heavy generation.service graph doesn't load.
vi.mock('~/server/services/generation/generation.service', () => ({
  getGenerationEcosystemConfig: vi.fn(async () => ({
    experimentalEcosystems: [],
    hasTestingAccess: false,
  })),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
}));

// image.service (pulled transitively via cosmetic.service) imports the private
// `event-engine-common` submodule that isn't checked out here + boots DB pools;
// buildGenerationContext never uses it, so stub it out.
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { buildGenerationContext } from '~/server/services/orchestrator/orchestration-new.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
});

describe('buildGenerationContext → local getGenerationStatus — sysRedis soft-dependency', () => {
  it('happy path: reads status through withSysReadDeadline, resolves, no fail-open', async () => {
    mockHGet.mockResolvedValue(JSON.stringify({ available: true }));

    const result = await buildGenerationContext('free', {}, {});

    expect(result).toBeDefined();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → local status fails open to defaults, resolves, logs defaults-firing', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await buildGenerationContext('free', {}, {});

    expect(result).toBeDefined(); // did NOT throw
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('defaults-firing');
    expect(fn).toBe('getGenerationStatus orchestration-new');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to defaults (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await buildGenerationContext('free', {}, {});

    expect(result).toBeDefined();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('defaults-firing');
  });
});
