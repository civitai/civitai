import { describe, it, expect, vi, beforeEach } from 'vitest';

// `checkRateLimit` reaches for the cache redis via `../redis`. Mock that module so each test can
// inject a fake redis (or null) — the unit under test (the window math + fail-open) stays real.
const h = vi.hoisted(() => ({ getRedis: vi.fn() }));
vi.mock('../../redis', () => ({ getRedis: h.getRedis }));

import { checkRateLimit } from '../rate-limit';

// Minimal in-memory fixed-window redis: INCR a counter, EXPIRE is a no-op (we only assert counting).
function makeRedis() {
  const counts = new Map<string, number>();
  return {
    _counts: counts,
    incr: vi.fn(async (k: string) => {
      const next = (counts.get(k) ?? 0) + 1;
      counts.set(k, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('checkRateLimit', () => {
  it('allows requests up to and including the limit, then blocks', async () => {
    const redis = makeRedis();
    h.getRedis.mockReturnValue(redis);
    // limit=3 → first 3 calls allowed (current 1,2,3 ≤ 3), 4th blocked.
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit('login', 'ip-1', 3, 60));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('counts per (bucket, identifier) — independent windows', async () => {
    const redis = makeRedis();
    h.getRedis.mockReturnValue(redis);
    expect(await checkRateLimit('login', 'a', 1, 60)).toBe(true);
    expect(await checkRateLimit('login', 'a', 1, 60)).toBe(false); // a exhausted
    expect(await checkRateLimit('login', 'b', 1, 60)).toBe(true); // b fresh
    expect(await checkRateLimit('signup', 'a', 1, 60)).toBe(true); // different bucket, fresh
    // keys are namespaced auth:rate-limit:<bucket>:<id>
    expect(redis._counts.get('auth:rate-limit:login:a')).toBe(2);
    expect(redis._counts.get('auth:rate-limit:login:b')).toBe(1);
    expect(redis._counts.get('auth:rate-limit:signup:a')).toBe(1);
  });

  it('sets the TTL only on the first hit of a window (current === 1)', async () => {
    const redis = makeRedis();
    h.getRedis.mockReturnValue(redis);
    await checkRateLimit('login', 'ip-1', 5, 90);
    await checkRateLimit('login', 'ip-1', 5, 90);
    await checkRateLimit('login', 'ip-1', 5, 90);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('auth:rate-limit:login:ip-1', 90);
  });

  it('a limit of 0 blocks the very first request', async () => {
    const redis = makeRedis();
    h.getRedis.mockReturnValue(redis);
    expect(await checkRateLimit('login', 'ip-1', 0, 60)).toBe(false);
  });

  it('fails OPEN when redis is not configured (null)', async () => {
    h.getRedis.mockReturnValue(null);
    expect(await checkRateLimit('login', 'ip-1', 1, 60)).toBe(true);
    expect(await checkRateLimit('login', 'ip-1', 1, 60)).toBe(true); // never blocks
  });

  it('fails OPEN when redis throws (a blip must not lock users out)', async () => {
    const redis = makeRedis();
    redis.incr.mockRejectedValue(new Error('connection reset'));
    h.getRedis.mockReturnValue(redis);
    expect(await checkRateLimit('login', 'ip-1', 1, 60)).toBe(true);
  });
});
