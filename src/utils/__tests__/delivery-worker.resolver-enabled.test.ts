import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The storage resolver is ENABLED here — the production config, and the one the
// sibling delivery-worker.test.ts deliberately does NOT exercise (it pins
// STORAGE_RESOLVER_ENDPOINT: '' to reach the legacy path). Module-load constants
// mean this cannot be toggled per-test, hence a separate file.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: 'https://resolver.example.com',
      STORAGE_RESOLVER_AUTH: '',
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      LOGGING: [],
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return undefined;
      },
    }
  ),
}));

import {
  DeliveryWorkerError,
  StorageResolverError,
  getDownloadUrlByFileId,
  isDefiniteNotFound,
  resolveDownloadUrl,
} from '../delivery-worker';

const OK_BODY = {
  ok: true,
  json: async () => ({ url: 'https://cdn.example/ok', urlExpiryDate: new Date().toISOString() }),
} as unknown as Response;

const resolverFail = (status: number) =>
  ({ ok: false, status, text: async () => `resolver said ${status}` } as unknown as Response);

const deliveryFail = (status: number) =>
  ({ ok: false, status, statusText: `dw ${status}` } as unknown as Response);

describe('getDownloadUrlByFileId — throws a typed error carrying the resolver status', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Without this, nothing drives the real function to a non-OK response: every
  // other test constructs StorageResolverError by hand, so reverting the class
  // to a bare `throw new Error(...)`, or hardcoding its status to 404, both
  // survive the suite. Those are the two mutants this file exists to kill.
  it.each([404, 410, 500, 503, 401, 429])(
    'propagates HTTP %i as StorageResolverError.statusCode',
    async (status) => {
      fetchMock.mockResolvedValue(resolverFail(status));

      const err = await getDownloadUrlByFileId(1).catch((e) => e);

      expect(err).toBeInstanceOf(StorageResolverError);
      expect((err as StorageResolverError).statusCode).toBe(status);
      expect((err as Error).message).toContain(`resolver said ${status}`);
    }
  );

  it('returns the resolved url when the resolver answers OK', async () => {
    fetchMock.mockResolvedValue(OK_BODY);
    await expect(getDownloadUrlByFileId(1)).resolves.toMatchObject({
      url: 'https://cdn.example/ok',
    });
  });
});

