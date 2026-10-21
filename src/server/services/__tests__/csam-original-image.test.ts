import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { extensionForContentType, readOriginalImage } from '~/server/services/csam-original-image';

const BUCKET = 'test-images';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function storedObject(data: Buffer, contentType = 'image/png') {
  return {
    Body: { transformToByteArray: vi.fn(async () => new Uint8Array(data)) },
    ContentType: contentType,
    ContentLength: data.length,
  };
}

function backendReturning(send: (command: GetObjectCommand) => Promise<unknown>) {
  const s3 = { send: vi.fn(send) };
  return { s3, backend: { s3: s3 as unknown as S3Client, bucket: BUCKET } };
}

const missingKey = () => Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));

function edgeResponding(status: number, body = Buffer.alloc(0), contentType = 'image/jpeg') {
  return vi.fn(
    async () =>
      new Response(status === 204 ? null : new Uint8Array(body), {
        status,
        headers: { 'content-type': contentType },
      })
  );
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
    const fetchImpl = edgeResponding(200, data, 'image/jpeg');

    const read = await readOriginalImage(image, { backend, fetchImpl });

    expect(read).toMatchObject({ source: 'edge-fallback', contentType: 'image/jpeg' });
    if (read.source === 'missing') throw new Error('unreachable');
    expect(read.sha256).toBe(sha256(data));
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(image.url);
    // A width would ask the edge for a resized copy.
    expect(url).not.toMatch(/width=/);
  });

  it('treats a 404 status without the NoSuchKey name as missing too', async () => {
    const { backend } = backendReturning(() =>
      Promise.reject(Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } }))
    );
    const fetchImpl = edgeResponding(200, Buffer.from('x'));

    await expect(readOriginalImage(image, { backend, fetchImpl })).resolves.toMatchObject({
      source: 'edge-fallback',
    });
  });

  it('throws on any other storage error instead of downgrading to an edge copy', async () => {
    const { backend } = backendReturning(() =>
      Promise.reject(Object.assign(new Error('throttled'), { name: 'SlowDown' }))
    );
    const fetchImpl = edgeResponding(200, Buffer.from('x'));

    await expect(readOriginalImage(image, { backend, fetchImpl })).rejects.toThrow('throttled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports missing when the edge has no copy either, and throws on an edge server error', async () => {
    const { backend } = backendReturning(missingKey);

    await expect(
      readOriginalImage(image, { backend, fetchImpl: edgeResponding(404) })
    ).resolves.toEqual({ source: 'missing' });
    await expect(
      readOriginalImage(image, { backend, fetchImpl: edgeResponding(503) })
    ).rejects.toThrow('503');
  });

  it('never archives an edge error body as an image', async () => {
    const { backend } = backendReturning(missingKey);
    const read = await readOriginalImage(image, {
      backend,
      fetchImpl: edgeResponding(403, Buffer.from('<html>forbidden</html>'), 'text/html'),
    });
    expect(read).toEqual({ source: 'missing' });
  });

  it('goes straight to the URL for a row that stores a full URL rather than a key', async () => {
    const { s3, backend } = backendReturning(async () => storedObject(Buffer.from('x')));
    const fetchImpl = edgeResponding(200, Buffer.from('remote'));

    const read = await readOriginalImage(
      { url: 'https://example.invalid/legacy.png', type: 'image' },
      { backend, fetchImpl }
    );

    expect(s3.send).not.toHaveBeenCalled();
    expect(read.source).toBe('edge-fallback');
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

  it('gives the reservation back when the body read fails', async () => {
    const object = storedObject(Buffer.alloc(10));
    object.Body.transformToByteArray.mockRejectedValue(new Error('socket reset'));
    const { backend } = backendReturning(async () => object);
    const release = vi.fn();

    await expect(
      readOriginalImage(image, { backend, reserve: async () => release })
    ).rejects.toThrow('socket reset');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes the content type from the stored row when the object only says octet-stream', async () => {
    const { backend } = backendReturning(async () =>
      storedObject(Buffer.from('v'), 'application/octet-stream')
    );
    const read = await readOriginalImage(
      { url: 'k', type: 'video', mimeType: 'video/mp4' },
      { backend }
    );
    expect(read).toMatchObject({ contentType: 'video/mp4' });
  });
});

describe('extensionForContentType', () => {
  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['video/mp4', 'mp4'],
    ['image/svg+xml', 'svg+xml'],
    ['application/octet-stream', 'bin'],
    ['image/../../etc', 'bin'],
    ['image/a b', 'bin'],
    ['nonsense', 'bin'],
  ])('%s -> %s', (contentType, extension) => {
    expect(extensionForContentType(contentType)).toBe(extension);
  });
});
