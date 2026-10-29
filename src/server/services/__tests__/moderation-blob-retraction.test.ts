import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as ImageUrlOwnership from '~/server/services/image-url-ownership';

const mockLogToAxiom = loggingMock.logToAxiom;

// The image-cache service's invalidate endpoint can also retract an image's public copies: delete
// them and purge them from the CDN. That is a takedown, not a cache bust. The service gates it
// behind one exact query parameter and refuses to do it otherwise.
//
// This file is the guard on WHO may ask for that. The central claim, and the reason the file
// exists, is the NEGATIVE one:
//
//   🔴 An ordinary user-initiated delete must NEVER ask for retraction.
//
// A user deleting their own picture, a replaced avatar being reaped, an article's cover being
// cleaned up — none of those are a takedown, and none of them may reach another account's bytes.
// Only a moderation takedown may, and only by saying so explicitly at every layer.
//
// Every "does not ask for retraction" assertion below is preceded by an assertion that the
// invalidate call HAPPENED. Without it, a code path that throws before ever calling the service
// satisfies the negative assertion perfectly, and the guard reads green while covering nothing.
//
// image.service is the graph root; the mock scaffold mirrors the established recipe
// (delete-image-from-s3-logging.test.ts): stub the infra clients and the event-engine-common
// submodule so importing it boots no real infra. Env comes from the canonical mock.

const mockShopArtworkUrls = vi.hoisted(() => vi.fn(async (_urls: string[]) => new Set<string>()));

const { mockFetch, mockB2Send, mockResolveMediaLocation, mockGetB2ImageS3Client } = vi.hoisted(
  () => ({
    mockFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<{ ok: boolean }>>(
      async () => ({ ok: true })
    ),
    mockB2Send: vi.fn(async (command: { input: Record<string, unknown> }) => ({
      Key: command.input.Key,
    })),
    mockResolveMediaLocation: vi.fn(),
    mockGetB2ImageS3Client: vi.fn(),
  })
);

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

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getB2ImageS3Client: mockGetB2ImageS3Client,
}));

vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: mockResolveMediaLocation,
  registerMediaLocation: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({ insert: async () => undefined }),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/image-url-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUrlOwnership>()),
  shopArtworkUrls: mockShopArtworkUrls,
}));

const { purgeResizeCache, deleteImageFromS3, deleteImages, deleteImageById } = await import(
  '../image.service'
);
const { callCdnAccess } = await import('../cdn-access.service');

const invalidateCalls = () =>
  mockFetch.mock.calls.filter((call) => String(call[0]).includes('/admin/invalidate'));

const lastUrl = () => String(invalidateCalls().at(-1)?.[0] ?? '');

/** The exact literal the counterpart service gates on. Anything else means no retraction. */
const RETRACT = 'retractPublicBlobs=true';

const KEY = 'abc-def/original.jpeg';

/** A row shape `deleteImages`' `DELETE … RETURNING` produces. */
const row = (id: number, url: string) => ({ id, url, postId: null, nsfwLevel: 1, userId: 7 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({ ok: true, status: 202 } as any);
  setEnv({
    DATABASE_IS_PROD: true,
    IMAGE_CACHER_URL: 'https://image-cacher.test',
    IMAGE_CACHER_ADMIN_SECRET: 'test-shared-secret',
    S3_IMAGE_B2_BUCKET: 'test-b2-bucket',
  });
  // No other row shares the key, so the delete proceeds all the way to the purge.
  dbMock.dbWrite.image.findFirst.mockResolvedValue(null);
  mockResolveMediaLocation.mockResolvedValue({ backend: 'backblaze', url: 'https://b2/x' });
  mockB2Send.mockResolvedValue({ Key: KEY });
  mockGetB2ImageS3Client.mockReturnValue({ send: mockB2Send });
  mockShopArtworkUrls.mockResolvedValue(new Set());
});

