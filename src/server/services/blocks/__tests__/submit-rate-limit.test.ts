import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  PUSH_REVIEW_RATE_LIMIT,
  SUBMIT_RATE_LIMIT,
  takePushReviewSlot,
  takeSubmitSlot,
} from '~/server/services/blocks/submit-rate-limit';

/**
 * The REAL rate-limit module against the canonical redis mock: the push-review window is counted
 * on the cache cluster client (behind the cluster cache guard), the bundle-submit window in
 * system Redis. Route tests mock this module wholesale, so this is the only place either store
 * choice runs.
 */

const PUSH_KEY = 'system:blocks:push-review-rate-limit';
const SUBMIT_KEY = 'system:blocks:submit-rate-limit';

type Client = 'redis' | 'sysRedis';

/** Per-client counters behind `multi().set(NX).incr().exec()`: a window moves only where taken. */
let counters: Record<Client, Map<string, number>>;

function installCounter(client: Client) {
  redisMock[client].multi.mockImplementation(() => {
    let key = '';
    const chain = {
      set: vi.fn((k: string) => {
        key = k;
        return chain;
      }),
      incr: vi.fn(() => chain),
      exec: vi.fn(async () => {
        const next = (counters[client].get(key) ?? 0) + 1;
        counters[client].set(key, next);
        return ['OK', next];
      }),
    };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  counters = { redis: new Map(), sysRedis: new Map() };
  installCounter('redis');
  installCounter('sysRedis');
  redisMock.redis.ttl.mockResolvedValue(1234);
  redisMock.sysRedis.ttl.mockResolvedValue(55);
});

describe('takePushReviewSlot — the push window on the cache cluster', () => {
  it('counts the push window on the cluster client and leaves system Redis untouched', async () => {
    expect(await takePushReviewSlot('slug:my-app')).toEqual({ ok: true });

    expect([...counters.redis.entries()]).toEqual([[`${PUSH_KEY}:slug:my-app`, 1]]);
    expect(counters.sysRedis.size).toBe(0);
    expect(calledHybridNodes(['sysRedis'])).toEqual([]);
  });

  it('a push past the max is limited, with retryAfter from the cluster TTL', async () => {
    for (let i = 0; i < PUSH_REVIEW_RATE_LIMIT.max; i++) {
      expect(await takePushReviewSlot('user:42')).toEqual({ ok: true });
    }
    expect(await takePushReviewSlot('user:42')).toEqual({ ok: false, retryAfterSeconds: 1234 });

    expect(redisMock.redis.ttl).toHaveBeenCalledWith(`${PUSH_KEY}:user:42`);
    expect(redisMock.redis.ttl).toHaveBeenCalledTimes(1);
    expect(calledHybridNodes(['sysRedis'])).toEqual([]);
  });

  it('a cluster failure leaves the limiter unavailable and fails open', async () => {
    redisMock.redis.multi.mockImplementation(() => {
      const chain = {
        set: vi.fn(() => chain),
        incr: vi.fn(() => chain),
        exec: vi.fn(async () => {
          throw new Error('cluster down');
        }),
      };
      return chain;
    });

    expect(await takePushReviewSlot('slug:my-app')).toEqual({ ok: true });
    expect(redisMock.redis.multi).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.ttl).not.toHaveBeenCalled();
    expect(calledHybridNodes(['sysRedis'])).toEqual([]);
  });
});

describe('takeSubmitSlot — the submit window stays in system Redis', () => {
  it('counts the submit window in system Redis and never on the cluster', async () => {
    expect(await takeSubmitSlot('key:9')).toEqual({ ok: true });

    expect([...counters.sysRedis.entries()]).toEqual([[`${SUBMIT_KEY}:key:9`, 1]]);
    expect(counters.redis.size).toBe(0);
    expect(redisMock.redis.multi).not.toHaveBeenCalled();
  });

  it('a submit past the max is limited, with retryAfter from the system Redis TTL', async () => {
    for (let i = 0; i < SUBMIT_RATE_LIMIT.max; i++) {
      expect(await takeSubmitSlot('user:7')).toEqual({ ok: true });
    }
    // `used`: the window's count with this refused submit, for the product meta's counts.
    expect(await takeSubmitSlot('user:7')).toEqual({
      ok: false,
      reason: 'limited',
      retryAfterSeconds: 55,
      used: 11,
    });

    expect(redisMock.sysRedis.ttl).toHaveBeenCalledWith(`${SUBMIT_KEY}:user:7`);
    expect(redisMock.redis.ttl).not.toHaveBeenCalled();
    expect(redisMock.redis.multi).not.toHaveBeenCalled();
  });

  it('a submit-store failure is a refusal (unavailable), not a pass', async () => {
    redisMock.sysRedis.multi.mockImplementation(() => {
      const chain = {
        set: vi.fn(() => chain),
        incr: vi.fn(() => chain),
        exec: vi.fn(async () => {
          throw new Error('sys down');
        }),
      };
      return chain;
    });

    expect(await takeSubmitSlot('key:9')).toEqual({ ok: false, reason: 'unavailable' });
    expect(redisMock.redis.multi).not.toHaveBeenCalled();
  });
});
