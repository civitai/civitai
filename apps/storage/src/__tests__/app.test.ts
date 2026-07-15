import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mutable state the mocked backend reads, so individual tests can force a complete/abort to throw a
// specific S3-shaped error and assert the classified status.
const state = vi.hoisted(() => ({ multipartError: null as unknown }));

vi.mock('../lib/server/backends', () => ({
  getBackendClient: () => ({
    deleteObject: async () => ({}),
    deleteManyObjects: async () => [{}],
    getPutUrl: async (key: string, opts?: { bucket?: string }) => ({
      url: 'https://signed.example/put',
      bucket: opts?.bucket ?? 'default-bucket',
      key,
    }),
    getGetUrl: async () => ({
      url: 'https://signed.example/get',
      bucket: 'default-bucket',
      key: 'k',
    }),
    getGetUrlByKey: async (key: string) => ({
      url: 'https://signed.example/get',
      bucket: 'default-bucket',
      key,
    }),
    getMultipartPutUrl: async (key: string) => ({
      urls: [{ url: 'https://signed.example/part1', partNumber: 1 }],
      bucket: 'default-bucket',
      key,
      uploadId: 'upload-1',
      chunkSize: 25 * 1024 * 1024,
    }),
    createMultipartUpload: async (key: string) => ({
      uploadId: 'upload-1',
      bucket: 'default-bucket',
      key,
    }),
    presignUploadPart: async (_key: string, _uploadId: string, partNumber: number) => ({
      url: `https://signed.example/part/${partNumber}`,
      partNumber,
    }),
    completeMultipartUpload: async () => {
      if (state.multipartError) throw state.multipartError;
      return {};
    },
    abortMultipartUpload: async () => {
      if (state.multipartError) throw state.multipartError;
      return {};
    },
    headObject: async () => ({ exists: true, size: 123, mimeType: 'image/png' }),
  }),
}));

import { buildServer } from '../app';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  state.multipartError = null;
});

describe('ops routes', () => {
  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'storage' });
  });

  it('GET /metrics serves prometheus text (no XFF)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('GET /metrics 404s a public-ingress request (XFF present)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('validation', () => {
  it('rejects an invalid delete payload with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/objects/delete', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects presign/get with neither key nor url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/presign/get',
      payload: { backend: 'default' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('happy paths (mocked backend)', () => {
  it('presigns a PUT and defaults the backend', async () => {
    const res = await app.inject({ method: 'POST', url: '/presign/put', payload: { key: 'abc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: 'https://signed.example/put',
      bucket: 'default-bucket',
      key: 'abc',
    });
  });

  it('deletes an object', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/objects/delete',
      payload: { key: 'abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('heads an object', async () => {
    const res = await app.inject({ method: 'POST', url: '/objects/head', payload: { key: 'abc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exists: true, size: 123 });
  });

  it('creates a streaming multipart upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/multipart/create',
      payload: { key: 'abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ uploadId: 'upload-1', bucket: 'default-bucket', key: 'abc' });
  });

  it('presigns a single part on demand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/multipart/presign-part',
      payload: { key: 'abc', uploadId: 'upload-1', partNumber: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://signed.example/part/3', partNumber: 3 });
  });
});

describe('multipart complete/abort error classification', () => {
  const complete = { key: 'k', uploadId: 'u', parts: [{ ETag: '"e"', PartNumber: 1 }] };

  it('succeeds → 200 ok', async () => {
    const res = await app.inject({ method: 'POST', url: '/multipart/complete', payload: complete });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('NoSuchUpload → 404 not-found', async () => {
    state.multipartError = { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } };
    const res = await app.inject({ method: 'POST', url: '/multipart/complete', payload: complete });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ class: 'not-found' });
  });

  it('InvalidPart → 422 invalid-parts', async () => {
    state.multipartError = { name: 'InvalidPart', $metadata: { httpStatusCode: 400 } };
    const res = await app.inject({ method: 'POST', url: '/multipart/complete', payload: complete });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ class: 'invalid-parts' });
  });

  it('SlowDown → 503 transient', async () => {
    state.multipartError = { name: 'SlowDown' };
    const res = await app.inject({ method: 'POST', url: '/multipart/complete', payload: complete });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ class: 'transient' });
  });

  it('abort classifies too (NoSuchUpload → 404)', async () => {
    state.multipartError = { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } };
    const res = await app.inject({
      method: 'POST',
      url: '/multipart/abort',
      payload: { key: 'k', uploadId: 'u' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('B2 presign metric', () => {
  it('increments storage_b2_presign_issued_total for a b2 backend', async () => {
    await app.inject({
      method: 'POST',
      url: '/presign/put',
      payload: { backend: 'b2', key: 'x', bucket: 'civitai-modelfiles' },
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('storage_b2_presign_issued_total');
    expect(res.body).toMatch(
      /storage_b2_presign_issued_total\{backend="b2",bucket="civitai-modelfiles"\}\s+[1-9]/
    );
  });

  it('counts once on streaming create, labeled with the RESOLVED bucket (not empty)', async () => {
    await app.inject({
      method: 'POST',
      url: '/multipart/create',
      payload: { backend: 'b2', key: 'y' },
    });
    // presign-part must NOT emit a count (would be a bucket="" series split from the real one — C1).
    await app.inject({
      method: 'POST',
      url: '/multipart/presign-part',
      payload: { backend: 'b2', key: 'y', uploadId: 'u', partNumber: 1 },
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(
      /storage_b2_presign_issued_total\{backend="b2",bucket="default-bucket"\}\s+[1-9]/
    );
    expect(res.body).not.toMatch(/storage_b2_presign_issued_total\{backend="b2",bucket=""\}/);
  });
});
