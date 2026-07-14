import { describe, it, expect, vi, afterEach } from 'vitest';
import { uploadToPresignedUrl, uploadMultipart } from '../upload';
import type { PresignMultipartResult } from '../schema';

// In the vitest node env there's no XMLHttpRequest, so putBlob takes the fetch fallback path — mock it.
function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function ok(etag: string): Response {
  return { ok: true, status: 200, headers: new Headers({ ETag: etag }) } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('uploadToPresignedUrl', () => {
  it('PUTs the body and returns the ETag', async () => {
    const fetchFn = mockFetch(() => ok('"single-etag"'));
    const body = new Blob([new Uint8Array(1234)]);
    const res = await uploadToPresignedUrl('https://s3/put', body, { contentType: 'image/png' });
    expect(res.etag).toBe('"single-etag"');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('reports 100% progress on completion', async () => {
    mockFetch(() => ok('"e"'));
    const onProgress = vi.fn();
    await uploadToPresignedUrl('https://s3/put', new Blob([new Uint8Array(100)]), { onProgress });
    const last = onProgress.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ loaded: 100, total: 100, percent: 100 });
  });

  it('throws on a non-2xx response', async () => {
    mockFetch(() => ({ ok: false, status: 403, headers: new Headers() }) as Response);
    await expect(uploadToPresignedUrl('https://s3/put', new Blob([new Uint8Array(1)]))).rejects.toThrow(
      /upload failed \(403\)/
    );
  });
});

describe('uploadMultipart', () => {
  const presign = (chunkSize: number, parts: number): PresignMultipartResult => ({
    urls: Array.from({ length: parts }, (_, i) => ({ url: `https://s3/part/${i + 1}`, partNumber: i + 1 })),
    bucket: 'b',
    key: 'k',
    uploadId: 'u1',
    chunkSize,
  });

  it('slices by chunkSize, PUTs each part, and assembles ordered parts', async () => {
    let n = 0;
    const fetchFn = mockFetch(() => ok(`"etag-${++n}"`));
    // 25-byte file, 10-byte chunks → 3 parts: [0,10) [10,20) [20,25).
    const file = new Blob([new Uint8Array(25)]);
    const result = await uploadMultipart(presign(10, 3), file);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      bucket: 'b',
      key: 'k',
      uploadId: 'u1',
      parts: [
        { ETag: '"etag-1"', PartNumber: 1 },
        { ETag: '"etag-2"', PartNumber: 2 },
        { ETag: '"etag-3"', PartNumber: 3 },
      ],
    });
    // Last part is the remainder (5 bytes), not a full chunk.
    const lastBody = fetchFn.mock.calls[2][1].body as Blob;
    expect(lastBody.size).toBe(5);
  });

  it('retries a failing part then succeeds', async () => {
    let call = 0;
    const fetchFn = mockFetch(() => {
      call++;
      if (call === 1) return { ok: false, status: 500, headers: new Headers() } as Response;
      return ok('"etag"');
    });
    const result = await uploadMultipart(presign(10, 1), new Blob([new Uint8Array(5)]), {
      retryBaseMs: 1,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.parts).toEqual([{ ETag: '"etag"', PartNumber: 1 }]);
  });

  it('throws when a part is missing its ETag (CORS not exposing it)', async () => {
    mockFetch(() => ({ ok: true, status: 200, headers: new Headers() }) as Response);
    await expect(uploadMultipart(presign(10, 1), new Blob([new Uint8Array(5)]))).rejects.toThrow(
      /must expose the ETag/
    );
  });

  it('aborts before starting when the signal is already aborted', async () => {
    mockFetch(() => ok('"e"'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadMultipart(presign(10, 1), new Blob([new Uint8Array(5)]), { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
  });

  it('reports aggregate progress across parts (ends at 100%)', async () => {
    mockFetch(() => ok('"e"'));
    const onProgress = vi.fn();
    await uploadMultipart(presign(10, 3), new Blob([new Uint8Array(25)]), { onProgress });
    const last = onProgress.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ loaded: 25, total: 25, percent: 100 });
  });
});
