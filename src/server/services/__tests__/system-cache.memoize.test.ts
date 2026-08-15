import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

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
const tagFindMany = dbMock.dbWrite.tag.findMany;
const queryRaw = dbMock.dbWrite.$queryRaw;

const packedGet = redisMock.redis.packed.get;
const packedSet = redisMock.redis.packed.set;
const redisGet = redisMock.redis.get;
const redisSet = redisMock.redis.set;

// Pass-through, not the canonical default. The default is the REAL deadline wrapper, which
// races these reads against a wall-clock timeout the mocked client cannot lose on its own —
// and what this file measures is how often a read fires, not whether it beat a clock.
redisMock.withSysReadDeadline.mockImplementation((p: Promise<unknown>) => p);

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
    redisGet.mockImplementation(async (key: string) => JSON.stringify([{ id: 1, name: `${key}` }]));

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
