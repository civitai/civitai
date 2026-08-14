import { describe, it, expect, vi, beforeEach } from 'vitest';

// purgeResizeCache tells the image-cache service to drop an image's derived variants. Three
// things about that call are easy to get wrong and impossible to see afterwards:
//
//  1. SCOPE. A hideMeta flip leaves the image LIVE, so it must clear only the variants derived
//     before the flip. The delete path must clear everything. Same function, opposite blast radius.
//  2. AUTH. The service requires a shared-secret header once its destructive mode is on, and
//     rejects the call without it.
//  3. `fetch` DOES NOT REJECT ON A NON-2xx. Every failure above lands in the success path, so a
//     401 from a stale secret would stop invalidation completely and log nothing at all.
//
// image.service is the graph root; the mock scaffold mirrors the established recipe
// (delete-image-from-s3-logging.test.ts): stub env + infra clients + the event-engine-common
// submodule so importing it boots no real infra.

// Mutable so a test can remove the secret without rebuilding the whole env mock.
const { envOverrides } = vi.hoisted(() => ({
  envOverrides: { IMAGE_CACHER_ADMIN_SECRET: 'test-shared-secret' as string | undefined },
}));

const { mockLogToAxiom, mockFindFirst, mockFetch } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(async () => undefined),
  mockFindFirst: vi.fn(),
  // Typed rather than inferred: a zero-arg `vi.fn` makes `mock.calls` the empty
  // tuple, and `invalidateCalls()` below reads both positions off it.
  mockFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<{ ok: boolean }>>(
    async () => ({ ok: true })
  ),
}));

function makePermissive(overrides: Record<string, unknown> = {}): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop in overrides) return overrides[prop as string];
      if (!(prop in target)) target[prop as string] = makePermissive();
      return target[prop as string];
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  // Callable target so the `apply` trap can fire; its body never runs.
  return new Proxy(function () {
    return undefined;
  }, handler);
}

const dbWrite = makePermissive({ image: makePermissive({ findFirst: mockFindFirst }) });
const dbRead = makePermissive();

vi.mock('~/server/db/client', () => ({ dbRead, dbWrite }));

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; a Proxy hands back safe defaults for whatever
// image.service reads at import time. DATABASE_IS_PROD gates deleteImageFromS3 entirely.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      LOGGING: [] as string[],
      DATABASE_IS_PROD: true,
      IMAGE_CACHER_URL: 'https://image-cacher.test',
      get IMAGE_CACHER_ADMIN_SECRET() {
        return envOverrides.IMAGE_CACHER_ADMIN_SECRET;
      },
    } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        if (
          typeof prop === 'string' &&
          /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
        )
          return 1;
        return undefined;
      },
    }
  ),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({ insert: async () => undefined }),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: makePermissive({ packed: makePermissive() }),
    sysRedis: makePermissive(),
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
  };
});

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: mockLogToAxiom,
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

const { purgeResizeCache } = await import('../image.service');

const invalidateCalls = () =>
  mockFetch.mock.calls.filter((call) => String(call[0]).includes('/admin/invalidate'));

const lastUrl = () => String(invalidateCalls().at(-1)?.[0] ?? '');
const lastInit = () => (invalidateCalls().at(-1)?.[1] ?? {}) as RequestInit;

const UUID = 'abc-def-0123';