describe('purgeResizeCache retraction opt-in', () => {
  // The default is the whole design: retraction has to be ASKED for, in words, or it does not
  // happen. Every pre-existing caller omits the option and must keep the behaviour it has today.
  it('does not ask for retraction when the option is omitted', async () => {
    await purgeResizeCache({ url: KEY });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });

  it('does not ask for retraction when the option is explicitly false', async () => {
    await purgeResizeCache({ url: KEY, retractPublicBlobs: false });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });

  it('asks for retraction when the option is explicitly true', async () => {
    await purgeResizeCache({ url: KEY, retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(1);
    // The SEPARATOR and the exact literal are both part of the contract. The counterpart
    // service fails closed on anything that is not `retractPublicBlobs=true`, so a missing '&'
    // (which glues it onto the previous value) or a different casing is a silent no-op that
    // every looser assertion would still pass.
    expect(lastUrl()).toContain(`&${RETRACT}`);
    expect(lastUrl()).toContain(`imageKey=${encodeURIComponent(KEY)}`);
  });

  // Nothing else about the call may move. The key and the scope are what the service acts on;
  // a retraction request that also corrupted them would destroy the wrong thing.
  it('changes nothing but the added parameter', async () => {
    await purgeResizeCache({ url: KEY });
    const withoutRetraction = lastUrl();

    mockFetch.mockClear();
    await purgeResizeCache({ url: KEY, retractPublicBlobs: true });

    expect(lastUrl()).toBe(`${withoutRetraction}&${RETRACT}`);
  });

  // Fail-closed cross-check. `hidden-meta-orphans` means the image is still LIVE — only the
  // variants derived before a metadata flip are being cleared. Retracting there would take
  // down an image nobody asked to remove. The combination is meaningless, so it degrades to NO
  // retraction rather than to the wider blast radius.
  it('refuses to retract on a partial-scope purge', async () => {
    await purgeResizeCache({ url: KEY, scope: 'hidden-meta-orphans', retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
    // Audible, because it can only mean a caller is confused about what it is asking for.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-blob-retraction-refused', imageKey: KEY })
    );
  });

  // Negative control for the log above — a refusal that is logged on every purge is not a signal.
  it('does not log a refusal for an ordinary full purge', async () => {
    await purgeResizeCache({ url: KEY, retractPublicBlobs: true });

    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-blob-retraction-refused' })
    );
  });
});

describe('deleteImageFromS3 retraction opt-in', () => {
  it('does not ask for retraction by default', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });

  it('does not ask for retraction when explicitly false', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY, retractPublicBlobs: false });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });

  it('passes retraction through when asked', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY, retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).toContain(`&${RETRACT}`);
  });

  // This log line is the attribution trail that a retraction was requested.
  it('records the retraction request against the image id', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY, retractPublicBlobs: true });

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'image-blob-retraction-requested',
        imageId: 4242,
        url: KEY,
      })
    );
  });

  // Negative control: an ordinary delete must not emit it, or the trail is noise.
  it('records nothing for an ordinary delete', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY });

    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-blob-retraction-requested' })
    );
  });

  // The refcount guard runs first and returns before the purge. A retraction must not sneak
  // past it — another live row pointing at this key means the image is not being taken down.
  it('sends nothing at all when another row still points at the key', async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue({ id: 1 });

    await deleteImageFromS3({ id: 4242, url: KEY, retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(0);
  });
});

describe('deleteImages retraction opt-in', () => {
  beforeEach(() => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([row(1, KEY)]);
  });

  // 🔴 THE CENTRAL REGRESSION. Ordinary bulk deletion — a replaced image being reaped, a
  // deleted user's media, a moderator clearing one account's uploads — must never reach
  // another account's stored bytes. This is the assertion that fails if the option is threaded
  // wrongly at any layer between here and the request.
  it('does not ask for retraction by default', async () => {
    await deleteImages([1]);

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
    expect(lastUrl()).not.toContain('persist');
  });

  it('does not ask for retraction when the option is explicitly false', async () => {
    await deleteImages([1], true, { retractPublicBlobs: false });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });

  it('asks for retraction when the moderation flow says so', async () => {
    await deleteImages([1], true, { retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).toContain(`&${RETRACT}`);
  });

  // The option must not be positional-adjacent to `updatePosts`: a caller that means "do not
  // update posts" must not be able to request a retraction by accident.
  it('does not ask for retraction when only updatePosts is passed', async () => {
    await deleteImages([1], false);

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
  });
});

