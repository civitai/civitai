import { describe, it, expect, vi, beforeEach } from 'vitest';

// deleteImageFromS3 used to end in `catch (e) { /* do nothing */ }`. deleteImages removes the
// DB row before it runs, so a swallowed failure left a permanently public CDN object (urls are
// unsigned) that the system believed it had deleted, with nothing left to retry from. The
// account-deletion drain leans on that S3 delete being real, so the failure must be auditable.
//
// image.service is the graph root; the mock scaffold mirrors the established recipe
// (unblock-image-nsfwlevel-reset.test.ts): stub env + infra clients + the event-engine-common
// submodule so importing it boots no real infra.

const {
  mockLogToAxiom,
  mockFindFirst,
  mockFetch,
  mockB2Send,
  mockResolveMediaLocation,
  mockGetB2ImageS3Client,
} = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn(async () => undefined),
  mockFindFirst: vi.fn(),
  mockFetch: vi.fn(async () => ({ ok: true })),
  // Typed to take the command so `mock.calls[0][0].input` is assertable — an untyped `vi.fn()`
  // here gives `calls` an empty tuple type and the bucket/key assertions stop compiling.
  mockB2Send: vi.fn(async (command: { input: Record<string, unknown> }) => ({
    Key: command.input.Key,
  })),
  mockResolveMediaLocation: vi.fn(),
  // A vi.fn rather than a fixed arrow so a test can make the client CONSTRUCTOR throw — the real
  // one does exactly that when B2 credentials are absent, which is the case the removed
  // `env.S3_IMAGE_B2_ACCESS_KEY` guard used to swallow.
  mockGetB2ImageS3Client: vi.fn(),
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

// The S3 client and the registry are the two things this file is actually about, so both are
// mocked explicitly rather than left to fall out of the permissive scaffolding below.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getB2ImageS3Client: mockGetB2ImageS3Client,
}));

vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: mockResolveMediaLocation,
  registerMediaLocation: vi.fn(),
}));

