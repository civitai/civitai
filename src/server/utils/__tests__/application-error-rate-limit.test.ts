import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * Unit coverage for the per-IP limiter on the UNAUTHENTICATED client-error
 * report endpoint (`POST /api/application-error`).
 *
 * The contracts that matter, in the order the module's own reasoning puts them:
 *   (a) the counter is PER ADDRESS — two addresses have independent budgets, and
 *       one exhausting its own does not touch the other's;
 *   (b) the ceiling is enforced (at the limit allowed, one past it refused with
 *       a sane Retry-After);
 *   (c) the derivation is `getTrustedClientIp`, so a bucket cannot be chosen by
 *       the caller with an uncorroborated header;
 *   (d) a redis failure FAILS OPEN, because the signal this endpoint carries
 *       must not be deleted by an outage of the limiter's own dependency;
 *   (e) the sizing invariant — one address alone cannot reach the rate that
 *       means "many people are affected".
 *
 * 🔴 The counter here is a REAL in-memory counter keyed on the key the module
 * actually builds, not a per-call stub. A stub that returns a scripted sequence
 * cannot distinguish "two addresses have separate budgets" from "the limiter
 * ignores the address entirely and I scripted two different answers" — the
 * per-IP property would pass with the address dropped from the key. Keying the
 * fake store on the real key string is what makes (a) a test of the code.
 *
 * `~/server/redis/client` is mocked globally by the worker setup; this file
 * drives that canonical mock rather than declaring its own.
 */

import {
  checkApplicationErrorRateLimit,
  APPLICATION_ERROR_RATE_LIMIT_MAX,
  APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND,
  APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS,
} from '../application-error-rate-limit';
import { getTrustedClientIp } from '../client-ip';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockSysRedis = redisMock.sysRedis;

const KEY_PREFIX = 'system:client-error:rate-limit:ip:';

/**
 * The rate, in accepted reports per second, at which the endpoint's volume is
 * read as "many people are affected".
 *
 * Written here as an independent literal rather than imported, deliberately: the
 * point of the invariant below is that the limit is small ENOUGH relative to
 * this, and deriving both sides from one constant would make that comparison
 * trivially true no matter what either number became.
 */
const MANY_USERS_RATE_PER_SECOND = 5;

/** Fresh per test — an in-memory stand-in for the fixed-window counter. */
let store: Map<string, { count: number; ttl: number }>;

function installCounter() {
  store = new Map();

  mockSysRedis.multi.mockImplementation(() => {
    let key: string | undefined;
    const chain = {
      set(k: string, _v: string, opts: { NX?: boolean; EX?: number }) {
        key = k;
        // `SET NX EX` — creates the key WITH its TTL only when absent.
        if (opts?.NX && !store.has(k)) store.set(k, { count: 0, ttl: opts.EX ?? -1 });
        return chain;
      },
      incr(k: string) {
        key = k;
        return chain;
      },
      async exec() {
        const entry = store.get(key as string);
        if (!entry) return ['OK', null];
        entry.count += 1;
        return ['OK', entry.count];
      },
    };
    return chain;
  });

  mockSysRedis.ttl.mockImplementation(async (k: string) => store.get(k)?.ttl ?? -2);
  mockSysRedis.expire.mockImplementation(async (k: string, seconds: number) => {
    const entry = store.get(k);
    if (entry) entry.ttl = seconds;
    return true;
  });
}

/** An EDGE-ATTESTED request from `ip` — `cf-connecting-ip` alongside `cf-ray`. */
function edgeRequest(ip: string, extraHeaders: Record<string, string> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: { 'cf-ray': '8a1b2c3d4e5f6789-IAD', 'cf-connecting-ip': ip, ...extraHeaders },
    socket: { remoteAddress: '10.42.0.9' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  installCounter();
});

