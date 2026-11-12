import { describe, it, expect, vi, beforeEach } from 'vitest';

// rate-limiting.createLimiter wraps a small set of sysRedis ops behind a download/
// generation/chat rate limiter. Two contracts matter operationally:
//   (a) it must FAIL OPEN on any sysRedis error/timeout (serve, don't throw / don't
//       block) — a wedged sys half-open otherwise 429/500s every download for the
//       pod's lifetime; and
//   (b) the happy-path counting/limit semantics must be unchanged after the
//       fan-out reduction (GET+TTL and INCRBY+HMGET batched into MULTI pipelines).
//
// We mock the redis client module so no real connection is constructed. The
// fail-open logger is mocked to assert it fires (and to keep Axiom out of the test).

// vi.mock factories are hoisted above the imports, so any value they reference must
// be created with vi.hoisted (also hoisted) — not a plain top-level const.
const { failOpenSpy, sysRedis } = vi.hoisted(() => ({
  failOpenSpy: vi.fn(),
  // Mock the sys redis client surface used by the limiter.
  sysRedis: {
    get: vi.fn(),
    set: vi.fn(),
    ttl: vi.fn(),
    exists: vi.fn(),
    incrBy: vi.fn(),
    hmGet: vi.fn(),
    del: vi.fn(),
    multi: vi.fn(),
  },
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: (...args: unknown[]) => failOpenSpy(...args),
}));

// withSysReadDeadline is the wall-clock guard; in tests we want it transparent so
// a rejecting mock propagates immediately (no real timer). Pass-through.
vi.mock('~/server/redis/sys-read-deadline', () => ({
  withSysReadDeadline: <T>(p: Promise<T>) => p,
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis,
  // The limiter imports these key-string types but they're type-only; the runtime
  // values are supplied by the test directly as plain strings.
  REDIS_SYS_KEYS: {},
}));

import { createLimiter } from '../rate-limiting';

// Build a chainable multi() mock whose exec() resolves to `results` (or rejects).
function makeMulti(execResult: unknown[] | Error) {
  const pipeline: any = {};
  for (const m of ['get', 'ttl', 'incrBy', 'hmGet', 'set', 'exists']) {
    pipeline[m] = vi.fn(() => pipeline);
  }
  pipeline.exec = vi.fn(() =>
    execResult instanceof Error ? Promise.reject(execResult) : Promise.resolve(execResult)
  );
  return pipeline;
}

beforeEach(() => {
  vi.clearAllMocks();
  sysRedis.set.mockResolvedValue(undefined);
});

function buildLimiter(fetchCount = vi.fn().mockResolvedValue(0)) {
  return {
    fetchCount,
    limiter: createLimiter({
      counterKey: 'download:count' as any,
      limitKey: 'download:limits' as any,
      fetchCount,
    }),
  };
}

describe('createLimiter — happy-path counting (semantics unchanged)', () => {
  it('hasExceededLimit: count <= limit → false (not exceeded)', async () => {
    // getCount → MULTI GET+TTL: count=5, ttl=3600 (valid)
    sysRedis.multi.mockReturnValueOnce(makeMulti(['5', 3600]));
    // getLimit → HMGET [userKey, default] → user limit 10
    sysRedis.hmGet.mockResolvedValueOnce(['10', '20']);

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
    expect(sysRedis.hmGet).toHaveBeenCalledWith('download:limits', ['42', 'authed']);
  });

  it('hasExceededLimit: count > limit → true (exceeded)', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(['25', 3600]));
    sysRedis.hmGet.mockResolvedValueOnce(['10', '20']);

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(true);
  });

  it('hasExceededLimit: limit of 0 (unlimited) → false even with a high count', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(['9999', 3600]));
    sysRedis.hmGet.mockResolvedValueOnce([null, null]); // → Number(undefined ?? undefined ?? 0) = 0

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
  });

  it('hasExceededLimit: missing count + fetchOnUnknown=false → undefined → false (no limit read)', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti([null, -2]));

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
    // getCount returned undefined → getLimit must NOT run
    expect(sysRedis.hmGet).not.toHaveBeenCalled();
  });

  it('getCount: value present but TTL < 0 → repopulates from fetchCount', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(['7', -1]));
    const fetchCount = vi.fn().mockResolvedValue(99);

    const { limiter } = buildLimiter(fetchCount);
    await expect(limiter.getCount('42')).resolves.toBe(99);
    expect(fetchCount).toHaveBeenCalledWith('42');
    expect(sysRedis.set).toHaveBeenCalledWith('download:count:42', 99, { EX: 60 * 60 });
  });

  it('increment: INCRBY result returned; sets limit-hit time when exceeded', async () => {
    sysRedis.exists.mockResolvedValueOnce(1); // key exists, no populate
    // MULTI: [incrBy → 11, hmGet → [10, 20]]  → limit 10, newCount 11 → exceeded
    sysRedis.multi.mockReturnValueOnce(makeMulti([11, ['10', '20']]));

    const { limiter } = buildLimiter();
    await expect(limiter.increment('42')).resolves.toBe(11);
    // setLimitHitTime → sysRedis.set on the limit key
    expect(sysRedis.set).toHaveBeenCalledWith(
      'download:limits:42',
      expect.any(Number),
      { EX: 60 * 60 }
    );
  });

  it('increment: does NOT set limit-hit time when under the limit', async () => {
    sysRedis.exists.mockResolvedValueOnce(1);
    sysRedis.multi.mockReturnValueOnce(makeMulti([3, ['10', '20']])); // newCount 3 < limit 10

    const { limiter } = buildLimiter();
    await expect(limiter.increment('42')).resolves.toBe(3);
    expect(sysRedis.set).not.toHaveBeenCalled();
  });
});

