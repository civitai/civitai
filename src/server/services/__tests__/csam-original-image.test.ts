import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  extensionForContentType,
  MAX_ORIGINAL_IMAGE_BYTES,
  probeOriginalImage,
  readOriginalImage,
  StoredOriginalReadError,
} from '~/server/services/csam-original-image';

const BUCKET = 'test-images';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function storedObject(data: Buffer, contentType = 'image/png') {
  return {
    Body: {
      transformToByteArray: vi.fn(async () => new Uint8Array(data)),
      destroy: vi.fn(),
    },
    ContentType: contentType,
    ContentLength: data.length,
  };
}

function backendReturning(send: (command: GetObjectCommand) => Promise<unknown>) {
  const s3 = { send: vi.fn(send) };
  return { s3, backend: { s3: s3 as unknown as S3Client, bucket: BUCKET } };
}

const storageError = (name: string, httpStatusCode: number) => () =>
  Promise.reject(Object.assign(new Error(name), { name, $metadata: { httpStatusCode } }));
const missingKey = storageError('NoSuchKey', 404);

function edgeResponding(
  status: number,
  body = Buffer.alloc(0),
  headers: Record<string, string> = { 'content-type': 'image/jpeg' }
) {
  return vi.fn(async () => new Response(new Uint8Array(body), { status, headers }));
}

const image = { url: 'stored-key-uuid', type: 'image' as const, mimeType: 'image/png' };

const getCount = (s3: { send: { mock: { calls: unknown[][] } } }) =>
  s3.send.mock.calls.filter(([command]) => command instanceof GetObjectCommand).length;

/** What Node raises when a response is cut off mid-body. */
const connectionReset = () => Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