describe('purgeResizeCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, status: 202 } as any);
    envOverrides.IMAGE_CACHER_ADMIN_SECRET = 'test-shared-secret';
  });

  describe('scope', () => {
    // The hideMeta flip re-keys the image, so the live variants are the ones derived AFTER it.
    // `keep=hm` is what tells the service to leave those alone.
    it('asks the service to keep the post-flip variants for a hideMeta purge', async () => {
      await purgeResizeCache({ url: UUID, scope: 'hidden-meta-orphans' });

      // The SEPARATOR is part of the contract. Without the leading '&' the URL becomes
      // `?imageKey=<uuid>keep=hm`: the key is corrupted AND keep is absent, so the service does a
      // FULL purge on a bogus key. `toContain('keep=hm')` passes on that string, and so does
      // `toContain('imageKey=<uuid>')` — both are substrings of the corrupted value.
      expect(lastUrl()).toContain(`imageKey=${UUID}&keep=hm`);
    });

    // The delete path must remove everything: the row is already gone.
    it('sends no scope for a full purge', async () => {
      await purgeResizeCache({ url: UUID, scope: 'all' });

      expect(lastUrl()).toContain(`imageKey=${UUID}`);
      expect(lastUrl()).not.toContain('keep=');
    });

    // Every pre-existing caller omits the argument, and must keep the behaviour it has today.
    it('defaults to the full purge when no scope is given', async () => {
      await purgeResizeCache({ url: UUID });

      expect(lastUrl()).not.toContain('keep=');
    });
  });

  describe('auth', () => {
    it('sends the shared secret when one is configured', async () => {
      await purgeResizeCache({ url: UUID });

      const headers = lastInit().headers as Record<string, string>;
      expect(headers['X-Admin-Secret']).toBe('test-shared-secret');
    });

    // 🔴 THE CLAIM THIS PR LEANS HARDEST ON, and it was the one thing nothing pinned. Dropping the
    // `if (env.IMAGE_CACHER_ADMIN_SECRET)` guard passes every other test here while sending the
    // literal header `X-Admin-Secret: undefined` — which the service compares constant-time and
    // rejects. The moment its delete flag flips that is a PERMANENT 401 with invalidation dead,
    // and (before the status check added in this same PR) it would have been silent.
    // The secret must not be able to ride a redirect. `fetch` strips Authorization and Cookie on a
    // cross-origin hop but forwards CUSTOM headers verbatim, so following a 30x would hand
    // X-Admin-Secret to wherever it pointed. Asserted because it is an init option no other test
    // inspects — without this the hardening is invisible to the suite.
    it('refuses to follow redirects while carrying the secret', async () => {
      await purgeResizeCache({ url: UUID });

      expect(lastInit().redirect).toBe('error');
    });

    it('still sends the request, with NO secret header, when none is configured', async () => {
      envOverrides.IMAGE_CACHER_ADMIN_SECRET = undefined;

      await purgeResizeCache({ url: UUID });

      // 🔴 ASSERT THE REQUEST HAPPENED FIRST. Both `lastInit()` and the `?? {}` below fall back to
      // an empty object, so ZERO fetch calls satisfied every header assertion here — meaning
      // "invalidation is skipped entirely when no secret is set", the exact INVERSE of what this
      // test claims, passed. That branch is the one running in production today: the secret is
      // not yet configured there, so the unsecured path is the live path.
      expect(invalidateCalls()).toHaveLength(1);

      const headers = (lastInit().headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty('X-Admin-Secret');
      // A dropped guard sets the key to the real `undefined` under this mock, which
      // toHaveProperty already catches. Kept as a cheap belt-and-braces against a variant that
      // stringifies it — but the assertion above is the one doing the work.
      expect(Object.values(headers)).not.toContain('undefined');
    });
  });

  describe('a non-2xx must not be silent', () => {
    // The whole point. `fetch` resolves for a 401, so without an explicit status check this
    // returns cleanly and invalidation dies without a single log line.
    it.each([
      [401, 'a rejected shared secret'],
      [409, 'a refusal'],
      [503, 'a partial failure'],
    ])('logs a %i (%s)', async (status) => {
      mockFetch.mockResolvedValue({ ok: false, status } as any);

      await purgeResizeCache({ url: UUID, scope: 'hidden-meta-orphans' });
      // The call is fire-and-forget; let its continuation run.
      await new Promise((r) => setTimeout(r, 0));

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'image-cacher-invalidate',
          status,
          scope: 'hidden-meta-orphans',
        })
      );
    });

    // POSITIVE CONTROL for the assertion above: with the same harness and a 2xx, nothing is
    // logged. Without this, a logger that fired unconditionally would satisfy every case above.
    it('stays quiet on success', async () => {
      await purgeResizeCache({ url: UUID });
      await new Promise((r) => setTimeout(r, 0));

      expect(mockLogToAxiom).not.toHaveBeenCalled();
    });

    it('still logs a thrown fetch (timeout / connection refused)', async () => {
      mockFetch.mockRejectedValue(new Error('timeout'));

      await purgeResizeCache({ url: UUID });
      await new Promise((r) => setTimeout(r, 0));

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'image-cacher-invalidate' })
      );
    });
  });
});
