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

// delivery-worker imports parseKey from s3-utils, which imports db/client and
// instantiates a real PrismaClient at module load. Stub the db client so the
// import graph doesn't need `prisma generate` (mirrors s3-utils.test).
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
}));

import { getDownloadUrl, resolveDownloadUrl, safeDecodeURIComponent } from '../delivery-worker';

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
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Not Found' } as unknown as Response);

    await expect(
      getDownloadUrl('https://abcd1234.r2.cloudflarestorage.com/civitai/files/x.safetensors')
    ).rejects.toThrow(/Delivery worker error/);
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
      json: async () => ({ url: 'https://cdn.example.com/ok', urlExpiryDate: new Date().toISOString() }),
    } as unknown as Response);

    const result = await resolveDownloadUrl(
      123,
      'https://abcd1234.r2.cloudflarestorage.com/civitai/files/y.safetensors',
      'weird%name%.safetensors'
    );
    expect(result.url).toBe('https://cdn.example.com/ok');
  });
});