describe('deleteImageById never retracts', () => {
  // The user-facing delete path (the image controller's `delete` mutation) goes through here.
  // It has no retraction option at all, by design — there is no moderation caller for it, and
  // an option nobody sets is one more way to set it by accident.
  it('sends an ordinary invalidation for a user-initiated delete', async () => {
    dbMock.dbWrite.image.delete.mockResolvedValue({
      url: KEY,
      postId: null,
      nsfwLevel: 1,
      userId: 7,
    });

    await deleteImageById({ id: 4242 });

    expect(invalidateCalls()).toHaveLength(1);
    expect(lastUrl()).not.toContain('retractPublicBlobs');
    expect(lastUrl()).not.toContain('persist');
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-blob-retraction-requested' })
    );
  });
});

describe('retraction load on the image-cache service', () => {
  // The service finishes a retraction even after the caller aborts, so the caller's wait is the only
  // thing that makes its concurrency limit the number running there.
  it('waits up to the long timeout for a retraction, and 2 s otherwise', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await purgeResizeCache({ url: KEY, retractPublicBlobs: true });
      expect(timeout).toHaveBeenLastCalledWith(70_000);

      await purgeResizeCache({ url: KEY });
      expect(timeout).toHaveBeenLastCalledWith(2000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps at most 5 retractions in flight across every batch of a bulk delete', async () => {
    // 120 ids is two DELETE batches, which run concurrently.
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!strings.join('').includes('DELETE FROM "Image"')) return [];
      const joined = values.find(
        (v): v is { values: number[] } =>
          !!v && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
      );
      return (joined?.values ?? []).map((id) => row(id, `key-${id}`));
    }) as never);
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, status: 202 } as never;
    });

    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const rows = await deleteImages(ids, true, { retractPublicBlobs: true });

    expect(invalidateCalls()).toHaveLength(120);
    expect(invalidateCalls().every((c) => String(c[0]).includes(`&${RETRACT}`))).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(inFlight).toBe(0);
    expect(rows.every((r) => r.retraction === 'confirmed')).toBe(true);
  });

  it('reports a 429 as busy, not done, and does not retry it', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
    } as never);

    expect(await purgeResizeCache({ url: KEY, retractPublicBlobs: true })).toBe('busy');
    expect(invalidateCalls()).toHaveLength(1);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([row(1, KEY)]);
    mockFetch.mockClear();
    const rows = await deleteImages([1], true, { retractPublicBlobs: true });
    expect(invalidateCalls()).toHaveLength(1);
    expect(rows).toEqual([expect.objectContaining({ id: 1, retraction: 'busy' })]);
  });

  it('reports any other failure as unconfirmed', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, headers: new Headers() } as never);
    expect(await purgeResizeCache({ url: KEY, retractPublicBlobs: true })).toBe('unconfirmed');
    mockFetch.mockRejectedValue(new Error('connection reset'));
    expect(await purgeResizeCache({ url: KEY, retractPublicBlobs: true })).toBe('unconfirmed');
  });

  // One limit for every retraction the process sends, whichever path sends it.
  it('caps retractions from purgeResizeCache and callCdnAccess together at 5, and not denies', async () => {
    const inFlight = { retract: 0, deny: 0 };
    const max = { retract: 0, deny: 0 };
    mockFetch.mockImplementation(async (url) => {
      const kind = String(url).includes(RETRACT) ? 'retract' : 'deny';
      inFlight[kind]++;
      max[kind] = Math.max(max[kind], inFlight[kind]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight[kind]--;
      return { ok: true, status: 202, headers: new Headers() } as never;
    });
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const n = [...Array(8).keys()];

    await Promise.all([
      ...n.map((i) => purgeResizeCache({ url: `key-${i}`, retractPublicBlobs: true })),
      ...n.map((i) => callCdnAccess(uuid(i), 'retract')),
      ...n.map((i) => callCdnAccess(uuid(100 + i), 'deny')),
    ]);

    const sent = (kind: 'retract' | 'deny') =>
      mockFetch.mock.calls.filter((c) => String(c[0]).includes(RETRACT) === (kind === 'retract'));
    expect(sent('retract')).toHaveLength(16);
    expect(sent('deny')).toHaveLength(8);
    expect(max.retract).toBeGreaterThan(1);
    expect(max.retract).toBeLessThanOrEqual(5);
    expect(max.deny).toBe(8);
  });

  it('starts no retraction in a bulk delete after the first 429, and still deletes storage', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!strings.join('').includes('DELETE FROM "Image"')) return [];
      const joined = values.find(
        (v): v is { values: number[] } =>
          !!v && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
      );
      return (joined?.values ?? []).map((id) => row(id, `key-${id}`));
    }) as never);
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: false, status: 429, headers: new Headers() } as never;
    });

    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const rows = await deleteImages(ids, true, { retractPublicBlobs: true });

    expect(invalidateCalls().length).toBeGreaterThan(0);
    expect(invalidateCalls().length).toBeLessThanOrEqual(5);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.retraction === 'busy')).toBe(true);
    expect(mockB2Send).toHaveBeenCalledTimes(20);
  });

  const bulkRows = () =>
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!strings.join('').includes('DELETE FROM "Image"')) return [];
      const joined = values.find(
        (v): v is { values: number[] } =>
          !!v && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
      );
      return (joined?.values ?? []).map((id) => row(id, `key-${id}`));
    }) as never);
  const requestedLogs = () =>
    mockLogToAxiom.mock.calls.filter(
      (c) => (c[0] as { name?: string }).name === 'image-blob-retraction-requested'
    );

  // A slow service sheds load the same way a refusing one does.
  it('starts no retraction in a bulk delete after the first timeout', async () => {
    bulkRows();
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    });
    const gate = { busy: false };

    const rows = await deleteImages(
      Array.from({ length: 20 }, (_, i) => i + 1),
      true,
      { retractPublicBlobs: true, retractionGate: gate }
    );

    expect(invalidateCalls().length).toBeGreaterThan(0);
    expect(invalidateCalls().length).toBeLessThanOrEqual(5);
    expect(gate.busy).toBe(true);
    expect(rows.every((r) => r.retraction === 'busy')).toBe(true);
    // The attribution trail records what was sent, not what was held back.
    expect(requestedLogs()).toHaveLength(invalidateCalls().length);
  });

  it('holds a retraction back unsent when no slot comes free within the wait', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    mockFetch.mockImplementation(async (url) => {
      if (String(url).includes('8000-00000000009')) await held;
      return { ok: true, status: 202, headers: new Headers() } as never;
    });
    // Another sender holds every slot.
    const holders = [...Array(5).keys()].map((i) => callCdnAccess(uuid(90 + i), 'retract'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const purge = purgeResizeCache({ url: KEY, retractPublicBlobs: true });
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      release();
      await Promise.all(holders);

      expect(await purge).toBe('busy');
      expect(
        invalidateCalls().filter((c) => String(c[0]).includes(encodeURIComponent(KEY)))
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
      release();
    }
  });
});

