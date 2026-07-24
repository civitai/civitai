import { describe, it, expect } from 'vitest';
import { createCsamStorageClient } from '../client';

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// Records every POST body the CSAM client sends to the storage service so the tests can assert the
// isolation invariant: `backend` is always `csam`, and no `bucket` override ever leaks out.
type Recorder = { bodies: Record<string, unknown>[] };

function routingFetch(rec: Recorder): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'PUT') {
      const partNumber = Number(url.match(/\/part\/(\d+)$/)?.[1]);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });
    }
    if (method === 'POST') rec.bodies.push(JSON.parse(init!.body as string));

    if (url.endsWith('/presign/put')) return json({ url: 'https://s3/put', bucket: 'csam', key: 'k' });
    if (url.endsWith('/presign/get')) return json({ url: 'https://s3/obj', bucket: 'csam', key: 'k' });
    if (url.endsWith('/objects/head')) return json({ exists: true, size: 4 });
    if (url.endsWith('/objects/delete')) return json({ ok: true });
    if (url.endsWith('/multipart/create')) return json({ uploadId: 'u1', bucket: 'csam', key: 'k' });
    if (url.endsWith('/multipart/presign-part')) {
      const body = JSON.parse(init!.body as string) as { partNumber: number };
      return json({ url: `https://s3/part/${body.partNumber}`, partNumber: body.partNumber });
    }
    if (url.endsWith('/multipart/complete')) return json({ ok: true });
    if (url.endsWith('/multipart/abort')) return json({ ok: true });
    if (url === 'https://s3/obj') return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as typeof fetch;
}

async function* source(sizes: number[]): AsyncGenerator<Uint8Array> {
  for (const n of sizes) yield new Uint8Array(n);
}

describe('createCsamStorageClient', () => {
  it('pins backend:csam on every request and never lets the caller pick a bucket', async () => {
    const rec: Recorder = { bodies: [] };
    const client = createCsamStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });

    // Single-shot ops the caller shapes directly: no `bucket` reaches the wire.
    await client.getPutUrl({ key: 'k' });
    await client.headObject({ key: 'k' });
    await client.deleteObject({ key: 'k' });
    await client.getObjectBuffer({ key: 'k' });
    for (const body of rec.bodies) {
      expect(body).toMatchObject({ backend: 'csam' });
      expect(body).not.toHaveProperty('bucket');
    }

    // Multipart follow-ups may echo a `bucket`, but only the service-RESOLVED csam bucket — never a
    // caller-supplied one. Every body still names the csam backend.
    rec.bodies = [];
    await client.uploadStream({ key: 'k', chunkSize: 100 }, source([250]));
    expect(rec.bodies.length).toBeGreaterThan(0);
    for (const body of rec.bodies) {
      expect(body).toMatchObject({ backend: 'csam' });
      if ('bucket' in body) expect((body as { bucket: string }).bucket).toBe('csam');
    }
  });

  it('streams an upload end-to-end against the csam backend', async () => {
    const rec: Recorder = { bodies: [] };
    const client = createCsamStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });

    const result = await client.uploadStream({ key: 'evidence.zip', chunkSize: 100 }, source([250]));

    expect(result.parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(rec.bodies.every((b) => (b as { backend: string }).backend === 'csam')).toBe(true);
  });

  it('reads an object buffer through a csam-scoped presign', async () => {
    const rec: Recorder = { bodies: [] };
    const client = createCsamStorageClient({ endpoint: 'http://storage.test', fetch: routingFetch(rec) });

    const buf = await client.getObjectBuffer({ key: 'evidence.zip' });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
