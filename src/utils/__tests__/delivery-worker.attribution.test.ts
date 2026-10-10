import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage resolver enabled, so `resolveDownloadUrl` consults it first. Same env
// shape as delivery-worker.direct.test.ts; module-load constants mean the
// endpoint cannot be toggled per test.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: 'https://resolver.example.com',
      STORAGE_RESOLVER_AUTH: 'user:pass',
      STORAGE_RESOLVER_INTERNAL_TOKEN: 'internal-tok',
      // delivery-worker imports s3-utils, which parses these at module load.
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

describe('caller and actor reach the resolver', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(OK);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Two distinct pairs, so a body that hardcodes either value cannot pass both.
  it.each([
    ['vault', 'user'],
    ['orchestrator-preflight', 'internal'],
  ] as const)('sends caller=%s actor=%s in the /resolve body', async (caller, actor) => {
    await getDownloadUrlByFileId(1, 'model.safetensors', { caller, actor });
    expect(fetchMock.mock.calls[0][0]).toBe('https://resolver.example.com/resolve');
    expect(bodyOf(fetchMock)).toStrictEqual({
      fileId: 1,
      fileName: 'model.safetensors',
      caller,
      actor,
    });
  });

  it('resolveDownloadUrl forwards the attribution', async () => {
    await resolveDownloadUrl(7, 's3://bucket/key.safetensors', undefined, {
      caller: 'download-route',
      actor: 'anon',
    });
    expect(bodyOf(fetchMock)).toStrictEqual({ fileId: 7, caller: 'download-route', actor: 'anon' });
  });

  // The attribution is metadata only: it must not change the direct flag or which
  // credential is presented.
  it('leaves direct and the credential exactly as before', async () => {
    await getDownloadUrlByFileId(1, 'model.safetensors', {
      caller: 'download-route',
      actor: 'user',
      direct: true,
    });
    expect(bodyOf(fetchMock)).toMatchObject({ direct: true, caller: 'download-route' });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer internal-tok');

    fetchMock.mockClear();
    await getDownloadUrlByFileId(1, 'model.safetensors', { caller: 'vault', actor: 'user' });
    expect(bodyOf(fetchMock)).not.toHaveProperty('direct');
    expect(headersOf(fetchMock).Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`
    );
  });

  // The delivery worker is a separate service; nothing about it changes.
  it('does not send the attribution to the delivery-worker fallback', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'nope' } as Response)
      .mockResolvedValueOnce(OK);

    await resolveDownloadUrl(7, 's3://bucket/key.safetensors', 'key.safetensors', {
      caller: 'vault',
      actor: 'user',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1)).toStrictEqual({
      key: 'key.safetensors',
      fileName: 'key.safetensors',
    });
  });
});