describe('readOriginalImage', () => {
  it('reads the stored object under Image.url from the upload bucket, with its sha256', async () => {
    const data = Buffer.from('the uploaded bytes');
    const { s3, backend } = backendReturning(async () => storedObject(data));
    const fetchImpl = edgeResponding(200);

    const read = await readOriginalImage(image, { backend, fetchImpl });

    expect(s3.send).toHaveBeenCalledTimes(1);
    const command = s3.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: image.url });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(read).toMatchObject({ source: 'original', contentType: 'image/png' });
    if (read.source === 'missing') throw new Error('unreachable');
    expect(read.data.equals(data)).toBe(true);
    expect(read.sha256).toBe(sha256(data));
  });

  it('falls back to the uncapped edge copy only when the object does not exist', async () => {
    const data = Buffer.from('edge bytes');
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, data);

    const read = await readOriginalImage(image, { backend, fetchImpl });

    expect(read).toMatchObject({ source: 'edge-fallback', contentType: 'image/jpeg' });
    if (read.source === 'missing') throw new Error('unreachable');
    expect(read.sha256).toBe(sha256(data));
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(image.url);
    // A width would ask the edge for a resized copy.
    expect(url).not.toMatch(/width=/);
  });

  it.each([
    ['a wrong bucket', storageError('NoSuchBucket', 404)],
    ['denied access', storageError('AccessDenied', 403)],
    ['a server error', storageError('InternalError', 500)],
    ['throttling', storageError('SlowDown', 503)],
  ])('throws on %s instead of downgrading to an edge copy', async (_, send) => {
    const { backend } = backendReturning(send);
    const fetchImpl = edgeResponding(200, Buffer.from('x'));

    await expect(readOriginalImage(image, { backend, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports missing when the edge has no copy, and never stores an edge error body', async () => {
    const { backend } = backendReturning(missingKey);

    await expect(
      readOriginalImage(image, { backend, fetchImpl: edgeResponding(404) })
    ).resolves.toEqual({ source: 'missing', reason: 'edge 404' });
    await expect(
      readOriginalImage(image, { backend, fetchImpl: edgeResponding(410) })
    ).resolves.toEqual({ source: 'missing', reason: 'edge 410' });
    await expect(
      readOriginalImage(image, {
        backend,
        fetchImpl: edgeResponding(200, Buffer.from('<html>placeholder</html>'), {
          'content-type': 'text/html',
        }),
      })
    ).resolves.toEqual({ source: 'missing', reason: 'edge copy is not media' });
  });

  it.each([401, 403])(
    'throws on an edge %i, which may pass, so the run is retried',
    async (status) => {
      const { backend } = backendReturning(missingKey);
      await expect(
        readOriginalImage(image, { backend, fetchImpl: edgeResponding(status) })
      ).rejects.toThrow(String(status));
    }
  );

  it.each([408, 429, 500, 503])('throws on an edge %i so the run is retried', async (status) => {
    const { backend } = backendReturning(missingKey);
    await expect(
      readOriginalImage(image, { backend, fetchImpl: edgeResponding(status) })
    ).rejects.toThrow(String(status));
  });

  it('does not put the requested URL in an edge request error', async () => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      throw new TypeError(`Failed to parse URL from ${String(url)}`);
    });

    const error = await readOriginalImage(image, { backend, fetchImpl }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(image.url);
  });

  it('fetches an allowed stored full URL without following redirects, skipping storage', async () => {
    const { s3, backend } = backendReturning(async () => storedObject(Buffer.from('x')));
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));
    const url = 'https://image.civitai.com/legacy/path/legacy.png';

    const read = await readOriginalImage({ url, type: 'image' }, { backend, fetchImpl });

    expect(s3.send).not.toHaveBeenCalled();
    expect(read.source).toBe('edge-fallback');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it.each([
    ['a foreign host', 'https://example.invalid/legacy.png'],
    ['a scheme-relative form', 'http:/127.0.0.1:6379/x'],
    ['an empty url', ''],
  ])('never fetches a stored full URL with %s', async (_, url) => {
    const { s3, backend } = backendReturning(async () => storedObject(Buffer.from('x')));
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));

    await expect(
      readOriginalImage({ url, type: 'image' }, { backend, fetchImpl })
    ).resolves.toEqual({ source: 'missing', reason: 'url not allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('records an edge response larger than the cap as missing, without reading it', async () => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, Buffer.from('small'), {
      'content-type': 'image/jpeg',
      'content-length': String(MAX_ORIGINAL_IMAGE_BYTES + 1),
    });

    await expect(readOriginalImage(image, { backend, fetchImpl })).resolves.toEqual({
      source: 'missing',
      reason: 'exceeds the size cap',
    });
  });

  it('records a stored object larger than the cap as missing, without reading it', async () => {
    const object = {
      ...storedObject(Buffer.from('small')),
      ContentLength: MAX_ORIGINAL_IMAGE_BYTES + 1,
    };
    const { backend } = backendReturning(async () => object);

    await expect(readOriginalImage(image, { backend })).resolves.toEqual({
      source: 'missing',
      reason: 'exceeds the size cap',
    });
    expect(object.Body.transformToByteArray).not.toHaveBeenCalled();
    expect(object.Body.destroy).toHaveBeenCalled();
  });

  it('asks the edge for identity encoding, so the declared length is what is read', async () => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, Buffer.from('edge bytes'));

    await readOriginalImage(image, { backend, fetchImpl });

    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { 'accept-encoding': 'identity' },
    });
  });

  it('reserves the object size before reading the body, and hands back the release', async () => {
    const data = Buffer.alloc(4321, 1);
    const object = storedObject(data);
    const { backend } = backendReturning(async () => object);
    const release = vi.fn();
    const reserve = vi.fn(async () => {
      expect(object.Body.transformToByteArray).not.toHaveBeenCalled();
      return release;
    });

    const read = await readOriginalImage(image, { backend, reserve });

    expect(reserve).toHaveBeenCalledWith(4321);
    if (read.source === 'missing') throw new Error('unreachable');
    expect(release).not.toHaveBeenCalled();
    read.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reserves an edge copy by its declared size before reading it', async () => {
    const { backend } = backendReturning(missingKey);
    const data = Buffer.from('edge bytes');
    const fetchImpl = edgeResponding(200, data, {
      'content-type': 'image/jpeg',
      'content-length': String(data.length),
    });
    const reserve = vi.fn(async () => () => undefined);

    await readOriginalImage(image, { backend, fetchImpl, reserve });

    expect(reserve).toHaveBeenCalledWith(data.length);
  });

  it.each([
    ['no declared size', undefined],
    ['an empty declared size', ''],
    ['a non-numeric declared size', 'abc'],
  ])('reserves the size cap for an edge copy with %s', async (_, contentLength) => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, Buffer.from('edge bytes'), {
      'content-type': 'image/jpeg',
      ...(contentLength !== undefined && { 'content-length': contentLength }),
    });
    const reserve = vi.fn(async () => () => undefined);

    await readOriginalImage(image, { backend, fetchImpl, reserve });

    expect(reserve).toHaveBeenCalledWith(MAX_ORIGINAL_IMAGE_BYTES);
  });

  it.each([
    ['the URL allowlist refuses', '\\evil.example/x.png'],
    ['leaves the image path', '../../other/path'],
    ['carries a query', 'key-uuid?x=1'],
    ['hides a dot segment', '%2e%2e/%2E%2e/other/path'],
    ['hides a slash', 'key%2Fother'],
    ['carries a fragment', 'key-uuid#x'],
    ['hides a query', 'key-uuid%3Fx=1'],
    ['is encoded twice', '%252e%252e/other/path'],
  ])('never fetches the edge for a stored key that %s', async (_, url) => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));

    await expect(
      readOriginalImage({ url, type: 'image' }, { backend, fetchImpl })
    ).resolves.toEqual({ source: 'missing', reason: 'url not allowed' });
    await expect(
      probeOriginalImage({ url, type: 'image' }, { backend, fetchImpl })
    ).resolves.toEqual({ source: 'missing', reason: 'url not allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the stored object under such a key, which storage takes as a literal name', async () => {
    const { backend } = backendReturning(async () => storedObject(Buffer.from('stored')));

    await expect(
      readOriginalImage({ url: 'x..png', type: 'image' }, { backend })
    ).resolves.toMatchObject({ source: 'original' });
  });

  it('reserves the whole cap for a compressed edge body, whose declared length is not what it holds', async () => {
    const { backend } = backendReturning(missingKey);
    const data = Buffer.from('edge bytes');
    const fetchImpl = edgeResponding(200, data, {
      'content-type': 'image/jpeg',
      'content-encoding': 'gzip',
      'content-length': '3',
    });
    const reserve = vi.fn(async () => () => undefined);

    const read = await readOriginalImage(image, { backend, fetchImpl, reserve });

    expect(reserve).toHaveBeenCalledWith(MAX_ORIGINAL_IMAGE_BYTES);
    expect(read).toMatchObject({ source: 'edge-fallback', sha256: sha256(data) });
  });

  it('releases the body of an edge error response', async () => {
    const { backend } = backendReturning(missingKey);
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => {
      const response = new Response('busy', { status: 503 });
      Object.defineProperty(response, 'body', { value: { cancel } });
      return response;
    });

    await expect(readOriginalImage(image, { backend, fetchImpl })).rejects.toThrow('503');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('gives the reservation back and frees the socket when the body read fails', async () => {
    const object = storedObject(Buffer.alloc(10));
    object.Body.transformToByteArray.mockRejectedValue(new Error('socket reset'));
    const { backend } = backendReturning(async () => object);
    const release = vi.fn();

    await expect(
      readOriginalImage(image, { backend, reserve: async () => release })
    ).rejects.toThrow('socket reset');
    expect(release).toHaveBeenCalledTimes(1);
    expect(object.Body.destroy).toHaveBeenCalled();
  });

  it('opens no body when the reservation is refused', async () => {
    const object = storedObject(Buffer.alloc(10));
    const { s3, backend } = backendReturning(async () => object);

    await expect(
      readOriginalImage(image, {
        backend,
        reserve: () => Promise.reject(new Error('archive failed')),
      })
    ).rejects.toThrow('archive failed');
    expect(object.Body.transformToByteArray).not.toHaveBeenCalled();
    expect(getCount(s3)).toBe(0);
  });

  it('prefers the stored object content type over the row, and the row over octet-stream', async () => {
    const disagreeing = backendReturning(async () => storedObject(Buffer.from('v'), 'image/webp'));
    await expect(
      readOriginalImage({ url: 'k', type: 'image', mimeType: 'image/png' }, disagreeing)
    ).resolves.toMatchObject({ contentType: 'image/webp' });

    const octet = backendReturning(async () =>
      storedObject(Buffer.from('v'), 'application/octet-stream')
    );
    await expect(
      readOriginalImage({ url: 'k', type: 'video', mimeType: 'video/mp4' }, octet)
    ).resolves.toMatchObject({ contentType: 'video/mp4' });
  });
});