describe('application-error rate limit — harness self-checks', () => {
  it('POSITIVE CONTROL: the fake counter is reached and actually counts', async () => {
    // Without this, every "allowed" below is indistinguishable from a limiter
    // whose redis call threw and fell open — a reassuring pass that measures the
    // catch block rather than the ceiling.
    expect(store.size).toBe(0);
    await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'));
    expect(store.size).toBe(1);
    expect(store.get(`${KEY_PREFIX}203.0.113.7`)).toMatchObject({
      count: 1,
      ttl: APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('NEGATIVE CONTROL: the harness can produce a REFUSAL, so a pass is a result', async () => {
    const req = edgeRequest('203.0.113.7');
    for (let i = 0; i < APPLICATION_ERROR_RATE_LIMIT_MAX; i++) {
      expect(await checkApplicationErrorRateLimit(req)).toEqual({ allowed: true });
    }
    expect(await checkApplicationErrorRateLimit(req)).toMatchObject({ allowed: false });
  });
});

describe('application-error rate limit — the ceiling', () => {
  it('creates the window WITH its TTL on the first hit', async () => {
    await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'));
    expect(store.get(`${KEY_PREFIX}203.0.113.7`)?.ttl).toBe(
      APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('allows every request UP TO AND INCLUDING the limit', async () => {
    const req = edgeRequest('203.0.113.7');
    for (let i = 1; i <= APPLICATION_ERROR_RATE_LIMIT_MAX; i++) {
      expect(await checkApplicationErrorRateLimit(req)).toEqual({ allowed: true });
    }
    expect(store.get(`${KEY_PREFIX}203.0.113.7`)?.count).toBe(APPLICATION_ERROR_RATE_LIMIT_MAX);
  });

  it('refuses the request one PAST the limit, with Retry-After from the live TTL', async () => {
    const req = edgeRequest('203.0.113.7');
    for (let i = 0; i < APPLICATION_ERROR_RATE_LIMIT_MAX; i++) {
      await checkApplicationErrorRateLimit(req);
    }
    // Shorten the remaining window so the assertion cannot pass by coincidence
    // with the full-window fallback.
    const entry = store.get(`${KEY_PREFIX}203.0.113.7`);
    if (entry) entry.ttl = 4;

    expect(await checkApplicationErrorRateLimit(req)).toEqual({
      allowed: false,
      retryAfterSeconds: 4,
    });
  });

  it('falls back to the full window when the TTL is unset/expired at refusal time', async () => {
    const req = edgeRequest('203.0.113.7');
    for (let i = 0; i < APPLICATION_ERROR_RATE_LIMIT_MAX; i++) {
      await checkApplicationErrorRateLimit(req);
    }
    mockSysRedis.ttl.mockResolvedValue(-2); // key reported as gone

    expect(await checkApplicationErrorRateLimit(req)).toEqual({
      allowed: false,
      retryAfterSeconds: APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('does NOT extend a live window on a subsequent hit', async () => {
    // An unconditional re-arm would let a steady stream hold one window open
    // forever, which silently converts the fixed window into a permanent one.
    const req = edgeRequest('203.0.113.7');
    await checkApplicationErrorRateLimit(req);
    const entry = store.get(`${KEY_PREFIX}203.0.113.7`);
    if (entry) entry.ttl = 7; // live window, partway through
    await checkApplicationErrorRateLimit(req);
    expect(store.get(`${KEY_PREFIX}203.0.113.7`)?.ttl).toBe(7);
    expect(mockSysRedis.expire).not.toHaveBeenCalled();
  });

  it('re-arms a LOST TTL on a subsequent hit', async () => {
    const req = edgeRequest('203.0.113.7');
    await checkApplicationErrorRateLimit(req);
    const entry = store.get(`${KEY_PREFIX}203.0.113.7`);
    if (entry) entry.ttl = -1; // TTL lost
    await checkApplicationErrorRateLimit(req);
    expect(mockSysRedis.expire).toHaveBeenCalledWith(
      `${KEY_PREFIX}203.0.113.7`,
      APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS
    );
    expect(store.get(`${KEY_PREFIX}203.0.113.7`)?.ttl).toBe(
      APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS
    );
  });
});

describe('application-error rate limit — the budget is PER ADDRESS', () => {
  it('one address exhausting its budget leaves another address untouched', async () => {
    const noisy = edgeRequest('203.0.113.7');
    const bystander = edgeRequest('198.51.100.4');

    for (let i = 0; i <= APPLICATION_ERROR_RATE_LIMIT_MAX; i++) {
      await checkApplicationErrorRateLimit(noisy);
    }
    expect(await checkApplicationErrorRateLimit(noisy)).toMatchObject({ allowed: false });

    // The bystander's very first report still gets through — the whole point of
    // a per-IP limit rather than a global one.
    expect(await checkApplicationErrorRateLimit(bystander)).toEqual({ allowed: true });
    expect(store.get(`${KEY_PREFIX}198.51.100.4`)?.count).toBe(1);
  });

  it('two addresses accumulate in two SEPARATE counters', async () => {
    await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'));
    await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'));
    await checkApplicationErrorRateLimit(edgeRequest('198.51.100.4'));

    expect(store.get(`${KEY_PREFIX}203.0.113.7`)?.count).toBe(2);
    expect(store.get(`${KEY_PREFIX}198.51.100.4`)?.count).toBe(1);
    expect(store.size).toBe(2);
  });

  it('a genuine multi-user incident still gets through: N addresses each keep a full budget', async () => {
    // The refutation of "the limit suppresses a real incident". Eleven distinct
    // addresses is the number it takes to reach the many-users rate; each of them
    // is nowhere near its own ceiling.
    const addresses = Array.from({ length: 11 }, (_, i) => `203.0.113.${i + 1}`);
    for (const ip of addresses) {
      for (let i = 0; i < 5; i++) {
        expect(await checkApplicationErrorRateLimit(edgeRequest(ip))).toEqual({ allowed: true });
      }
    }
    expect(store.size).toBe(11);
    for (const ip of addresses) expect(store.get(`${KEY_PREFIX}${ip}`)?.count).toBe(5);
  });
});

describe('application-error rate limit — which address the bucket is keyed on', () => {
  it('uses the SHARED trusted derivation, on every fixture', async () => {
    const FIXTURES: ReadonlyArray<readonly [string, NextApiRequest, string]> = [
      ['edge-attested', edgeRequest('203.0.113.7'), '203.0.113.7'],
      [
        'an uncorroborated cf-connecting-ip falls back to the transport peer',
        {
          method: 'POST',
          headers: { 'cf-connecting-ip': '203.0.113.99' },
          socket: { remoteAddress: '10.42.0.9' },
        } as unknown as NextApiRequest,
        '10.42.0.9',
      ],
      [
        'x-forwarded-for is NOT consulted',
        {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.50' },
          socket: { remoteAddress: '10.42.0.9' },
        } as unknown as NextApiRequest,
        '10.42.0.9',
      ],
      [
        'nothing resolvable at all → the single shared label',
        { method: 'POST', headers: {}, socket: {} } as unknown as NextApiRequest,
        'unknown',
      ],
    ];

    for (const [, req, expected] of FIXTURES) {
      store.clear();
      await checkApplicationErrorRateLimit(req);
      // (a) the key the module actually wrote
      expect([...store.keys()]).toEqual([`${KEY_PREFIX}${expected}`]);
      // (b) and the shared derivation's own answer for the same request, so this
      //     pins the RELATIONSHIP rather than a second copy of the rule.
      expect(`${KEY_PREFIX}${getTrustedClientIp(req) ?? 'unknown'}`).toBe([...store.keys()][0]);
    }
  });

  it('a caller cannot rotate to a fresh budget by varying an uncorroborated header', async () => {
    // The property that makes the limit bind at all. Three requests off one
    // socket, each declaring a different address with no edge corroboration,
    // land in ONE bucket — not three.
    for (const declared of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await checkApplicationErrorRateLimit({
        method: 'POST',
        headers: { 'cf-connecting-ip': declared, 'x-forwarded-for': declared },
        socket: { remoteAddress: '10.42.0.9' },
      } as unknown as NextApiRequest);
    }
    expect(store.size).toBe(1);
    expect(store.get(`${KEY_PREFIX}10.42.0.9`)?.count).toBe(3);
  });
});

describe('application-error rate limit — fail open', () => {
  it('a redis error serves the request', async () => {
    mockSysRedis.multi.mockImplementation(() => {
      throw new Error('redis down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'))).toEqual({
      allowed: true,
    });
    // The fail-open is OBSERVABLE, not silent — a limiter that has stopped
    // limiting must be distinguishable from one that is working.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an exec rejection serves the request', async () => {
    mockSysRedis.multi.mockImplementation(() => {
      const chain = {
        set: () => chain,
        incr: () => chain,
        exec: async () => {
          throw new Error('redis down');
        },
      };
      return chain;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'))).toEqual({
      allowed: true,
    });
    warn.mockRestore();
  });

  it('a malformed counter serves the request', async () => {
    mockSysRedis.multi.mockImplementation(() => {
      const chain = {
        set: () => chain,
        incr: () => chain,
        exec: async () => ['OK', 'not-a-number'],
      };
      return chain;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await checkApplicationErrorRateLimit(edgeRequest('203.0.113.7'))).toEqual({
      allowed: true,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('application-error rate limit — the sizing invariant', () => {
  it('one address CANNOT, alone, reach the many-users rate', async () => {
    // The reason the control is worth having. Restating the chosen numbers would
    // assert nothing; this asserts the RELATIONSHIP between the ceiling and the
    // rate that means "many people are affected".
    expect(APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND).toBeLessThan(
      MANY_USERS_RATE_PER_SECOND
    );
    // And not merely below it — an order of magnitude below, so it takes at
    // least ten distinct addresses rather than two.
    expect(APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND * 10).toBeLessThanOrEqual(
      MANY_USERS_RATE_PER_SECOND
    );
  });

  it('but is generous enough that ordinary traffic never touches it', async () => {
    // The opposite failure — a limit so tight it deletes the reports the endpoint
    // exists to collect. The busiest single sample observed for the WHOLE
    // endpoint, across every client, is ~0.4 reports/second; one address alone is
    // granted more than that.
    const BUSIEST_OBSERVED_WHOLE_ENDPOINT_PER_SECOND = 0.4;
    expect(APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND).toBeGreaterThan(
      BUSIEST_OBSERVED_WHOLE_ENDPOINT_PER_SECOND
    );
  });

  it('derives the sustained rate from the two constants rather than restating it', () => {
    expect(APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND).toBe(
      APPLICATION_ERROR_RATE_LIMIT_MAX / APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS
    );
  });
});
