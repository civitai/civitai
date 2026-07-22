import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency (Group B) — getCollectionRandomSeed.
 *
 * This was a RAW read (neither try/catch nor deadline): a sysRedis outage would
 * 500 a Random-sorted collection view, and a silent half-open would park it
 * ~11min. STEP-6 wraps it in try/catch + withSysReadDeadline and fails open to a
 * locally-computed hourly seed (computeHourlySeed) — the same value the function
 * writes to the shared cache on a cache miss, so a degraded read just skips the
 * round-trip and the view stays deterministic-per-hour.
 *
 * The SLOW test is fail-on-revert: `sysRedis.get` NEVER settles, so if the
 * `withSysReadDeadline(...)` wrap were removed the caller would hang → timeout.
 */

const { mockGet, mockSet, mockWithSysReadDeadline, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(async () => 'OK'),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { get: vi.fn(), set: vi.fn(), packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: { get: mockGet, set: mockSet },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// @civitai/db's index re-exports ./kysely, whose top-level `import 'kysely'` is
// not installed in this worktree. Replacing the whole package short-circuits that
// eval — none of it is needed by getCollectionRandomSeed.
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));

// Collapse the heavy sibling graph — getCollectionRandomSeed touches only
// sysRedis + computeHourlySeed, so DB / cache / other service infra is inert.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: {},
  userCollectionCountCache: {},
}));
// Stub the sibling services collection.service pulls in — their graphs reach the
// @civitai/db layer (kysely) which isn't needed by getCollectionRandomSeed.
vi.mock('~/server/services/article.service', () => ({ getArticles: vi.fn() }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({ getModelsWithVersions: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ getPostsInfinite: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));

import { getCollectionRandomSeed } from '~/server/services/collection.service';

// The function fails open to Math.floor(Date.now() / (1000*60*60)); compute the
// same value here to assert the degraded return without pinning a literal.
const currentHourSeed = () => Math.floor(Date.now() / (1000 * 60 * 60));

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  mockSet.mockResolvedValue('OK');
});

describe('getCollectionRandomSeed — sysRedis soft-dependency', () => {
  it('happy path: returns the cached seed through withSysReadDeadline, no fail-open', async () => {
    mockGet.mockResolvedValue('12345');

    const result = await getCollectionRandomSeed();

    expect(result).toBe(12345);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('cache miss (null): computes + writes back the hourly seed, no fail-open', async () => {
    mockGet.mockResolvedValue(null);

    const result = await getCollectionRandomSeed();

    expect(result).toBe(currentHourSeed());
    expect(mockSet).toHaveBeenCalledTimes(1); // writeback on cache miss
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: get throws → fails open to the locally-computed hourly seed, no throw, logs read-degraded', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getCollectionRandomSeed();

    expect(result).toBe(currentHourSeed());
    expect(mockSet).not.toHaveBeenCalled(); // no writeback on a failed read
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toBe('getCollectionRandomSeed');
  });

  it('SLOW/half-open: get NEVER settles + deadline REJECTS → fails open to the hourly seed (fail-on-revert)', async () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getCollectionRandomSeed();

    expect(result).toBe(currentHourSeed());
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});
