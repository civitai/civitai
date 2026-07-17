import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the redis + db layers so we can assert how often the underlying redis
// GET actually fires for the memoized global blobs. Defined via vi.hoisted so
// the references are available inside the hoisted vi.mock factory below.
//
// NOTE: the wired getters use MODULE-SCOPE memos that capture `Date.now` at load
// time, so a test can't drive their real (30s/5s) TTL expiry with fake timers.
// TTL-EXPIRY is therefore covered deterministically (injected clock) in
// utils/__tests__/ttl-memoize.test.ts. Here we cover the wiring: same-call
// COLLAPSE within the TTL, per-key isolation, and FAIL-OPEN (a rejected read is
// never cached, so the next call retries). Each test re-imports the module after
// vi.resetModules() so it starts from a FRESH (empty) memo slate.
const { packedGet, packedSet, redisGet, redisSet, queryRaw, tagFindMany } = vi.hoisted(() => ({
  packedGet: vi.fn(),
  packedSet: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  queryRaw: vi.fn(),
  tagFindMany: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: packedGet, set: packedSet },
    get: redisGet,
    set: redisSet,
  },
  sysRedis: { get: vi.fn(), set: vi.fn() },
  withSysReadDeadline: (p: Promise<unknown>) => p,
  REDIS_KEYS: {
    SYSTEM: {
      MODERATED_TAGS: 'system:moderated-tags',
      TAG_RULES: 'system:tag-rules',
      SYSTEM_TAGS: 'system:system-tags',
      CATEGORIES: 'system:categories',
    },
    LIVE_NOW: 'live-now',
  },
  REDIS_SYS_KEYS: { SYSTEM: {}, CLIENT: 'client' },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { tag: { findMany: vi.fn() }, tagsOnTags: { findMany: vi.fn() } },
  dbWrite: { tag: { findMany: tagFindMany }, $queryRaw: queryRaw },
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

// Fresh module (fresh memos) per test.
async function loadSystemCache() {
  vi.resetModules();
  return import('../system-cache');
}

describe('system-cache in-proc memoize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getModeratedTags hits redis once, then serves subsequent calls from the in-proc memo', async () => {
    const { getModeratedTags } = await loadSystemCache();
    const blob = [{ id: 1, name: 'tag', nsfwLevel: 4 }];
    packedGet.mockResolvedValue(blob);

    const first = await getModeratedTags();
    const second = await getModeratedTags();
    const third = await getModeratedTags();

    expect(first).toEqual(blob);
    expect(second).toEqual(blob);
    expect(third).toEqual(blob);
    // Within the in-proc TTL all three calls collapse to a single redis GET.
    expect(packedGet).toHaveBeenCalledTimes(1);
  });

  it('getTagRules collapses repeated calls to a single redis GET within the TTL', async () => {
    const { getTagRules } = await loadSystemCache();
    const rules = [{ fromId: 1, toId: 2, fromTag: 'a', toTag: 'b', type: 'Replace' }];
    redisGet.mockResolvedValue(JSON.stringify(rules));

    const a = await getTagRules();
    const b = await getTagRules();

    expect(a).toEqual(rules);
    expect(b).toEqual(rules);
    expect(redisGet).toHaveBeenCalledTimes(1);
    // A redis HIT must never touch the DB fallback.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('getSystemTags collapses repeated calls to a single redis GET within the TTL', async () => {
    const { getSystemTags } = await loadSystemCache();
    const tags = [{ id: 7, name: 'image category' }];
    redisGet.mockResolvedValue(JSON.stringify(tags));

    expect(await getSystemTags()).toEqual(tags);
    expect(await getSystemTags()).toEqual(tags);
    expect(redisGet).toHaveBeenCalledTimes(1);
    expect(tagFindMany).not.toHaveBeenCalled();
  });

  it('getLiveNow collapses repeated calls to a single redis GET within the TTL', async () => {
    const { getLiveNow } = await loadSystemCache();
    redisGet.mockResolvedValue('true');

    expect(await getLiveNow()).toBe(true);
    expect(await getLiveNow()).toBe(true);
    expect(redisGet).toHaveBeenCalledTimes(1);
  });

  it('getCategoryTags memoizes per type independently', async () => {
    const { getCategoryTags } = await loadSystemCache();
    // Redis hit path: return a JSON array so the getter never touches the DB.
    redisGet.mockImplementation(async (key: string) =>
      JSON.stringify([{ id: 1, name: `${key}` }])
    );

    await getCategoryTags('image');
    await getCategoryTags('image'); // collapsed for 'image'
    await getCategoryTags('model'); // separate slot for 'model'

    // 1 GET for 'image' (second collapsed) + 1 GET for 'model' = 2 total.
    expect(redisGet).toHaveBeenCalledTimes(2);
  });

  it('getTagRules is fail-open: a rejected redis read is not cached and the next call retries', async () => {
    const { getTagRules } = await loadSystemCache();
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    await expect(getTagRules()).rejects.toThrow('redis down');

    // The rejection was not memoized — the very next call re-reads redis.
    const rules = [{ fromId: 3, toId: 4, fromTag: 'c', toTag: 'd', type: 'Append' }];
    redisGet.mockResolvedValue(JSON.stringify(rules));
    expect(await getTagRules()).toEqual(rules);
    expect(redisGet).toHaveBeenCalledTimes(2);
  });
});
