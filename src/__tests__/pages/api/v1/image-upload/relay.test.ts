import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';

// Covers the FALLBACK image-upload relay (`/api/v1/image-upload/relay`).
//
// These are NEW-FEATURE tests, not regression guards: the route did not exist before
// this change, so there is no pre-change revision at which they could be shown red.
// Stated explicitly so nobody later reads them as evidence that a specific defect was
// reproduced and fixed.
//
// The properties worth pinning are the ones where getting it wrong is silent:
//  - the key is minted SERVER-SIDE and no caller-supplied key is honoured (an
//    earlier draft echoed the presign's id back, which lets a caller overwrite
//    another user's object)
//  - the size cap trips on the RUNNING total, so an oversized body cannot be
//    buffered in full first
//  - an unauthenticated or banned caller never reaches the store at all

const { mockGetServerAuthSession, mockUploadImageBufferToStore } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockUploadImageBufferToStore: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/utils/s3-utils', () => ({
  uploadImageBufferToStore: mockUploadImageBufferToStore,
}));

vi.mock('~/server/prom/http-errors', () => ({
  instrumentApiResponse: vi.fn(),
}));

import handler, { MAX_RELAY_BYTES } from '~/pages/api/v1/image-upload/relay';

function makeReq(
  body: Buffer,
  opts?: { method?: string; contentType?: string }
): NextApiRequest {
  const stream = Readable.from([body]) as unknown as NextApiRequest;
  stream.method = opts?.method ?? 'POST';
  stream.headers = { 'content-type': opts?.contentType ?? 'image/png' };
  stream.query = {};
  return stream;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res as unknown as NextApiResponse & typeof res;
}

const authed = { user: { id: 7, bannedAt: null } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthSession.mockResolvedValue(authed);
  mockUploadImageBufferToStore.mockResolvedValue({ key: 'server-minted-uuid', backend: 'backblaze' });
});

describe('image-upload relay', () => {
  it('uploads the body and returns the SERVER-minted key', async () => {
    const req = makeReq(Buffer.from('image-bytes'));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'server-minted-uuid' });

    // The bytes reached the store intact, with the caller's content type.
    expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
    const [buf, opts] = mockUploadImageBufferToStore.mock.calls[0];
    expect(Buffer.from(buf).toString()).toBe('image-bytes');
    expect(opts).toEqual({ contentType: 'image/png' });
  });

  it('ignores any caller-supplied key — the store mints it', async () => {
    // A caller trying to name the object it writes. `uploadImageBufferToStore` takes
    // only (bytes, {contentType}); if a future edit threads a key through, this fails.
    const req = makeReq(Buffer.from('bytes'));
    (req as unknown as { query: Record<string, string> }).query = {
      key: 'victim-uuid',
      id: 'victim-uuid',
    };
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'server-minted-uuid' });
    const [, opts] = mockUploadImageBufferToStore.mock.calls[0];
    expect(opts).not.toHaveProperty('key');
    expect(JSON.stringify(mockUploadImageBufferToStore.mock.calls[0])).not.toContain('victim-uuid');
  });

  it('rejects a body over the cap without buffering it whole', async () => {
    const req = makeReq(Buffer.alloc(MAX_RELAY_BYTES + 1));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('accepts a body exactly AT the cap — the boundary is inclusive', async () => {
    // Guards the off-by-one directly: `>` not `>=`. A fixture one byte under would
    // pass against either spelling and prove nothing about the boundary.
    const req = makeReq(Buffer.alloc(MAX_RELAY_BYTES));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body', async () => {
    const req = makeReq(Buffer.alloc(0));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller before touching the store', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const req = makeReq(Buffer.from('bytes'));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects a banned user before touching the store', async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: { id: 7, bannedAt: new Date('2026-01-01') },
    });
    const req = makeReq(Buffer.from('bytes'));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects a non-POST method', async () => {
    const req = makeReq(Buffer.from('bytes'), { method: 'GET' });
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('surfaces a store failure as a 500 rather than a silent success', async () => {
    mockUploadImageBufferToStore.mockRejectedValue(new Error('b2 exploded'));
    const req = makeReq(Buffer.from('bytes'));
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'b2 exploded' });
  });
});
