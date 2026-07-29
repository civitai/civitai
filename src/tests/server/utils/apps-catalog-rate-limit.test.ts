import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the PUBLIC app-catalog rate limiter shared by
 * `GET /api/v1/apps` + `GET /api/v1/apps/{slug}`.
 *
 * Asserts:
 *   - per-user key (`u:<id>`) when a bearer resolved a user; client-IP fallback
 *     (`ip:<addr>`) otherwise.
 *   - under the 60/window limit → proceeds (returns false, no 429).
 *   - over the limit → 429 + Retry-After (returns true).
 *   - FAIL-OPEN (the deliberate divergence from the submissions limiter): a Redis
 *     throw OR a malformed exec result → PROCEEDS (returns false), never a 503.
 *   - self-heals a TTL-less counter key.
 */

const { mockSysRedis, mockMulti } = vi.hoisted(() => {
  const mockMulti = {
    value: 1 as number,
    malformedExec: false as unknown[] | null | false,
    throwExec: false,
    setKey: undefined as string | undefined,
  };
  const multiFactory = () => ({
    set: vi.fn((key: string) => {
      mockMulti.setKey = key;
      return multiChain;
    }),
    incr: vi.fn(() => multiChain),
    exec: vi.fn(async () => {
      if (mockMulti.throwExec) throw new Error('redis down');
      return mockMulti.malformedExec !== false
        ? mockMulti.malformedExec
        : ['OK', mockMulti.value];
    }),
  });
  let multiChain: ReturnType<typeof multiFactory>;
  const mockSysRedis = {
    multi: vi.fn(() => {
      multiChain = multiFactory();
      return multiChain;
    }),
    ttl: vi.fn().mockResolvedValue(60),
    expire: vi.fn().mockResolvedValue(1),
  };
  return { mockSysRedis, mockMulti };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { APPS_CATALOG_RATE_LIMIT: 'system:blocks:apps-catalog-rate-limit' } },
}));

import { enforceAppsCatalogRateLimit } from '~/server/utils/apps-catalog-rate-limit';

function makeReqRes(remoteAddress = '203.0.113.9') {
  const req = {
    headers: {},
    socket: { remoteAddress },
  } as never;
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    _status: () => statusCode,
    _headers: () => headers,
    _json: () => payload,
  } as never;
  return { req, res };
}

const MOD = { id: 7, isModerator: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockMulti.value = 1;
  mockMulti.malformedExec = false;
  mockMulti.throwExec = false;
  mockMulti.setKey = undefined;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockSysRedis.expire.mockResolvedValue(1);
});

describe('enforceAppsCatalogRateLimit', () => {
  it('uses a per-user key when a user is present and proceeds under the limit', async () => {
    const { req, res } = makeReqRes();
    const limited = await enforceAppsCatalogRateLimit({ req, res, user: MOD });
    expect(limited).toBe(false);
    expect(mockMulti.setKey).toBe('system:blocks:apps-catalog-rate-limit:u:7');
    expect((res as { _status: () => number })._status()).toBe(200); // untouched
  });

  it('falls back to a client-IP key for an anonymous caller', async () => {
    const { req, res } = makeReqRes('198.51.100.4');
    const limited = await enforceAppsCatalogRateLimit({ req, res, user: undefined });
    expect(limited).toBe(false);
    expect(mockMulti.setKey).toBe('system:blocks:apps-catalog-rate-limit:ip:198.51.100.4');
  });

  it('429 + Retry-After when the window is exceeded', async () => {
    mockMulti.value = 61; // > 60
    const { req, res } = makeReqRes();
    const limited = await enforceAppsCatalogRateLimit({ req, res, user: MOD });
    expect(limited).toBe(true);
    expect((res as { _status: () => number })._status()).toBe(429);
    expect((res as { _headers: () => Record<string, string> })._headers()['Retry-After']).toBeDefined();
  });

  it('FAILS OPEN (proceeds, no 503) when the limiter exec throws — public-read divergence', async () => {
    mockMulti.throwExec = true;
    const warn = vi.fn();
    const { req, res } = makeReqRes();
    const limited = await enforceAppsCatalogRateLimit({ req, res, user: MOD, log: { warn } });
    expect(limited).toBe(false);
    expect((res as { _status: () => number })._status()).toBe(200); // never 503
    expect(warn).toHaveBeenCalled();
  });

  it('FAILS OPEN when the exec result is malformed', async () => {
    mockMulti.malformedExec = null;
    const { req, res } = makeReqRes();
    const limited = await enforceAppsCatalogRateLimit({ req, res, user: MOD });
    expect(limited).toBe(false);
    expect((res as { _status: () => number })._status()).toBe(200);
  });

  it('self-heals a TTL-less counter key (re-arms expiry when ttl < 0)', async () => {
    mockMulti.value = 2; // not first hit → self-heal branch
    mockSysRedis.ttl.mockResolvedValueOnce(-1);
    const { req, res } = makeReqRes();
    await enforceAppsCatalogRateLimit({ req, res, user: MOD });
    expect(mockSysRedis.expire).toHaveBeenCalledWith(
      'system:blocks:apps-catalog-rate-limit:u:7',
      60
    );
  });
});