// Real env validation throws in test; a Proxy hands back safe defaults for whatever
// image.service reads at import time. DATABASE_IS_PROD gates deleteImageFromS3 entirely.
//
// 🔴 S3_IMAGE_B2_BUCKET must be a REAL value here. The proxy's fallthrough returns undefined for
// any name it does not recognise, and the delete used to sit behind `env.S3_IMAGE_B2_ACCESS_KEY`
// — so before this fixture existed, every test in this file ran with BOTH delete branches
// unreachable and every "the delete throws" case actually threw at the db refcount query. The
// suite was green and covered the S3 call zero times.
//
// 🔴 And it must DIFFER from the code's own fallback (`?? 'civitai-media-uploads'`). Setting it to
// the same string makes "reads the env var" and "hardcodes the literal" byte-identical in every
// assertion — measured: with both set to 'civitai-media-uploads', replacing the whole expression
// with the bare literal passed all 11 tests. A fixture of default/matching values collapses
// distinct implementations into the same output.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      LOGGING: [] as string[],
      DATABASE_IS_PROD: true,
      IMAGE_CACHER_URL: 'https://image-cacher.test',
      S3_IMAGE_B2_BUCKET: 'test-b2-bucket',
      S3_IMAGE_B2_ACCESS_KEY: 'test-b2-key',
      S3_IMAGE_B2_SECRET_KEY: 'test-b2-secret',
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
    // Default to the registered case; the tests that care set their own.
    mockResolveMediaLocation.mockResolvedValue({ backend: 'backblaze', url: 'https://b2/x' });
    mockB2Send.mockResolvedValue({ Key: 'abc-def/original.jpeg' });
    mockGetB2ImageS3Client.mockReturnValue({ send: mockB2Send });
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

  // ── The delete itself. Everything above asserts around the S3 call; these assert the call. ──

  it('deletes the object from B2 when the resolver reports backblaze', async () => {
    mockFindFirst.mockResolvedValue(null);

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockB2Send).toHaveBeenCalledTimes(1);
    const command = mockB2Send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: 'test-b2-bucket',
      Key: 'abc-def/original.jpeg',
    });
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  // THE REGRESSION. `resolveMediaLocation` returns null for a 404, a service error AND a timeout,
  // and the code used to route that to a DigitalOcean bucket deleted 2026-05-18 — the delete threw
  // on the proxy's text/plain "404 page not found", the row was already gone, and the object stayed
  // publicly fetchable on an unsigned CDN url. 2,545 objects accumulated that way. An unregistered
  // image is still on B2; there is nowhere else for it to be.
  it('deletes the object from B2 when the resolver returns no location', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockResolveMediaLocation.mockResolvedValue(null);

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockB2Send).toHaveBeenCalledTimes(1);
    const command = mockB2Send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: 'test-b2-bucket',
      Key: 'abc-def/original.jpeg',
    });
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'delete-image-from-s3-failed' })
    );
  });

  // Deleting on a resolver miss is right, but it must not be silent: the miss is the tell for a
  // registry gap or a storage-resolver outage, and burying it is what kept this invisible.
  it('warns about the unresolved location without failing the delete', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockResolveMediaLocation.mockResolvedValue(null);

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'delete-image-from-s3-unresolved-location',
        imageId: 4242,
        url: 'abc-def/original.jpeg',
      })
    );
    expect(mockB2Send).toHaveBeenCalledTimes(1);
  });

  // Negative control for the warning above — a warning that fires on every delete is not a signal.
  it('stays silent when the resolver does have a location', async () => {
    mockFindFirst.mockResolvedValue(null);

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'delete-image-from-s3-unresolved-location' })
    );
  });

  // Positive control that the failure path is reached THROUGH the S3 call rather than through the
  // db refcount query above it — the distinction the rest of this file could not previously make.
  it('logs the failure and still invalidates when the B2 delete itself throws', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockB2Send.mockRejectedValue(new Error('b2 refused'));

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'delete-image-from-s3-failed',
        imageId: 4242,
        url: 'abc-def/original.jpeg',
      })
    );
    expect(invalidateCalls()).toHaveLength(1);
  });

  // This PR removed the `env.S3_IMAGE_B2_ACCESS_KEY` half of the old guard, so a deployment with
  // no B2 credentials now reaches getB2ImageS3Client(), which throws by design. That must be a
  // LOUD failure rather than the silent no-op the old `else if` produced when neither bucket var
  // was set — and the cache invalidation still has to run, because the object is still there.
  it('logs loudly when B2 credentials are missing instead of skipping silently', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockGetB2ImageS3Client.mockImplementation(() => {
      throw new Error('B2 image upload credentials not configured');
    });

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'delete-image-from-s3-failed',
        imageId: 4242,
      })
    );
    expect(mockB2Send).not.toHaveBeenCalled();
    expect(invalidateCalls()).toHaveLength(1);
  });

  // resolveMediaLocation is typed `| null` and callers are written as if it cannot throw, but a
  // `return res.json()` inside its try let a rejection escape that try entirely (a 200 carrying a
  // non-JSON body — an ingress error page — is exactly that). Reaching this delete through a
  // REJECTING resolver is the case that produced the very orphan this change exists to stop, so
  // the delete must survive it rather than be skipped by it.
  it('still deletes from B2 when the resolver rejects outright', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockResolveMediaLocation.mockRejectedValue(new Error('unexpected end of JSON input'));

    await deleteImageFromS3({ id: 4242, url: 'abc-def/original.jpeg' });

    expect(mockB2Send).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'delete-image-from-s3-failed' })
    );
    // Asserting the WARNING too, not just the delete. Without this the `.catch`'s return VALUE is
    // unpinned: swapping `() => null` for one that returns a location still passes every other
    // test here, and silently suppresses the one signal that a resolver outage is happening.
    // It must also carry the reason — routing the rejection here rather than to the outer catch
    // otherwise throws away the only record of why the resolver failed.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'delete-image-from-s3-unresolved-location',
        error: expect.anything(),
      })
    );
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
