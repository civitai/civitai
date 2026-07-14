import { describe, it, expect } from 'vitest';
import { createStorageClient } from '../client';

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

type Recorder = {
  presigns: number[];
  puts: { partNumber: number; size: number }[];
  complete?: { parts: { ETag: string; PartNumber: number }[] };
  aborted: boolean;
};

// A fetch that stands in for BOTH the storage service (POST /multipart/*, /presign/get) and S3 itself
// (the presigned part PUTs + the object GET). `failPart` forces one part's PUT to 500.
function routingFetch(rec: Recorder, opts: { failPart?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'PUT') {
      const partNumber = Number(url.match(/\/part\/(\d+)$/)?.[1]);
      rec.puts.push({ partNumber, size: (init!.body as Uint8Array).byteLength });
      if (opts.failPart === partNumber) return new Response('boom', { status: 500 });
      return new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });
    }
    if (url.endsWith('/multipart/create')) return json({ uploadId: 'u1', bucket: 'b', key: 'k' });
    if (url.endsWith('/multipart/presign-part')) {
      const body = JSON.parse(init!.body as string) as { partNumber: number };
      rec.presigns.push(body.partNumber);
      return json({ url: `https://s3/part/${body.partNumber}`, partNumber: body.partNumber });
    }
    if (url.endsWith('/multipart/complete')) {
      rec.complete = JSON.parse(init!.body as string);
      return json({ ok: true });
    }
    if (url.endsWith('/multipart/abort')) {
      rec.aborted = true;
      return json({ ok: true });
    }
    if (url.endsWith('/presign/get')) return json({ url: 'https://s3/obj', bucket: 'b', key: 'k' });
    if (url === 'https://s3/obj') return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as typeof fetch;
}

async function* source(sizes: number[]): AsyncGenerator<Uint8Array> {
  for (const n of sizes) yield new Uint8Array(n);
}

const newRecorder = (): Recorder => ({ presigns: [], puts: [], aborted: false });

describe('client.uploadStream', () => {
  it('creates, presigns+PUTs each chunk, and completes with assembled parts', async () => {
    const rec = newRecorder();
    const client = createStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });

    // 120 bytes in, 100-byte chunks → 2 parts: [100, 20].
    const result = await client.uploadStream({ key: 'k', chunkSize: 100 }, source([40, 40, 40]));

    expect(result).toEqual({
      bucket: 'b',
      key: 'k',
      parts: [
        { ETag: '"etag-1"', PartNumber: 1 },
        { ETag: '"etag-2"', PartNumber: 2 },
      ],
    });
    expect(rec.presigns).toEqual([1, 2]);
    expect(rec.puts.map((p) => p.size)).toEqual([100, 20]);
    expect(rec.complete?.parts).toEqual(result.parts);
    expect(rec.aborted).toBe(false);
  });

  it('reports cumulative progress ending at the total', async () => {
    const rec = newRecorder();
    const client = createStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });
    const seen: number[] = [];
    await client.uploadStream({ key: 'k', chunkSize: 100 }, source([40, 40, 40]), {
      onProgress: (loaded) => seen.push(loaded),
    });
    expect(seen).toEqual([100, 120]);
  });

  it('aborts the upload when a part fails', async () => {
    const rec = newRecorder();
    const client = createStorageClient({
      endpoint: 'http://storage.test',
      fetch: routingFetch(rec, { failPart: 2 }),
    });
    await expect(
      client.uploadStream({ key: 'k', chunkSize: 100 }, source([40, 40, 40]))
    ).rejects.toThrow(/part upload failed \(500\)/);
    expect(rec.aborted).toBe(true);
    expect(rec.complete).toBeUndefined();
  });
});

describe('client.getObjectBuffer', () => {
  it('presigns a GET then fetches the bytes', async () => {
    const rec = newRecorder();
    const client = createStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });
    const buf = await client.getObjectBuffer({ backend: 'default', key: 'k' });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
