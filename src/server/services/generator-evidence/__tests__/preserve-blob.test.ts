import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceStore } from '~/server/services/generator-evidence/preserve-blob';
import { preserveBlob } from '~/server/services/generator-evidence/preserve-blob';

/** Copying one generator blob into the evidence store. Every id, host and byte below is invented. */

const config = {
  base: 'https://orchestrator.example.invalid',
  origin: 'https://orchestrator.example.invalid',
  token: 'test-token',
};
const BLOB = 'ABCDEF0123456789.png';
const bytes = Buffer.from('original bytes of the file');
const sha = createHash('sha256').update(bytes).digest('hex');

type Route = (url: URL, init?: RequestInit) => Response;
let routes: Route;
const calls: { url: URL; method: string }[] = [];

function memoryStore(override?: Partial<EvidenceStore>) {
  const objects = new Map<string, Buffer>();
  const store: EvidenceStore & { objects: Map<string, Buffer> } = {
    objects,
    read: async (key: string) => new Uint8Array(objects.get(key) ?? Buffer.alloc(0)),
    upload: vi.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    }),
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { bytes: object.length } : null;
    }),
    sha256: vi.fn(async (key: string) =>
      createHash('sha256')
        .update(objects.get(key) ?? Buffer.alloc(0))
        .digest('hex')
    ),
    ...override,
  };
  return store;
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 308, headers: { location, ...headers } });

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET' });
    return routes(url, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const input = {
  userId: 7,
  jobKey: '7-20261101000000000000',
  blobId: BLOB,
  role: 'output' as const,
  moderatorId: 1,
};

describe('preserveBlob', () => {
  it('copies the original, hashing it, and reads the copy back before calling it preserved', async () => {
    routes = (url) =>
      url.pathname === `/v2/consumer/blobs/${BLOB}`
        ? redirect('/v2/consumer/blobs/content/signed-token')
        : new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    const store = memoryStore();

    const result = await preserveBlob({ config, store }, input);

    expect(result).toMatchObject({ status: 'preserved', sha256: sha, bytes: bytes.length });
    expect(store.objects.get(result.evidenceKey as string)?.equals(bytes)).toBe(true);
  });

  it('never uploads the placeholder a withheld blob redirects to', async () => {
    routes = (url) =>
      url.pathname.endsWith('/refresh')
        ? new Response('{}', { status: 200 })
        : url.pathname === `/v2/consumer/blobs/${BLOB}`
        ? redirect('/v2/consumer/blobs/blocked/placeholder-token', {
            'x-blocked-reason': 'Withheld',
          })
        : new Response(Buffer.from('placeholder png'), {
            status: 403,
            headers: { 'content-type': 'image/png' },
          });
    const store = memoryStore();

    const result = await preserveBlob({ config, store }, input);

    expect(result).toMatchObject({ status: 'blocked-unreadable', blockedReason: 'Withheld' });
    expect(store.upload).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.pathname.includes('/blocked/'))).toBe(false);
  });

  it('never uploads a content response that says it is withheld', async () => {
    routes = (url) =>
      url.pathname.endsWith('/refresh')
        ? new Response('{}', { status: 200 })
        : url.pathname === `/v2/consumer/blobs/${BLOB}`
        ? redirect('/v2/consumer/blobs/content/signed-token')
        : new Response(Buffer.from('placeholder png'), {
            status: 200,
            headers: { 'content-type': 'image/png', 'x-blocked-reason': 'Withheld' },
          });
    const store = memoryStore();

    const result = await preserveBlob({ config, store }, input);

    expect(result.status).toBe('blocked-unreadable');
    expect(store.upload).not.toHaveBeenCalled();
  });

  it('never uploads a body that is not media', async () => {
    routes = (url) =>
      url.pathname === `/v2/consumer/blobs/${BLOB}`
        ? redirect('/v2/consumer/blobs/content/signed-token')
        : new Response('<html>error</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
    const store = memoryStore();

    const result = await preserveBlob({ config, store }, input);

    expect(result.status).toBe('unavailable');
    expect(store.upload).not.toHaveBeenCalled();
  });

  it('does not call a copy preserved when it reads back different bytes', async () => {
    routes = (url) =>
      url.pathname === `/v2/consumer/blobs/${BLOB}`
        ? redirect('/v2/consumer/blobs/content/signed-token')
        : new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    const store = memoryStore({ sha256: vi.fn(async () => 'f'.repeat(64)) });

    const result = await preserveBlob({ config, store }, input);

    expect(result.status).toBe('unavailable');
    expect(result.evidenceKey).toBeUndefined();
  });

  it('reads by key alone and restarts retention through the blob route, never a workflow route', async () => {
    routes = (url) =>
      url.pathname.endsWith('/refresh')
        ? new Response('{}', { status: 200 })
        : redirect('/v2/consumer/blobs/blocked/placeholder-token', {
            'x-blocked-reason': 'Withheld',
          });

    const result = await preserveBlob({ config, store: memoryStore() }, input);

    expect(result.refreshedAt).toBeDefined();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /v2/consumer/blobs/${BLOB}`,
      `POST /v2/consumer/blobs/${BLOB}/refresh`,
    ]);
    for (const { url } of calls) {
      expect(url.pathname).not.toMatch(/workflow/i);
      expect([...url.searchParams.keys()]).toEqual([]);
    }
  });
});
