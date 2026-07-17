import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks (Phase-1 seam) — `persistBlockWorkflowOutputImage` redirect-follow
 * regression tests.
 *
 * The real orchestrator output-blob url returns a `301` to a SAME-host content url
 * (a relative `Location`) before the `200 image/jpeg`. The fetch used to run with
 * `redirect:'error'`, which THREW on that normal 301 → every benchmark-grid cell
 * publish failed with "could not fetch the generation output to publish". The fix
 * follows redirects MANUALLY up to `MAX_OUTPUT_REDIRECTS` hops, re-validating the
 * host against `isAllowedOutputHost` BEFORE each hop opens a socket, so the
 * Civitai-hosts-only SSRF bound (PR #3187) still holds for every hop.
 *
 * All network/store/DB deps are mocked — no real fetch / S3 / Prisma / image.service.
 */

const { mockUpload, mockCreateImage } = vi.hoisted(() => ({
  mockUpload: vi.fn(async (..._a: unknown[]): Promise<{ key: string }> => ({ key: 'uuid-key' })),
  mockCreateImage: vi.fn(async (..._a: unknown[]): Promise<{ id: number }> => ({ id: 4242 })),
}));

// The service statically imports dbRead + getEdgeUrl; stub both so the module
// graph never touches a real Prisma client / cf-images env.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (u: string) => `edge:${u}` }));
vi.mock('~/utils/s3-utils', () => ({ uploadImageBufferToStore: mockUpload }));
// `createImage` is dynamically imported inside the service.
vi.mock('~/server/services/image.service', () => ({ createImage: mockCreateImage }));

// A minimal fetch Response stand-in. A 3xx carries a `location` header; a 2xx
// carries the body bytes. `body.cancel` is asserted to run on every redirect hop
// (the service frees the socket before the next hop).
type MockResponse = {
  status: number;
  ok: boolean;
  headers: { get: (k: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: { cancel: ReturnType<typeof vi.fn> } | null;
};

function redirectResponse(status: number, location: string | null): MockResponse {
  return {
    status,
    ok: false,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: { cancel: vi.fn(async () => undefined) },
  };
}

// Valid JPEG: magic bytes ff d8 ff, padded past the 12-byte sniff minimum.
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0)]);

function imageResponse(
  bytes: Buffer = JPEG_BYTES,
  headers: Record<string, string> = {}
): MockResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: 200,
    ok: true,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: null,
  };
}

// Mirror of the service's module-private MAX_OUTPUT_REDIRECTS (the too-many-
// redirects test below pins the bound; the service const isn't exported).
const MAX_OUTPUT_REDIRECTS_EXPECTED = 3;

const fetchMock = vi.fn();

async function callPersist(imageUrl: string) {
  const { persistBlockWorkflowOutputImage } = await import('../block-image-upload.service');
  return persistBlockWorkflowOutputImage({
    imageUrl,
    width: 1024,
    height: 1024,
    userId: 7,
    appId: 'oc_app_1',
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await fn();
    throw new Error('expected the publish to reject, but it resolved');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

describe('persistBlockWorkflowOutputImage — orchestrator output-blob redirect follow', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mockUpload.mockReset().mockResolvedValue({ key: 'uuid-key' });
    mockCreateImage.mockReset().mockResolvedValue({ id: 4242 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const OUTPUT_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=xyz';

  it('301 same-host → 200 jpeg PUBLISHES (the exact regression this fixes)', async () => {
    const redirect = redirectResponse(301, '/v2/consumer/blobs/content/b64payload');
    fetchMock.mockResolvedValueOnce(redirect).mockResolvedValueOnce(imageResponse());

    const res = await callPersist(OUTPUT_URL);

    expect(res).toEqual({ imageId: 4242 });
    // Two fetches: the 301, then the resolved SAME-host content url.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(OUTPUT_URL);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://orchestration.civitai.com/v2/consumer/blobs/content/b64payload'
    );
    // Both hops used manual redirect handling.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    // The redirect body's socket was freed before the next hop.
    expect(redirect.body?.cancel).toHaveBeenCalledTimes(1);
    // The image was stored + a bare row created.
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][1]).toMatchObject({ contentType: 'image/jpeg' });
    expect(mockCreateImage).toHaveBeenCalledTimes(1);
    expect(mockCreateImage.mock.calls[0][0]).toMatchObject({
      url: 'uuid-key',
      mimeType: 'image/jpeg',
      userId: 7,
      metadata: expect.objectContaining({ blockPublishedAppId: 'oc_app_1' }),
    });
  });

  it('direct 200 (no redirect) still publishes', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse());
    const res = await callPersist(OUTPUT_URL);
    expect(res).toEqual({ imageId: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCreateImage).toHaveBeenCalledTimes(1);
  });

  it('redirect to an OFF-allowlist host is REJECTED before opening its socket', async () => {
    // First hop 301s to an attacker host. The second fetch must NEVER happen —
    // the loop re-validates the host at the TOP of the next iteration.
    fetchMock.mockResolvedValueOnce(redirectResponse(301, 'https://evil.example.com/x.jpg'));

    const err = await captureError(() => callPersist(OUTPUT_URL));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('output url is not an allowed generation host');
    // Only the first (allowlisted) fetch ran; the evil host was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('too many redirects (> MAX_OUTPUT_REDIRECTS same-host hops) → BAD_REQUEST', async () => {
    // Endless same-host 301 chain. The bound stops it at MAX_OUTPUT_REDIRECTS (3):
    // hops 0,1,2 follow, the 4th 3xx (hops===3) throws — so 4 fetches total.
    fetchMock.mockResolvedValue(
      redirectResponse(301, 'https://orchestration.civitai.com/v2/consumer/blobs/next')
    );
    const err = await captureError(() => callPersist(OUTPUT_URL));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('could not fetch the generation output to publish');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_OUTPUT_REDIRECTS_EXPECTED + 1);
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('an off-allowlist STARTING url is rejected with no fetch at all', async () => {
    const err = await captureError(() => callPersist('https://evil.example.com/x.jpg'));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('output url is not an allowed generation host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 3xx with NO Location header → BAD_REQUEST (unfollowable)', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(302, null));
    const err = await captureError(() => callPersist(OUTPUT_URL));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('could not fetch the generation output to publish');
    expect(mockCreateImage).not.toHaveBeenCalled();
  });
});