describe('resolveDownloadUrl — the resolver verdict survives the delivery-worker fallback', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // fetch order with the resolver enabled: [0] resolver, then [1..] delivery
  // worker (it retries a second key candidate, so mockResolvedValue covers both).
  const arrange = (resolverStatus: number, deliveryStatus: number) => {
    fetchMock
      .mockResolvedValueOnce(resolverFail(resolverStatus))
      .mockResolvedValue(deliveryFail(deliveryStatus));
  };

  it('still falls back to the delivery worker on a resolver 404 (unsynced File records depend on it)', async () => {
    fetchMock.mockResolvedValueOnce(resolverFail(404)).mockResolvedValue(OK_BODY);
    await expect(resolveDownloadUrl(1, 's3://b/k.safetensors')).resolves.toMatchObject({
      url: 'https://cdn.example/ok',
    });
    // Pin the ORDER, not just the outcome: without this the test would still pass
    // if the env mock silently degraded to a disabled resolver, because fetch[0]
    // would then be the delivery worker and the second key candidate would hit OK.
    expect(fetchMock.mock.calls[0][0]).toContain('resolver.example.com');
  });

  // 🔴 A resolver pod outage does NOT usually arrive as a clean HTTP status — the
  // connection is refused, DNS fails, or the socket times out, and `fetch` REJECTS.
  // That throws a TypeError, not a StorageResolverError. The attach guard is
  // therefore `!== undefined` rather than an `instanceof` narrowing; tightening it
  // would leave a transport reject unattached, fall through to `return true`, and
  // tombstone a healthy file — the exact bug this PR exists to fix.
  it.each([
    // undici surfaces connection-refused/DNS/header-timeout alike as
    // `TypeError: fetch failed` (no AbortSignal is passed, so no DOMException
    // TimeoutError arises on this path). The second row is a non-TypeError Error
    // to pin that the guard keys off "not a StorageResolverError", not off TypeError.
    ['connection refused / DNS / header timeout', () => new TypeError('fetch failed')],
    ['a non-TypeError transport failure', () => new Error('socket hang up')],
  ])(
    'a resolver TRANSPORT reject (%s) + delivery worker 404 is NOT definite-not-found',
    async (_l, makeErr) => {
      fetchMock.mockRejectedValueOnce(makeErr()).mockResolvedValue(deliveryFail(404));

      const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);

      expect(err).toBeInstanceOf(DeliveryWorkerError);
      expect((err as DeliveryWorkerError).statusCode).toBe(404);
      // Attached but NOT a StorageResolverError — this is the shape the guard must keep.
      expect((err as DeliveryWorkerError).resolverError).toBeDefined();
      expect((err as DeliveryWorkerError).resolverError).not.toBeInstanceOf(StorageResolverError);
      expect(isDefiniteNotFound(err)).toBe(false);
    }
  );

  it('a resolver CONFIG error (bare Error, no status) + delivery worker 404 is NOT definite-not-found', async () => {
    // `getDownloadUrlByFileId` throws a plain Error when the endpoint is unset;
    // it is reachable via other callers and must not read as proof of absence.
    fetchMock
      .mockRejectedValueOnce(new Error('STORAGE_RESOLVER_ENDPOINT is not configured'))
      .mockResolvedValue(deliveryFail(404));

    const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);
    expect(isDefiniteNotFound(err)).toBe(false);
  });

  it('attaches the resolver error to the delivery-worker error it throws', async () => {
    arrange(503, 404);
    const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);

    expect(err).toBeInstanceOf(DeliveryWorkerError);
    expect((err as DeliveryWorkerError).statusCode).toBe(404);
    expect((err as DeliveryWorkerError).resolverError).toBeInstanceOf(StorageResolverError);
    expect(((err as DeliveryWorkerError).resolverError as StorageResolverError).statusCode).toBe(
      503
    );
  });

  // 🔴 THE REGRESSION THIS FILE EXISTS FOR. The delivery worker is the legacy
  // path keyed off ModelFile.url and cannot see a file registered only in
  // file_locations. So during a resolver outage it returns 404 for a perfectly
  // healthy file — and treating that as proof of absence is what burst-tombstoned
  // healthy files in the first place. Classifying on the delivery worker's status
  // alone reproduces the original bug one layer down.
  it.each([
    ['resolver 503 outage + delivery worker 404', 503, 404],
    ['resolver 500 outage + delivery worker 404', 500, 404],
    ['resolver 401 auth failure + delivery worker 404', 401, 404],
    ['resolver 429 rate limit + delivery worker 410', 429, 410],
  ])('is NOT definite-not-found: %s', async (_label, resolverStatus, deliveryStatus) => {
    arrange(resolverStatus, deliveryStatus);
    const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);
    expect(isDefiniteNotFound(err)).toBe(false);
  });

  it.each([
    ['both 404 — every authority agrees', 404, 404],
    ['resolver 404 + delivery worker 410', 404, 410],
    ['resolver 410 + delivery worker 404', 410, 404],
  ])('IS definite-not-found: %s', async (_label, resolverStatus, deliveryStatus) => {
    arrange(resolverStatus, deliveryStatus);
    const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);
    expect(isDefiniteNotFound(err)).toBe(true);
  });

  it('is NOT definite-not-found when the resolver proved absence but the delivery worker could not answer', async () => {
    // The resolver's 404 is real, but we never learned whether the legacy path
    // would have served it, so absence is not established end-to-end.
    arrange(404, 500);
    const err = await resolveDownloadUrl(1, 's3://b/k.safetensors').catch((e) => e);
    expect((err as DeliveryWorkerError).statusCode).toBe(500);
    expect(isDefiniteNotFound(err)).toBe(false);
  });
});
