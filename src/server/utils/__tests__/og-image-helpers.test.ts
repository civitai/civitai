import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchImageAsDataUri,
  OG_IMAGE_MAX_BYTES,
  OG_IMAGE_FETCH_TIMEOUT_MS,
} from '../og-image-helpers';

/**
 * Unit coverage for the OG cover-image prefetch helper. The full ImageResponse
 * render is impractical to unit-test, but the bounded fetch→data-URI logic — the
 * part that caps the p99 — is pure-ish and the important contract:
 *   - success → returns `data:<content-type>;base64,<...>`
 *   - timeout/abort → null (caller falls back to no-image)
 *   - non-2xx → null
 *   - oversize (Content-Length too big) → null WITHOUT buffering the body
 *   - oversize actual body (header absent/lying) → null
 *   - missing content-type → defaults to image/jpeg
 */

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  contentLength?: string | null;
  body?: Uint8Array;
}): Response {
  const { ok = true, contentType = 'image/png', contentLength = null, body = new Uint8Array([1, 2, 3]) } = opts;
  const headers = new Map<string, string>();
  if (contentType != null) headers.set('content-type', contentType);
  if (contentLength != null) headers.set('content-length', contentLength);
  const arrayBuffer = vi.fn(async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer,
  } as unknown as Response;
}

describe('fetchImageAsDataUri', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a data URI on success with the response content-type', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ contentType: 'image/webp', body: bytes }))
    );

    const result = await fetchImageAsDataUri('https://edge.example/cover.webp');
    const expectedB64 = Buffer.from(bytes).toString('base64');
    expect(result).toBe(`data:image/webp;base64,${expectedB64}`);
  });

  it('strips content-type params and defaults to image/jpeg when absent', async () => {
    // params present
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ contentType: 'image/png; charset=binary' }))
    );
    expect(await fetchImageAsDataUri('https://x/y.png')).toMatch(/^data:image\/png;base64,/);

    // absent → fallback
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({ contentType: null })));
    expect(await fetchImageAsDataUri('https://x/y')).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('returns null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({ ok: false, status: 404 })));
    expect(await fetchImageAsDataUri('https://x/missing.png')).toBeNull();
  });

  it('returns null on timeout/abort (fetch rejects)', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn(async () => {
      throw abortErr;
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchImageAsDataUri('https://x/slow.png', { timeoutMs: 10 })).toBeNull();
  });

  it('returns null on a generic network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    expect(await fetchImageAsDataUri('https://x/err.png')).toBeNull();
  });

  it('returns null WITHOUT buffering when Content-Length exceeds the cap', async () => {
    const arrayBufferSpy = vi.fn();
    const fetchMock = vi.fn(async () => {
      const r = makeResponse({ contentLength: String(OG_IMAGE_MAX_BYTES + 1) });
      (r as unknown as { arrayBuffer: unknown }).arrayBuffer = arrayBufferSpy;
      return r;
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchImageAsDataUri('https://x/huge.png')).toBeNull();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('returns null on a 200 with an empty (0-byte) body', async () => {
    // A 200 with an empty body would otherwise yield `data:image/...;base64,`
    // (empty payload) that satori throws on → generic FallbackCard. The empty
    // guard returns null so the caller routes to the entity-card placeholder.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ body: new Uint8Array(0) }))
    );
    expect(await fetchImageAsDataUri('https://x/empty.png')).toBeNull();
  });

  it('returns null when the actual body exceeds the cap (header absent)', async () => {
    const big = new Uint8Array(OG_IMAGE_MAX_BYTES + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ contentLength: null, body: big }))
    );
    expect(await fetchImageAsDataUri('https://x/chunked.png')).toBeNull();
  });

  it('passes the configured timeout to AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({})));
    await fetchImageAsDataUri('https://x/y.png', { timeoutMs: 1234 });
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it('defaults the timeout to OG_IMAGE_FETCH_TIMEOUT_MS', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({})));
    await fetchImageAsDataUri('https://x/y.png');
    expect(timeoutSpy).toHaveBeenCalledWith(OG_IMAGE_FETCH_TIMEOUT_MS);
  });
});