describe('an image whose key shop artwork uses', () => {
  const OWNER = 7;
  const deleted = (over: Record<string, unknown> = {}) =>
    dbMock.dbWrite.image.delete.mockResolvedValue({
      url: KEY,
      postId: null,
      nsfwLevel: 1,
      userId: OWNER,
      ingestion: 'Scanned',
      needsReview: null,
      ...over,
    } as never);
  beforeEach(() => mockShopArtworkUrls.mockResolvedValue(new Set([KEY])));

  it('keeps its object when the owner deletes it', async () => {
    deleted();

    await deleteImageById({ id: 4242, deletedById: OWNER });

    expect(mockB2Send).not.toHaveBeenCalled();
    expect(invalidateCalls()).toHaveLength(0);
  });

  it.each([
    ['a moderator deletes it', { deletedById: 99 }, {}],
    ['the deleter is unknown', {}, {}],
    ['it is blocked', { deletedById: OWNER }, { ingestion: 'Blocked' }],
    ['it is held for review', { deletedById: OWNER }, { needsReview: 'csam' }],
  ])('deletes and purges its object when %s', async (_case, args, over) => {
    deleted(over);

    await deleteImageById({ id: 4242, ...args });

    expect(mockB2Send).toHaveBeenCalledTimes(1);
    expect(invalidateCalls()).toHaveLength(1);
  });

  // A hold marker keeps the row, so nothing reaches storage, whoever deletes it.
  it('leaves a held image to its hold', async () => {
    dbMock.dbWrite.image.delete.mockResolvedValue(null as never);

    await deleteImageById({ id: 4242, deletedById: OWNER });

    expect(mockB2Send).not.toHaveBeenCalled();
  });

  it('is deleted by the delete paths that do not ask to keep it', async () => {
    await deleteImageFromS3({ id: 4242, url: KEY });

    expect(mockB2Send).toHaveBeenCalledTimes(1);
  });
});
