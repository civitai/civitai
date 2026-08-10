import { describe, it, expect, vi, beforeEach } from 'vitest';

// deleteImageFromS3 used to end in `catch (e) { /* do nothing */ }`. deleteImages removes the
// DB row before it runs, so a swallowed failure left a permanently public CDN object (urls are
// unsigned) that the system believed it had deleted, with nothing left to retry from. The
// account-deletion drain leans on that S3 delete being real, so the failure must be auditable.
//
// image.service is the graph root; the mock scaffold mirrors the established recipe
// (unblock-image-nsfwlevel-reset.test.ts): stub env + infra clients + the event-engine-common
// submodule so importing it boots no real infra.

const { mockLogToAxiom, mockFindFirst, mockFetch } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(async () => undefined),
  mockFindFirst: vi.fn(),
  mockFetch: vi.fn(async () => ({ ok: true })),
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

const { deleteImageFromS3 } = await import('../image.service');

const invalidateCalls = () =>
  mockFetch.mock.calls.filter((call) => String(call[0]).includes('/admin/invalidate'));

describe('deleteImageFromS3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('logs the image id and url when the delete throws', async () => {
    mockFindFirst.mockRejectedValue(new Error('s3 timeout'));

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'delete-image-from-s3-failed',
        imageId: 4242,
        url: 'abc-def/original.jpeg',
      })
    );
  });

  it('stays quiet when the delete succeeds', async () => {
    // Another row shares the url, so the function returns before touching S3.
    mockFindFirst.mockResolvedValue({ id: 1 });

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  // Invalidation used to sit on the next line inside the same try, so a delete that threw
  // skipped it and the cache entry outlived the row it was derived from. Failure is exactly
  // when invalidation matters, so it has to survive the throw.
  it('still invalidates the CDN cache when the delete throws', async () => {
    mockFindFirst.mockRejectedValue(new Error('delete rejected'));

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(invalidateCalls()).toHaveLength(1);
    expect(String(invalidateCalls()[0][0])).toContain(encodeURIComponent('abc-def/original.jpeg'));
  });

  it('leaves the cache alone when another row still points at the url', async () => {
    mockFindFirst.mockResolvedValue({ id: 1 });

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(invalidateCalls()).toHaveLength(0);
  });

  // Legacy avatar rows store a full external URL rather than a bucket key. Passing one to
  // deleteObject as a Key can only fail, and it is not ours to delete either way.
  it('ignores rows whose url is an external link, before touching the db', async () => {
    await deleteImageFromS3({
      id: 4242,
      url: 'https://lh3.googleusercontent.com/a/AAcHTtf=s96-c',
    });

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockLogToAxiom).not.toHaveBeenCalled();
    expect(invalidateCalls()).toHaveLength(0);
  });

  // The guard above is safe only while no row holds a url for a bucket we own. Nothing enforces
  // that, so a first-party url reaching it has to be audible rather than a silent skip.
  it('flags a first-party url instead of skipping it silently', async () => {
    await deleteImageFromS3({ id: 4242, url: 'https://image.civitai.com/abc/original.jpeg' });

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'delete-image-from-s3-skipped-first-party-url',
        imageId: 4242,
      })
    );
  });
});
