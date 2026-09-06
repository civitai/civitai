import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const mockLogToAxiom = loggingMock.logToAxiom;

// The image-cache service's invalidate endpoint can also destroy the SHARED, content-addressed
// stored object behind an image. That object is shared by every byte-identical image, of every
// owner, so destroying it is a cross-account destructive act — not a cache bust. The service
// gates it behind one exact query parameter and refuses to do it otherwise.
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

const { purgeResizeCache, deleteImageFromS3, deleteImages, deleteImageById } = await import(
  '../image.service'
);

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
  // variants derived before a metadata flip are being cleared. Retracting the shared object
  // there would destroy the bytes of an image nobody asked to take down, and of every
  // byte-identical copy besides. The combination is meaningless, so it degrades to NO
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

  // The app cannot enumerate the other images whose bytes this removes — it stores no
  // content-hash key, and the perceptual hash it does store is not a byte-identity key. This
  // log line is therefore the ONLY attribution trail that a retraction was requested at all.
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
  // update posts" must not be able to request a cross-account destruction by accident.
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
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-blob-retraction-requested' })
    );
  });
});
