import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-4 sysRedis soft-dependency sweep — the SSR/hot-path readers in
 * system-cache.ts.
 *
 * Both `getBrowsingSettingAddons` (SSR every-render via _app.tsx) and
 * `getCreationBlockedTags` (every model upsert) already try/catch fail-open;
 * the gap this PR closes is the missing wall-clock deadline. A fast sysRedis
 * DOWN rejects into the existing catch, but a silent SLOW/half-open parks the
 * awaited `sysRedis.get` ~11min on every render/upsert. Wrapping the get in
 * `withSysReadDeadline` makes the SLOW path reject (deadline) into the same
 * catch → fail open.
 *
 * The SLOW tests are fail-on-revert: `sysRedis.get` NEVER settles, so if the
 * `withSysReadDeadline(...)` wrap were removed the caller would hang and the
 * test would TIME OUT. A resolved-get mock would pass even without the wrap,
 * so it wouldn't guard the SLOW protection.
 *
 * NOTE: `getBrowsingSettingAddons` + `getLiveFeatureFlags` are fronted by a
 * MODULE-SCOPE in-proc TTL memo (createTtlMemo, added in #3183). That single
 * slot persists across tests within one module instance, so a prior happy-path
 * read would otherwise bleed its cached value into the DOWN/SLOW fail-open
 * assertions here. Each test therefore re-imports system-cache after
 * `vi.resetModules()` to start from a FRESH (empty) memo slate — the same
 * isolation pattern used by `system-cache.memoize.test.ts`. Because the source
 * default constants are re-evaluated on that fresh import, the fail-open
 * assertions compare with `toStrictEqual` (structural), not `toBe` (which would
 * demand cross-module-instance reference identity that resetModules precludes).
 */

const { mockGet, mockWithSysReadDeadline, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { get: mockGet },
  redis: { get: vi.fn(), set: vi.fn(), packed: { get: vi.fn(), set: vi.fn() } },
  REDIS_KEYS: { SYSTEM: {}, LIVE_NOW: 'live-now' },
  REDIS_SYS_KEYS: {
    SYSTEM: {
      BROWSING_SETTING_ADDONS: 'system:browsing-setting-addons',
      CREATION_BLOCKED_TAGS: 'system:creation-blocked-tags',
      LIVE_FEATURE_FLAGS: 'system:live-feature-flags',
    },
  },
  withSysReadDeadline: mockWithSysReadDeadline,
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// db/client pulls the Prisma factory graph — stub it (neither function under
// test touches the DB on these paths).
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import { DEFAULT_BROWSING_SETTINGS_ADDONS } from '~/shared/constants/browsing-settings-addons';
import { DEFAULT_LIVE_FEATURE_FLAGS } from '~/server/common/constants';

// Fresh module (fresh in-proc memos) per test — see file header note.
async function loadSystemCache() {
  vi.resetModules();
  return import('~/server/services/system-cache');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
});

describe('getBrowsingSettingAddons — sysRedis soft-dependency', () => {
  it('happy path: returns the parsed cached value through withSysReadDeadline, no fail-open', async () => {
    const { getBrowsingSettingAddons } = await loadSystemCache();
    const addons = [{ type: 'setting', nsfwLevels: [1], excludedFromDefaultBrowsingLevel: false }];
    mockGet.mockResolvedValue(JSON.stringify(addons));

    const result = await getBrowsingSettingAddons();

    expect(result).toEqual(addons);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: get throws → fails open to defaults, does not throw, logs read-degraded', async () => {
    const { getBrowsingSettingAddons } = await loadSystemCache();
    mockGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await getBrowsingSettingAddons();

    expect(result).toStrictEqual(DEFAULT_BROWSING_SETTINGS_ADDONS);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toBe('getBrowsingSettingAddons');
  });

  it('SLOW/half-open: get NEVER settles + deadline REJECTS → fails open (fail-on-revert)', async () => {
    const { getBrowsingSettingAddons } = await loadSystemCache();
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getBrowsingSettingAddons();

    expect(result).toStrictEqual(DEFAULT_BROWSING_SETTINGS_ADDONS);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

describe('getCreationBlockedTags — sysRedis soft-dependency (adjacent sibling)', () => {
  it('happy path: returns the parsed+filtered blocked tags through withSysReadDeadline, no fail-open', async () => {
    const { getCreationBlockedTags } = await loadSystemCache();
    const tags = [
      { id: 1, name: 'blocked-a' },
      { id: 2, name: 'blocked-b' },
    ];
    mockGet.mockResolvedValue(JSON.stringify(tags));

    const result = await getCreationBlockedTags();

    expect(result).toEqual(tags);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: get throws → fails open to empty list, does not throw, logs defaults-firing', async () => {
    const { getCreationBlockedTags } = await loadSystemCache();
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getCreationBlockedTags();

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('defaults-firing');
    expect(fn).toBe('getCreationBlockedTags');
  });

  it('SLOW/half-open: get NEVER settles + deadline REJECTS → fails open to empty (fail-on-revert)', async () => {
    const { getCreationBlockedTags } = await loadSystemCache();
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getCreationBlockedTags();

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('defaults-firing');
  });
});

// STEP-6: getLiveFeatureFlags is evaluated on the generation/feature-flag hot
// path. It already try/catch fail-opens to DEFAULT_LIVE_FEATURE_FLAGS; STEP-6
// adds the missing wall-clock deadline so a silent half-open rejects instead of
// parking ~11min.
describe('getLiveFeatureFlags — sysRedis soft-dependency (STEP-6)', () => {
  it('happy path: returns the parsed cached value through withSysReadDeadline, no fail-open', async () => {
    const { getLiveFeatureFlags } = await loadSystemCache();
    const flags = { ...DEFAULT_LIVE_FEATURE_FLAGS };
    mockGet.mockResolvedValue(JSON.stringify(flags));

    const result = await getLiveFeatureFlags();

    expect(result).toEqual(flags);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: get throws → fails open to defaults, does not throw, logs read-degraded', async () => {
    const { getLiveFeatureFlags } = await loadSystemCache();
    mockGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await getLiveFeatureFlags();

    expect(result).toStrictEqual(DEFAULT_LIVE_FEATURE_FLAGS);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toBe('getLiveFeatureFlags');
  });

  it('SLOW/half-open: get NEVER settles + deadline REJECTS → fails open to defaults (fail-on-revert)', async () => {
    const { getLiveFeatureFlags } = await loadSystemCache();
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await getLiveFeatureFlags();

    expect(result).toStrictEqual(DEFAULT_LIVE_FEATURE_FLAGS);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});
