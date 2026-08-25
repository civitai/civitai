import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The same resolver-enabled setup as delivery-worker.direct.test.ts, MINUS
// STORAGE_RESOLVER_INTERNAL_TOKEN. It is a separate file because delivery-worker
// reads its env into module-load constants, so the credential cannot be removed
// per-test.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: 'https://resolver.example.com',
      STORAGE_RESOLVER_AUTH: 'user:pass',
      // STORAGE_RESOLVER_INTERNAL_TOKEN deliberately absent — that is the case
      // under test.
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

import { getDownloadUrlByFileId } from '../delivery-worker';

const OK = {
  ok: true,
  json: async () => ({ url: 'https://example/ok', urlExpiryDate: new Date().toISOString() }),
} as unknown as Response;

describe('a direct ask without the internal token', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(OK);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // 🔴 We do not ask at all rather than asking and being refused. The resolver
  // answers an unauthenticated direct ask by serving the CDN URL and incrementing
  // granted="unauthorized" — a counter whose whole value is that it means someone
  // found the cost lever. Our own missing config must not be what fills it.
  //
  // The cost of this choice is that a half-finished rollout (allowlist set, token
  // not) is silently inert rather than loud. The observable is granted="true"
  // staying at zero, which the enable checklist watches.
  it('omits the flag rather than sending an unauthenticated one', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors', { direct: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('direct');
  });

  it('still sends the ordinary Basic credential, so normal downloads are unaffected', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors', { direct: true });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });
});