describe('createLimiter — fail-open on sysRedis error', () => {
  it('hasExceededLimit fails OPEN (returns false, logs) when the count read rejects', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(new Error('redis cluster command timed out')));

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
    expect(failOpenSpy).toHaveBeenCalledWith(
      'rate-limit-write-degraded',
      'createLimiter.hasExceededLimit',
      expect.any(Error),
      expect.objectContaining({ userKey: '42' })
    );
  });

  it('hasExceededLimit fails OPEN when the limit HMGET rejects', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(['5', 3600])); // getCount ok
    sysRedis.hmGet.mockRejectedValueOnce(new Error('sysRedis read timed out'));

    const { limiter } = buildLimiter();
    await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
    expect(failOpenSpy).toHaveBeenCalledTimes(1);
  });

  it('increment fails OPEN (returns the increment, logs, does not throw) when the pipeline rejects', async () => {
    sysRedis.exists.mockResolvedValueOnce(1);
    sysRedis.multi.mockReturnValueOnce(makeMulti(new Error('redis down')));

    const { limiter } = buildLimiter();
    await expect(limiter.increment('42', 1)).resolves.toBe(1);
    expect(failOpenSpy).toHaveBeenCalledWith(
      'rate-limit-write-degraded',
      'createLimiter.increment',
      expect.any(Error),
      expect.objectContaining({ userKey: '42' })
    );
    // crucially: it must NOT have thrown — a 500 here would break the download path
  });

  it('increment fails OPEN when the EXISTS read rejects', async () => {
    sysRedis.exists.mockRejectedValueOnce(new Error('sysRedis read timed out'));

    const { limiter } = buildLimiter();
    await expect(limiter.increment('42', 5)).resolves.toBe(5);
    expect(failOpenSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createLimiter — malformed MULTI reply fails OPEN WITH A LOG (M2: not a silent NaN-serve)', () => {
  // A MULTI exec() that returns an unexpected shape (future node-redis change, or
  // a typeMapping attached to the sys client) used to parse via Number(bad ?? 0) →
  // NaN/0 → `count > limit` always false → serve unlimited forever with NO
  // `rate-limit-write-degraded` log (limiter silently+permanently disabled). The
  // arity assertion must THROW so it routes into the logged fail-open instead.

  it.each<[string, unknown[] | null | undefined | Record<string, unknown>]>([
    ['short array (arity 1)', ['5']],
    ['long array (arity 3)', ['5', 3600, 'extra']],
    ['null exec', null],
    ['non-array object', { 0: '5', 1: 3600 }],
  ])(
    'hasExceededLimit: getCount MULTI returns %s → logged fail-open (serve), not silent NaN',
    async (_label, badShape) => {
      sysRedis.multi.mockReturnValueOnce(makeMulti(badShape as any));

      const { limiter } = buildLimiter();
      // Serves (false = not exceeded)…
      await expect(limiter.hasExceededLimit('42', 'authed')).resolves.toBe(false);
      // …but ONLY because the fail-open fired — NOT a silent NaN-serve.
      expect(failOpenSpy).toHaveBeenCalledTimes(1);
      expect(failOpenSpy).toHaveBeenCalledWith(
        'rate-limit-write-degraded',
        'createLimiter.hasExceededLimit',
        expect.any(Error),
        expect.objectContaining({ userKey: '42' })
      );
      // The limit HMGET must NOT have run — we never reached the NaN-compare.
      expect(sysRedis.hmGet).not.toHaveBeenCalled();
    }
  );

  it('increment: pipeline MULTI returns a malformed shape → logged fail-open (returns the increment)', async () => {
    sysRedis.exists.mockResolvedValueOnce(1);
    // arity-1 reply where 2 entries (INCRBY + HMGET) are expected
    sysRedis.multi.mockReturnValueOnce(makeMulti([11] as any));

    const { limiter } = buildLimiter();
    await expect(limiter.increment('42', 1)).resolves.toBe(1);
    expect(failOpenSpy).toHaveBeenCalledWith(
      'rate-limit-write-degraded',
      'createLimiter.increment',
      expect.any(Error),
      expect.objectContaining({ userKey: '42' })
    );
    // setLimitHitTime must NOT have run off a NaN newCount.
    expect(sysRedis.set).not.toHaveBeenCalledWith(
      'download:limits:42',
      expect.any(Number),
      expect.anything()
    );
  });
});

describe('createLimiter — public getCount fail-open (M1)', () => {
  it('getCount returns undefined + logs when the MULTI read rejects (does not throw)', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(new Error('sysRedis read timed out')));

    const { limiter } = buildLimiter();
    await expect(limiter.getCount('42')).resolves.toBeUndefined();
    expect(failOpenSpy).toHaveBeenCalledWith(
      'rate-limit-write-degraded',
      'createLimiter.getCount',
      expect.any(Error),
      expect.objectContaining({ userKey: '42' })
    );
  });

  it('getCount returns undefined + logs on a malformed MULTI reply (not a silent NaN)', async () => {
    sysRedis.multi.mockReturnValueOnce(makeMulti(['5'] as any)); // arity 1, expected 2

    const { limiter } = buildLimiter();
    await expect(limiter.getCount('42')).resolves.toBeUndefined();
    expect(failOpenSpy).toHaveBeenCalledTimes(1);
    expect(failOpenSpy).toHaveBeenCalledWith(
      'rate-limit-write-degraded',
      'createLimiter.getCount',
      expect.any(Error),
      expect.objectContaining({ userKey: '42' })
    );
  });
});