describe('readOriginalImage on a dropped connection', () => {
  const stored = { ...image, id: 4242 };
  const data = Buffer.alloc(10, 7);

  /** Every GET answers with a fresh body; the bodies' reads fail per `outcomes`, then succeed. */
  function flakyBodies(outcomes: (() => Error)[]) {
    let reads = 0;
    const { s3, backend } = backendReturning(async () => {
      const object = storedObject(data);
      object.Body.transformToByteArray.mockImplementation(async () => {
        const fail = outcomes[reads++];
        if (fail) throw fail();
        return new Uint8Array(data);
      });
      return object;
    });
    return { s3, backend: { ...backend, backend: 'backblaze' } };
  }

  it.each([
    ['ECONNRESET mid-body', connectionReset],
    ['a bare "aborted"', () => new Error('aborted')],
    ['a socket hang up', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['ETIMEDOUT', () => Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['a reset wrapped as a cause', () => new Error('stream failed', { cause: connectionReset() })],
  ])('re-issues the GET after %s and returns the image', async (_, error) => {
    const { s3, backend } = flakyBodies([error]);
    const sleep = vi.fn(async () => undefined);

    const read = await readOriginalImage(stored, { backend, sleep });

    expect(read).toMatchObject({ source: 'original', sha256: sha256(data) });
    expect(getCount(s3)).toBe(2);
    expect(sleep.mock.calls).toEqual([[2000]]);
  });

  it('throws after 3 attempts, naming the image, backend, length and attempt', async () => {
    const { s3, backend } = flakyBodies([connectionReset, connectionReset, connectionReset]);
    const sleep = vi.fn(async () => undefined);

    const error = await readOriginalImage(stored, { backend, sleep }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'stored original read failed for image 4242 (backend backblaze, ContentLength 10, attempt 3/3): aborted'
    );
    expect((error as Error & { code?: string }).code).toBe('ECONNRESET');
    expect((error as Error).message).not.toContain(stored.url);
    expect(getCount(s3)).toBe(3);
    expect(sleep.mock.calls).toEqual([[2000], [8000]]);
  });

  it('marks a failure whose every attempt dropped its connection, and only that', async () => {
    const dropped = flakyBodies([connectionReset, connectionReset, connectionReset]);
    const allDropped = await readOriginalImage(stored, {
      backend: dropped.backend,
      sleep: async () => undefined,
    }).catch((e: unknown) => e);

    let gets = 0;
    const { backend } = backendReturning(async () => {
      gets += 1;
      if (gets === 1) {
        const object = storedObject(data);
        object.Body.transformToByteArray.mockRejectedValue(connectionReset());
        return object;
      }
      throw Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    });
    const thenRefused = await readOriginalImage(stored, {
      backend,
      sleep: async () => undefined,
    }).catch((e: unknown) => e);

    expect(allDropped).toBeInstanceOf(StoredOriginalReadError);
    expect((allDropped as StoredOriginalReadError).allAttemptsDropped).toBe(true);
    expect(thenRefused).toBeInstanceOf(StoredOriginalReadError);
    expect((thenRefused as StoredOriginalReadError).message).toBe(
      'stored original read failed for image 4242 (backend unknown, ContentLength unknown, attempt 2/3): Access Denied'
    );
    expect((thenRefused as StoredOriginalReadError).allAttemptsDropped).toBe(false);
  });

  it('does not retry a reset that our own read timeout caused', async () => {
    // The request is cut off by our timeout, and the cut surfaces as a reset.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    try {
      const { s3, backend } = flakyBodies([connectionReset]);
      const sleep = vi.fn(async () => undefined);

      const error = await readOriginalImage(stored, { backend, sleep }).catch((e: unknown) => e);

      expect((error as Error).message).toBe(
        'stored original read failed for image 4242 (backend backblaze, ContentLength 10, attempt 1/3): timed out: aborted'
      );
      expect((error as StoredOriginalReadError).allAttemptsDropped).toBe(false);
      expect(getCount(s3)).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("gives each failed attempt's reservation back before taking the next", async () => {
    const { backend } = flakyBodies([connectionReset, connectionReset, connectionReset]);
    let held = 0;
    let peakHeld = 0;
    const reserve = vi.fn(async () => {
      held += 1;
      peakHeld = Math.max(peakHeld, held);
      return () => {
        held -= 1;
      };
    });

    await expect(
      readOriginalImage(stored, { backend, reserve, sleep: async () => undefined })
    ).rejects.toThrow('attempt 3/3');

    expect(reserve.mock.calls).toEqual([[10], [10], [10]]);
    expect(peakHeld).toBe(1);
    expect(held).toBe(0);
  });

  it('holds exactly one reservation once a retry succeeds', async () => {
    const { backend } = flakyBodies([connectionReset]);
    let held = 0;
    const reserve = vi.fn(async () => {
      held += 1;
      return () => {
        held -= 1;
      };
    });

    const read = await readOriginalImage(stored, {
      backend,
      reserve,
      sleep: async () => undefined,
    });

    expect(held).toBe(1);
    if (read.source === 'missing') throw new Error('unreachable');
    read.release();
    expect(held).toBe(0);
  });

  it.each([
    ['a server error the SDK already retried', 'InternalError', 500],
    ['denied access', 'AccessDenied', 403],
  ])('does not retry %s', async (_, name, httpStatusCode) => {
    const { s3, backend } = backendReturning(storageError(name, httpStatusCode));
    const sleep = vi.fn(async () => undefined);

    await readOriginalImage(stored, { backend, sleep, fetchImpl: edgeResponding(404) }).catch(
      () => undefined
    );

    expect(getCount(s3)).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('still falls back to the edge for a missing key, without retrying', async () => {
    const { s3, backend } = backendReturning(missingKey);
    const sleep = vi.fn(async () => undefined);

    await expect(
      readOriginalImage(stored, { backend, sleep, fetchImpl: edgeResponding(404) })
    ).resolves.toEqual({ source: 'missing', reason: 'edge 404' });
    expect(getCount(s3)).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry its own read timeout', async () => {
    const timeout = () =>
      Object.assign(new Error('aborted'), { name: 'TimeoutError', code: 'ECONNRESET' });
    const { s3, backend } = flakyBodies([timeout]);
    const sleep = vi.fn(async () => undefined);

    await expect(readOriginalImage(stored, { backend, sleep })).rejects.toThrow('attempt 1/3');
    expect(getCount(s3)).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes a refused reservation through as is, without retrying, even if it reads like a reset', async () => {
    // A failed archive rejects every reservation with the error that failed it.
    const refusal = connectionReset();
    const { s3, backend } = flakyBodies([]);
    const sleep = vi.fn(async () => undefined);

    const error = await readOriginalImage(stored, {
      backend,
      sleep,
      reserve: () => Promise.reject(refusal),
    }).catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(getCount(s3)).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reserves before the GET is issued, so no response idles on a socket waiting for budget', async () => {
    const { s3, backend } = flakyBodies([]);
    let getsAtReserve: number | undefined;
    const reserve = vi.fn(async () => {
      getsAtReserve = getCount(s3);
      return () => undefined;
    });

    await readOriginalImage(stored, { backend, reserve });

    expect(getsAtReserve).toBe(0);
    expect(s3.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(s3.send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: stored.url });
  });

  it('reserves after the GET headers when the HEAD finds nothing, as before', async () => {
    const { s3, backend } = backendReturning(async (command) => {
      if (command instanceof HeadObjectCommand)
        throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return storedObject(data);
    });
    const reserve = vi.fn(async () => () => undefined);

    await expect(readOriginalImage(stored, { backend, reserve })).resolves.toMatchObject({
      source: 'original',
    });
    expect(reserve.mock.calls).toEqual([[10]]);
    expect(getCount(s3)).toBe(1);
  });

  it('tops the reservation up when the GET declares more than the HEAD did', async () => {
    const { backend } = backendReturning(async (command) =>
      command instanceof HeadObjectCommand ? { ContentLength: 4 } : storedObject(data)
    );
    let held = 0;
    const reserve = vi.fn(async (bytes: number) => {
      held += bytes;
      return () => {
        held -= bytes;
      };
    });

    const read = await readOriginalImage(stored, { backend, reserve });

    expect(reserve.mock.calls).toEqual([[4], [10]]);
    expect(held).toBe(10);
    if (read.source === 'missing') throw new Error('unreachable');
    read.release();
    expect(held).toBe(0);
  });

  it('records a stored object the HEAD finds over the cap as missing, without a GET', async () => {
    const { s3, backend } = backendReturning(async () => ({
      ContentLength: MAX_ORIGINAL_IMAGE_BYTES + 1,
    }));
    const reserve = vi.fn(async () => () => undefined);

    await expect(readOriginalImage(stored, { backend, reserve })).resolves.toEqual({
      source: 'missing',
      reason: 'exceeds the size cap',
    });
    expect(getCount(s3)).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('probeOriginalImage', () => {
  it.each([
    ['a foreign host', 'https://example.invalid/legacy.png'],
    ['a scheme-relative form', 'http:/127.0.0.1:6379/x'],
    ['a stored key that leaves the image path', '../../other/path'],
  ])('never fetches %s', async (_, url) => {
    const { backend } = backendReturning(missingKey);
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));

    await expect(
      probeOriginalImage({ url, type: 'image' }, { backend, fetchImpl })
    ).resolves.toEqual({
      source: 'missing',
      reason: 'url not allowed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks an allowed full URL at the edge without asking storage', async () => {
    const { s3, backend } = backendReturning(async () => ({ ContentLength: 1 }));
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));

    await expect(
      probeOriginalImage(
        { url: 'https://image.civitai.com/legacy/path/legacy.png', type: 'image' },
        { backend, fetchImpl }
      )
    ).resolves.toEqual({ source: 'edge-fallback' });
    expect(s3.send).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('asks storage for the headers only, and reads no bytes', async () => {
    const { s3, backend } = backendReturning(async () => ({ ContentLength: 10 }));
    const fetchImpl = edgeResponding(200);

    await expect(probeOriginalImage(image, { backend, fetchImpl })).resolves.toEqual({
      source: 'original',
    });
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(s3.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(s3.send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: image.url });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('finds a stored object larger than the cap missing, as the read would', async () => {
    const { backend } = backendReturning(async () => ({
      ContentLength: MAX_ORIGINAL_IMAGE_BYTES + 1,
    }));

    await expect(probeOriginalImage(image, { backend })).resolves.toEqual({
      source: 'missing',
      reason: 'exceeds the size cap',
    });
  });

  it.each([
    ['NotFound', storageError('NotFound', 404)],
    ['NoSuchKey', storageError('NoSuchKey', 404)],
  ])('checks the edge when storage answers %s, releasing its body', async (_, send) => {
    const { backend } = backendReturning(send);
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => {
      const response = new Response('edge bytes', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
      Object.defineProperty(response, 'body', { value: { cancel } });
      return response;
    });

    await expect(probeOriginalImage(image, { backend, fetchImpl })).resolves.toEqual({
      source: 'edge-fallback',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('finds a file the edge does not have missing', async () => {
    const { backend } = backendReturning(storageError('NotFound', 404));

    await expect(
      probeOriginalImage(image, { backend, fetchImpl: edgeResponding(404) })
    ).resolves.toEqual({ source: 'missing', reason: 'edge 404' });
  });

  it.each([
    ['a storage server error', storageError('InternalError', 500), edgeResponding(200)],
    ['an edge server error', storageError('NotFound', 404), edgeResponding(503)],
  ])('throws on %s, as the read would', async (_, send, fetchImpl) => {
    const { backend } = backendReturning(send);

    await expect(probeOriginalImage(image, { backend, fetchImpl })).rejects.toThrow();
  });
});

describe('extensionForContentType', () => {
  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['application/octet-stream', 'bin'],
    ['application/hta', 'bin'],
    ['application/js', 'bin'],
    ['text/html', 'bin'],
    ['image/svg+xml', 'bin'],
    ['image/../../etc', 'bin'],
  ])('%s -> %s', (contentType, extension) => {
    expect(extensionForContentType(contentType)).toBe(extension);
  });
});
