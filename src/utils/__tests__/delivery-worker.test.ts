import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Concrete endpoints so the module-load constants resolve and the resolver/
// delivery-worker branches are reachable. Any field we don't set falls back to
// the global env Proxy in src/__tests__/setup.ts.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: '', // disabled by default → delivery-worker path
      STORAGE_RESOLVER_AUTH: '',
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      // s3-utils → db/client is transitively imported and reads env.LOGGING.filter
      // (array) at module load; provide an empty array so the prisma-log builder
      // is a no-op.
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
  getDownloadUrl,
  isDefiniteNotFound,
  resolveDownloadUrl,
  safeDecodeURIComponent,
} from '../delivery-worker';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('safeDecodeURIComponent', () => {
  it('decodes a well-formed encoded value', () => {
    expect(safeDecodeURIComponent('a%20b')).toBe('a b');
  });

  it('does NOT throw on a malformed percent-sequence — returns the raw value', () => {
    // `decodeURIComponent('%E0%A4%A')` and `decodeURIComponent('100%')` both throw
    // `URIError: URI malformed`. The safe wrapper must fall back to the raw input.
    expect(() => safeDecodeURIComponent('%E0%A4%A')).not.toThrow();
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
    expect(safeDecodeURIComponent('files/100%-done.safetensors')).toBe(
      'files/100%-done.safetensors'
    );
  });

  it('leaves an already-decoded value unchanged', () => {
    expect(safeDecodeURIComponent('plain/name.safetensors')).toBe('plain/name.safetensors');
  });
});

describe('getDownloadUrl — malformed file.url / filename no longer 500s', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(url: string) {
    return {
      ok: true,
      json: async () => ({ url, urlExpiryDate: new Date().toISOString() }),
    } as unknown as Response;
  }

  it('resolves (does not throw URI malformed) when the key has a bad percent-sequence', async () => {
    fetchMock.mockResolvedValue(okResponse('https://cdn.example.com/signed'));

    // A stored URL whose key contains a lone/truncated `%` — pre-fix this threw
    // `URIError: URI malformed` at `decodeURIComponent(key)` before any fetch.
    const result = await getDownloadUrl(
      'https://abcd1234.r2.cloudflarestorage.com/civitai/files/bad%2.safetensors',
      'name%E0%A4%A.safetensors'
    );

    expect(result.url).toBe('https://cdn.example.com/signed');
    expect(fetchMock).toHaveBeenCalled();
    // The request body must carry a string (raw fallback), never throw while
    // building it.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(typeof body.fileName).toBe('string');
  });

  it('throws (→ caller treats as not-found) when the delivery worker rejects every key', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as unknown as Response);

    await expect(
      getDownloadUrl('https://abcd1234.r2.cloudflarestorage.com/civitai/files/x.safetensors')
    ).rejects.toThrow(/Delivery worker error/);
  });

  it('throws a DeliveryWorkerError carrying the upstream 404 status (not-found → caller can 404)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as unknown as Response);

    await getDownloadUrl(
      'https://abcd1234.r2.cloudflarestorage.com/civitai/files/x.safetensors'
    ).then(
      () => {
        throw new Error('expected getDownloadUrl to reject');
      },
      (err) => {
        expect(err).toBeInstanceOf(DeliveryWorkerError);
        expect((err as DeliveryWorkerError).statusCode).toBe(404);
      }
    );
  });

  it('throws a DeliveryWorkerError carrying an upstream 5xx status (transient → caller keeps 5xx)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as unknown as Response);

    await getDownloadUrl(
      'https://abcd1234.r2.cloudflarestorage.com/civitai/files/x.safetensors'
    ).then(
      () => {
        throw new Error('expected getDownloadUrl to reject');
      },
      (err) => {
        expect(err).toBeInstanceOf(DeliveryWorkerError);
        expect((err as DeliveryWorkerError).statusCode).toBe(503);
      }
    );
  });
});

describe('resolveDownloadUrl — falls back to delivery worker when resolver disabled', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw URI malformed for a malformed filename on the resolver-disabled path', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://cdn.example.com/ok',
        urlExpiryDate: new Date().toISOString(),
      }),
    } as unknown as Response);

    const result = await resolveDownloadUrl(
      123,
      'https://abcd1234.r2.cloudflarestorage.com/civitai/files/y.safetensors',
      'weird%name%.safetensors'
    );
    expect(result.url).toBe('https://cdn.example.com/ok');
  });
});

describe('isDefiniteNotFound — absence must be positively reported (404/410)', () => {
  // Callers act on `true` by writing a PERMANENT tombstone that also permanently
  // exempts the file from virus/pickle scanning, so a wrongly-true answer is far
  // more expensive than a wrongly-false one (which costs a single retry).
  it.each([
    ['DeliveryWorkerError 404', new DeliveryWorkerError(404, 'Not Found')],
    ['DeliveryWorkerError 410', new DeliveryWorkerError(410, 'Gone')],
    ['StorageResolverError 404', new StorageResolverError(404, 'not found')],
    ['StorageResolverError 410', new StorageResolverError(410, 'gone')],
  ])('is true for %s', (_label, err) => {
    expect(isDefiniteNotFound(err)).toBe(true);
  });

  it.each([
    ['DeliveryWorkerError 500', new DeliveryWorkerError(500, 'Internal Server Error')],
    ['DeliveryWorkerError 502', new DeliveryWorkerError(502, 'Bad Gateway')],
    ['DeliveryWorkerError 503', new DeliveryWorkerError(503, 'Service Unavailable')],
    ['DeliveryWorkerError 429', new DeliveryWorkerError(429, 'Too Many Requests')],
    ['DeliveryWorkerError 401', new DeliveryWorkerError(401, 'Unauthorized')],
    ['DeliveryWorkerError 403', new DeliveryWorkerError(403, 'Forbidden')],
    // 400 is deliberately NOT treated as proof of absence: a malformed key is
    // real, but 400 is also what a transiently-misbehaving upstream returns.
    ['DeliveryWorkerError 400', new DeliveryWorkerError(400, 'Bad Request')],
    ['StorageResolverError 503', new StorageResolverError(503, 'Service Unavailable')],
    ['StorageResolverError 500', new StorageResolverError(500, 'boom')],
    ['a bare Error (no status at all)', new Error('ECONNRESET')],
    ['a config Error', new Error('STORAGE_RESOLVER_ENDPOINT is not configured')],
    ['a TypeError from fetch', new TypeError('fetch failed')],
  ])('is false for %s', (_label, err) => {
    expect(isDefiniteNotFound(err)).toBe(false);
  });

  it.each([
    ['a string', 'not found'],
    ['null', null],
    ['undefined', undefined],
    // Shape-alike: carries statusCode 404 but is not one of our error types.
    ['a plain object with statusCode 404', { statusCode: 404 }],
  ])('is false for a non-Error rejection: %s', (_label, value) => {
    expect(isDefiniteNotFound(value)).toBe(false);
  });

  it('keeps the historical message prefixes so existing log-matchers still fire', () => {
    expect(new StorageResolverError(503, 'boom').message).toBe('Storage resolver error: boom');
    expect(new DeliveryWorkerError(503, 'boom').message).toBe('Delivery worker error: boom');
  });
});
