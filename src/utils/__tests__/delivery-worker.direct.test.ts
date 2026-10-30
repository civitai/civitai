import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage resolver enabled — the direct flag only exists on that path. Mirrors the
// mock in delivery-worker.resolver-enabled.test.ts; module-load constants mean the
// endpoint cannot be toggled per-test, hence a separate file.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: 'https://resolver.example.com',
      STORAGE_RESOLVER_AUTH: 'user:pass',
      // Required for `direct`: the resolver refuses an origin-direct ask that does
      // not carry this. See delivery-worker.direct-unauthenticated.test.ts for the
      // arm where it is absent.
      STORAGE_RESOLVER_INTERNAL_TOKEN: 'internal-tok',
      // Required: delivery-worker imports s3-utils, which parses these at module
      // load and throws on an undefined URL before any test runs.
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

import { getDownloadUrlByFileId, resolveDownloadUrl } from '../delivery-worker';

const OK = {
  ok: true,
  json: async () => ({ url: 'https://example/ok', urlExpiryDate: new Date().toISOString() }),
} as unknown as Response;

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body as string);

const headersOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  fetchMock.mock.calls[call][1].headers as Record<string, string>;

describe('the direct flag reaches the resolver', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(OK);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends direct:true when asked', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors', { direct: true });
    expect(bodyOf(fetchMock)).toMatchObject({ fileId: 1, direct: true });
  });

  // 🔴 The resolver gates `direct` on the internal bearer token, because /resolve
  // is publicly reachable and `direct` spends our egress allowance. A request that
  // carries the flag but not the credential is refused there and silently served
  // from the CDN — so asserting the body alone would pass while the feature was
  // dead in production. Pin the header.
  it('authenticates a direct ask with the internal bearer token', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors', { direct: true });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer internal-tok');
  });

  // The negative control for the header: an ordinary resolve is unchanged and
  // still sends the Basic credential. Without this, swapping every request to
  // Bearer would pass the test above.
  it('leaves an ordinary resolve on the Basic credential', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors');
    expect(headersOf(fetchMock).Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`
    );
  });

  // 🔴 Omitted, not `false`. An older resolver that does not know the field must
  // receive a byte-identical request to the one it gets today, so the rollout can
  // be done in either order without a version dependency between the two repos.
  it('omits the field entirely when not asked', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors');
    expect(bodyOf(fetchMock)).not.toHaveProperty('direct');

    fetchMock.mockClear();
    await getDownloadUrlByFileId(1, 'model.safetensors', { direct: false });
    expect(bodyOf(fetchMock)).not.toHaveProperty('direct');
  });

  it('resolveDownloadUrl forwards the flag to the resolver', async () => {
    await resolveDownloadUrl(7, 's3://bucket/key.safetensors', 'key.safetensors', {
      direct: true,
    });
    expect(bodyOf(fetchMock)).toMatchObject({ fileId: 7, direct: true });
  });

  // The delivery worker is the legacy path keyed off ModelFile.url and has no
  // notion of which host serves the bytes. A direct request that falls back to it
  // must still succeed rather than erroring on an option it cannot honour.
  it('falls back to the delivery worker unchanged when the resolver fails', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'nope' } as Response)
      .mockResolvedValueOnce(OK);

    await expect(
      resolveDownloadUrl(7, 's3://bucket/key.safetensors', 'key.safetensors', { direct: true })
    ).resolves.toMatchObject({ url: 'https://example/ok' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call is the delivery worker: keyed on the object key (parseKey reads
    // the bucket off the s3:// hostname, so it is not part of the key), and
    // carrying no `direct` field for a service that would not understand it.
    const fallbackBody = bodyOf(fetchMock, 1);
    expect(fallbackBody).toMatchObject({ key: 'key.safetensors' });
    expect(fallbackBody).not.toHaveProperty('direct');
  });
});
