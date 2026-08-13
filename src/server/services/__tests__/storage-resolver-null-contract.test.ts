import { describe, it, expect, vi, beforeEach } from 'vitest';

// `resolveMediaLocation` is typed `Promise<{…} | null>` and every caller is written as if it
// cannot throw — deleteImageFromS3 in particular, where a throw skips the S3 delete entirely and
// leaves a publicly-fetchable object behind a deleted row.
//
// It used to end `return res.json() as Promise<…>` INSIDE its try. In an async function a returned
// promise is adopted after control leaves the try, so its rejection was never seen by the catch
// and escaped to the caller — silently violating the `| null` contract. A 200 response carrying a
// non-JSON body (an ingress or proxy error page) is exactly that shape, and it is the same
// storage-resolver-outage case the null branch exists to tolerate.

vi.mock('~/env/server', () => ({
  env: {
    STORAGE_RESOLVER_INTERNAL_URL: 'http://storage-resolver.test',
    STORAGE_RESOLVER_INTERNAL_TOKEN: 'test-token',
  },
}));

const { resolveMediaLocation } = await import('../storage-resolver');

const mockFetch = vi.fn();

describe('resolveMediaLocation — the `| null` contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  // THE REGRESSION. Without `await` on res.json() this rejects instead of resolving to null.
  it('returns null when a 200 response carries a body that is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    });

    await expect(resolveMediaLocation('abc-def/original.jpeg')).resolves.toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });

    await expect(resolveMediaLocation('abc-def/original.jpeg')).resolves.toBeNull();
  });

  it('returns null when the request itself rejects', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(resolveMediaLocation('abc-def/original.jpeg')).resolves.toBeNull();
  });

  // Positive control: the null cases above must not be passing because the function returns null
  // unconditionally. A resolvable location has to come back intact.
  it('returns the parsed location on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ backend: 'backblaze', url: 'https://b2.test/abc' }),
    });

    await expect(resolveMediaLocation('abc-def/original.jpeg')).resolves.toEqual({
      backend: 'backblaze',
      url: 'https://b2.test/abc',
    });
  });
});
