import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLuaRedis, type LuaRedis } from '../../../../test/lua-sys-redis';

// The limiter's script runs for real, in Lua, through the main app's harness; only the cache redis
// handle (a process boundary) is replaced.
const h = vi.hoisted(() => ({ getRedis: vi.fn() }));
vi.mock('../../redis', () => ({ getRedis: h.getRedis }));

import { checkRateLimit, consumeRateLimit, rateLimitTtl } from '../rate-limit';

type Options = { keys: string[]; arguments: string[] };

// EVALSHA answers NOSCRIPT until an EVAL of the same body has run on this "node", as Redis does.
function scriptRedis(lua: LuaRedis) {
  const loaded = new Map<string, string>();
  return {
    eval: vi.fn(async (script: string, options: Options) => {
      loaded.set(createHash('sha1').update(script).digest('hex'), script);
      return lua.eval(script, options);
    }),
    evalSha: vi.fn(async (sha: string, options: Options) => {
      const script = loaded.get(sha);
      if (!script) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return lua.eval(script, options);
    }),
  };
}

const KEY = 'auth:rate-limit:login:ip-1';
let lua: LuaRedis;
let redis: ReturnType<typeof scriptRedis>;

beforeEach(() => {
  vi.clearAllMocks();
  lua = createLuaRedis(Date.now());
  redis = scriptRedis(lua);
  h.getRedis.mockReturnValue(redis);
});

describe('consumeRateLimit', () => {
  it('allows up to the limit, then refuses with the seconds left in the window', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeRateLimit('login', 'ip-1', 3, 90));
    expect(results).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false, retryAfter: 90 },
    ]);
  });

  it('sets the window on the first hit', async () => {
    await consumeRateLimit('login', 'ip-1', 5, 90);
    expect(lua.pttl(KEY)).toBe(90_000);
  });

  it('repairs a key that lost its expiry, which would otherwise lock the identifier out for good', async () => {
    lua.setString(KEY, '50'); // no TTL
    expect(lua.pttl(KEY)).toBe(-1);
    expect(await consumeRateLimit('login', 'ip-1', 5, 60)).toEqual({ ok: false, retryAfter: 60 });
    expect(lua.pttl(KEY)).toBe(60_000);
  });

  it('keeps an existing window rather than extending it', async () => {
    lua.setString(KEY, '9', 20_000);
    expect(await consumeRateLimit('login', 'ip-1', 5, 60)).toEqual({ ok: false, retryAfter: 20 });
    expect(lua.pttl(KEY)).toBe(20_000);
  });

  it('never answers a retryAfter below 1, though Redis rounds a last-moment TTL to 0', async () => {
    h.getRedis.mockReturnValue({ evalSha: async () => [6, 0], eval: async () => [6, 0] });
    expect(await consumeRateLimit('login', 'ip-1', 5, 60)).toEqual({ ok: false, retryAfter: 1 });
  });

  it('loads the script with EVAL once, then sends only its SHA', async () => {
    await consumeRateLimit('login', 'ip-1', 5, 60);
    await consumeRateLimit('login', 'ip-1', 5, 60);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.evalSha).toHaveBeenCalledTimes(2);
    expect(lua.string(KEY)).toBe('2');
  });

  it('counts per (bucket, identifier)', async () => {
    expect(await checkRateLimit('login', 'a', 1, 60)).toBe(true);
    expect(await checkRateLimit('login', 'a', 1, 60)).toBe(false);
    expect(await checkRateLimit('login', 'b', 1, 60)).toBe(true);
    expect(await checkRateLimit('signup', 'a', 1, 60)).toBe(true);
  });

  it('fails OPEN when redis errors (a blip must not lock users out)', async () => {
    h.getRedis.mockReturnValue({
      evalSha: async () => {
        throw new Error('connection reset');
      },
      eval: async () => {
        throw new Error('connection reset');
      },
    });
    expect(await consumeRateLimit('login', 'ip-1', 0, 60)).toEqual({ ok: true });
  });

  it('fails OPEN when redis is not configured', async () => {
    h.getRedis.mockReturnValue(null);
    expect(await consumeRateLimit('login', 'ip-1', 0, 60)).toEqual({ ok: true });
  });

  it('skips the limit when the identifier is empty, never one shared bucket', async () => {
    for (const id of [null, undefined, '']) {
      expect(await consumeRateLimit('login', id, 0, 60)).toEqual({ ok: true });
    }
    expect(redis.evalSha).not.toHaveBeenCalled();
  });
});

describe('rateLimitTtl', () => {
  it('answers the seconds left in a window', async () => {
    lua.setString(KEY, '3', 20_000);
    expect(await rateLimitTtl('login', 'ip-1', 60)).toBe(20);
  });

  it('repairs a key that lost its expiry, so a peek-only bucket cannot refuse forever', async () => {
    lua.setString(KEY, '50'); // no TTL
    expect(await rateLimitTtl('login', 'ip-1', 3600)).toBe(3600);
    expect(lua.pttl(KEY)).toBe(3_600_000);
  });

  it('answers null for no key, and when redis errors', async () => {
    expect(await rateLimitTtl('login', 'ip-1', 60)).toBeNull();
    h.getRedis.mockReturnValue({
      eval: async () => {
        throw new Error('connection reset');
      },
    });
    expect(await rateLimitTtl('login', 'ip-1', 60)).toBeNull();
  });
});
