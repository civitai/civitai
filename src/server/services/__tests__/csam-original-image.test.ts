import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type * as FsPromises from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extensionForContentType,
  MAX_ORIGINAL_IMAGE_BYTES,
  probeOriginalImage,
  RANGE_PART_BYTES,
  readOriginalImage,
  SPOOL_THRESHOLD_BYTES,
  spoolOriginalImage,
} from '~/server/services/csam-original-image';

// Set to cap how many bytes each spool write call may write, as a full disk does.
const shortWrites = vi.hoisted(() => ({ limit: undefined as number | undefined }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const write = handle.write.bind(handle) as (...a: unknown[]) => ReturnType<typeof handle.write>;
    const limit = shortWrites.limit;
    if (limit !== undefined)
      Object.assign(handle, {
        write: (buffer: Buffer, offset = 0, length = buffer.length - offset) =>
          write(buffer, offset, Math.min(length, limit)),
      });
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

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
    const { s3, backend } = backendReturning(send);
    const fetchImpl = edgeResponding(200, Buffer.from('x'));

    await expect(readOriginalImage(image, { backend, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Only a socket failure is retried.
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it('does not retry a read cut off by its own timeout, which surfaces as a reset', async () => {
    const timeouts: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    try {
      const { s3, backend } = backendReturning(async () => {
        timeouts.at(-1)!.abort();
        throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
      });

      await expect(readOriginalImage(image, { backend })).rejects.toThrow('aborted');
      expect(s3.send).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
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

  it('frees the socket when the reservation is refused', async () => {
    const object = storedObject(Buffer.alloc(10));
    const { backend } = backendReturning(async () => object);

    await expect(
      readOriginalImage(image, {
        backend,
        reserve: () => Promise.reject(new Error('archive failed')),
      })
    ).rejects.toThrow('archive failed');
    expect(object.Body.transformToByteArray).not.toHaveBeenCalled();
    expect(object.Body.destroy).toHaveBeenCalled();
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

describe('spoolOriginalImage', () => {
  const ETAG = '"etag-2"';
  // Distinct at every offset, so a part written out of order or twice changes the hash.
  const large = Buffer.alloc(SPOOL_THRESHOLD_BYTES + RANGE_PART_BYTES + 12345);
  for (let i = 0; i + 4 <= large.length; i += 4) large.writeUInt32BE(i, i);
  const reset = () => Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

  let spoolDir: string;
  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), 'csam-spool-test-'));
  });
  afterEach(() => {
    rmSync(spoolDir, { recursive: true, force: true });
  });
  const spooled = () => readdirSync(spoolDir);

  /** A store holding `data`. `part` decides each ranged response, by part index and attempt. */
  function largeStore(
    data: Buffer,
    part: (index: number, attempt: number, range: { start: number; end: number }) => unknown = () =>
      undefined
  ) {
    const attempts = new Map<number, number>();
    const inputs: { Range?: string; IfMatch?: string }[] = [];
    const { s3, backend } = backendReturning(async (command) => {
      const input = command.input as { Range?: string; IfMatch?: string };
      inputs.push(input);
      if (!input.Range)
        return { ...storedObject(data, 'video/mp4'), ETag: ETAG, ContentLength: data.length };
      const [start, end] = input.Range.replace('bytes=', '').split('-').map(Number);
      const index = start / RANGE_PART_BYTES;
      const attempt = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, attempt);
      const override = part(index, attempt, { start, end });
      if (override instanceof Error) throw override;
      return (
        override ?? {
          Body: {
            transformToByteArray: async () => new Uint8Array(data.subarray(start, end + 1)),
            destroy: vi.fn(),
          },
          ContentRange: `bytes ${start}-${end}/${data.length}`,
          ETag: ETAG,
        }
      );
    });
    return { s3, backend, inputs };
  }

  it('reads a large stored object in ranged parts of one version into a file, retrying a part that resets', async () => {
    const { backend, inputs } = largeStore(large, (index, attempt) =>
      index === 0 && attempt === 1 ? reset() : undefined
    );
    const onRetry = vi.fn();
    const release = vi.fn();
    const reserve = vi.fn(async () => release);

    const read = await spoolOriginalImage(image, { backend, spoolDir, onRetry, reserve });

    if (!('path' in read)) throw new Error('expected a spooled read');
    expect(read).toMatchObject({
      source: 'original',
      bytes: large.length,
      contentType: 'video/mp4',
    });
    expect(read.sha256).toBe(sha256(large));
    expect(sha256(readFileSync(read.path))).toBe(sha256(large));
    const ranged = inputs.filter((input) => input.Range);
    expect(ranged.map((input) => input.Range)).toEqual([
      `bytes=0-${RANGE_PART_BYTES - 1}`,
      `bytes=0-${RANGE_PART_BYTES - 1}`,
      `bytes=${RANGE_PART_BYTES}-${2 * RANGE_PART_BYTES - 1}`,
      `bytes=${2 * RANGE_PART_BYTES}-${3 * RANGE_PART_BYTES - 1}`,
      `bytes=${3 * RANGE_PART_BYTES}-${large.length - 1}`,
    ]);
    expect(ranged.every((input) => input.IfMatch === ETAG)).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1);
    expect(reserve).toHaveBeenCalledWith(large.length);
    expect(spooled()).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();

    read.release();
    read.release();
    expect(spooled()).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a large object whose response names no version, before reading any part', async () => {
    const { s3, backend } = largeStore(large);
    const send = s3.send.getMockImplementation()!;
    s3.send.mockImplementation(async (command) => {
      const response = (await send(command)) as Record<string, unknown>;
      return { ...response, ETag: undefined };
    });

    await expect(spoolOriginalImage(image, { backend, spoolDir })).rejects.toThrow(/no ETag/);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(spooled()).toEqual([]);
  });

  it('writes a whole part when a write call writes less than it was given', async () => {
    const { backend } = largeStore(large);
    shortWrites.limit = 3 * 1024 * 1024 + 7;
    try {
      const read = await spoolOriginalImage(image, { backend, spoolDir });

      if (!('path' in read)) throw new Error('expected a spooled read');
      expect(sha256(readFileSync(read.path))).toBe(sha256(large));
      read.release();
    } finally {
      shortWrites.limit = undefined;
    }
  });

  it('keeps the single in-memory read for an object at or under the threshold', async () => {
    const data = Buffer.alloc(SPOOL_THRESHOLD_BYTES, 7);
    const { s3, backend, inputs } = largeStore(data);

    const read = await spoolOriginalImage(image, { backend, spoolDir });

    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(inputs[0].Range).toBeUndefined();
    if (read.source === 'missing' || 'path' in read) throw new Error('expected an in-memory read');
    expect(read.sha256).toBe(sha256(data));
    expect(spooled()).toEqual([]);
  });

  it('throws on a part shorter than its range, and removes the file', async () => {
    const { backend } = largeStore(large, (index, _attempt, { start, end }) =>
      index === 1
        ? {
            Body: {
              transformToByteArray: async () => new Uint8Array(large.subarray(start, end)),
              destroy: vi.fn(),
            },
            ContentRange: `bytes ${start}-${end}/${large.length}`,
            ETag: ETAG,
          }
        : undefined
    );

    await expect(spoolOriginalImage(image, { backend, spoolDir })).rejects.toThrow(/wrong size/);
    expect(spooled()).toEqual([]);
  });

  it('throws on a part outside the range it asked for, before reading it', async () => {
    const transformToByteArray = vi.fn(async () => new Uint8Array(large));
    const { backend } = largeStore(large, (index) =>
      index === 0
        ? { Body: { transformToByteArray, destroy: vi.fn() }, ContentLength: large.length }
        : undefined
    );

    await expect(spoolOriginalImage(image, { backend, spoolDir })).rejects.toThrow(/wrong range/);
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(spooled()).toEqual([]);
  });

  it('fails without retrying on a part from another version, even when the store ignores If-Match', async () => {
    const transformToByteArray = vi.fn(async () => new Uint8Array(RANGE_PART_BYTES));
    const destroy = vi.fn();
    const { backend, inputs } = largeStore(large, (index, _attempt, { start, end }) =>
      index === 1
        ? {
            Body: { transformToByteArray, destroy },
            ContentRange: `bytes ${start}-${end}/${large.length}`,
            ETag: '"etag-3"',
          }
        : undefined
    );

    await expect(spoolOriginalImage(image, { backend, spoolDir })).rejects.toThrow(
      /another version/
    );
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(
      inputs.filter((input) => input.Range?.startsWith(`bytes=${RANGE_PART_BYTES}-`))
    ).toHaveLength(1);
    expect(spooled()).toEqual([]);
  });

  it('fails without retrying when the object changes between parts, and removes the file', async () => {
    const changed = Object.assign(new Error('PreconditionFailed'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
    const { backend, inputs } = largeStore(large, (index) => (index === 2 ? changed : undefined));

    await expect(spoolOriginalImage(image, { backend, spoolDir })).rejects.toThrow(
      'PreconditionFailed'
    );
    expect(
      inputs.filter((input) => input.Range?.startsWith(`bytes=${2 * RANGE_PART_BYTES}-`))
    ).toHaveLength(1);
    expect(spooled()).toEqual([]);
  });

  it('gives up on a part that keeps resetting, removes the file and returns the reservation', async () => {
    const { backend, inputs } = largeStore(large, (index) => (index === 1 ? reset() : undefined));
    const release = vi.fn();
    const reserve = vi.fn(async () => release);

    await expect(spoolOriginalImage(image, { backend, spoolDir, reserve })).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
    expect(reserve).toHaveBeenCalledWith(large.length);
    expect(release).toHaveBeenCalled();
    expect(
      inputs.filter((input) => input.Range?.startsWith(`bytes=${RANGE_PART_BYTES}-`))
    ).toHaveLength(3);
    expect(spooled()).toEqual([]);
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
