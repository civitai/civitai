import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the shared ~/env/server / logging / prom mocks
// before the upload handler evaluates env at module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Upload backend selection — model files (b2-upload-default flag retirement).
 *
 * The `b2-upload-default` Flipt flag was retired: model-file uploads now route
 * to B2 purely on the presence of `S3_UPLOAD_B2_ENDPOINT` (mirroring the
 * already-flag-free training path). No Flipt call, so a Flipt outage can no
 * longer silently fall back to S3.
 *
 * These drive the REAL handler. We mock only the I/O collaborators:
 *   - getServerAuthSession → a logged-in, non-banned user (auth isn't under test)
 *   - the s3-utils put-URL/client/bucket helpers → so no real S3 call is made
 *   - ~/env/server → per-test, to toggle S3_UPLOAD_B2_ENDPOINT
 *
 * The handler echoes the chosen `backend` in its JSON response, so we assert on
 * that (non-vacuous: it reflects the actual branch the real code took).
 *
 * If the retirement regressed (a Flipt call reappeared), this would surface as
 * an unmocked-Flipt error or a wrong backend — the test would fail.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(mockEnv, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return undefined;
    },
  }),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: 42, bannedAt: null } })),
}));

// Capture which s3 client/bucket the handler resolved so we can corroborate the
// backend choice at the collaborator level (not just the response echo).
const CHUNK_SIZE = vi.hoisted(() => 25 * 1024 * 1024);
const { getUploadS3Client, getUploadBucket, getMultipartPutUrl } = vi.hoisted(() => ({
  getUploadS3Client: vi.fn((backend: string) => ({ __client: backend })),
  getUploadBucket: vi.fn((backend: string) => `bucket-${backend}`),
  getMultipartPutUrl: vi.fn(async (key: string, _size: number, _s3: unknown, bucket: unknown) => ({
    urls: [],
    bucket: bucket ?? 'default-bucket',
    key,
    uploadId: 'test-upload-id',
  })),
}));
vi.mock('~/utils/s3-utils', () => ({
  getUploadS3Client,
  getUploadBucket,
  getMultipartPutUrl,
  getUploadChunkSize: () => CHUNK_SIZE,
}));

// NOTE: this test lives under src/server/__tests__ (not co-located beside the
// handler) on purpose — Next.js scans every .ts file under src/pages/api as an
// API route, and its build-time route-type validator rejects a test module
// (no default ApiRouteConfig export), failing `next build`.
import handler from '~/pages/api/upload';
import { UploadType } from '~/server/common/enums';
// Mocked in ~/__tests__/setup as vi.fn(); imported here so the ORDER of the log relative to
// the response is observable, and so it can be made to REJECT.
import { logToAxiom } from '~/server/logging/client';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    // instrumentApiResponse registers a fire-and-forget res.once('finish', …).
    // A no-op registrar is enough — we never emit the event.
    once() {
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq(type: UploadType) {
  return {
    method: 'POST',
    body: { filename: 'model.safetensors', type, size: 1024 },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  getUploadS3Client.mockClear();
  getUploadBucket.mockClear();
  getMultipartPutUrl.mockClear();
});

describe('upload handler — model backend selection (b2-upload-default retired)', () => {
  it('Model upload with S3_UPLOAD_B2_ENDPOINT set → backend: b2', async () => {
    mockEnv.S3_UPLOAD_B2_ENDPOINT = 'https://b2.example.com';

    const res = makeRes();
    await handler(makeReq(UploadType.Model), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { backend?: string })?.backend).toBe('b2');
    // Corroborate at the collaborator level: it resolved the B2 client + bucket
    // and threaded them into the put-URL call.
    expect(getUploadS3Client).toHaveBeenCalledWith('b2');
    expect(getUploadBucket).toHaveBeenCalledWith('b2');
    expect(getMultipartPutUrl).toHaveBeenCalledWith(
      expect.any(String),
      1024,
      { __client: 'b2' },
      'bucket-b2',
      undefined,
      CHUNK_SIZE
    );
  });

  it('Model upload with S3_UPLOAD_B2_ENDPOINT unset → backend: default', async () => {
    // S3_UPLOAD_B2_ENDPOINT intentionally absent (beforeEach cleared env).

    const res = makeRes();
    await handler(makeReq(UploadType.Model), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { backend?: string })?.backend).toBe('default');
    // The default backend resolves no B2 client/bucket (null passed through).
    expect(getUploadS3Client).not.toHaveBeenCalled();
    expect(getUploadBucket).not.toHaveBeenCalled();
    expect(getMultipartPutUrl).toHaveBeenCalledWith(
      expect.any(String),
      1024,
      null,
      null,
      undefined,
      CHUNK_SIZE
    );
  });

  // The Model branch was deliberately made identical to the training branch when
  // the flag was retired. Pin that invariant: training uploads must select B2 on
  // the same endpoint gate, with no Flipt call — otherwise the two branches could
  // silently drift.
  it.each([UploadType.TrainingImages, UploadType.TrainingImagesTemp])(
    'Training upload (%s) with S3_UPLOAD_B2_ENDPOINT set → backend: b2',
    async (type) => {
      mockEnv.S3_UPLOAD_B2_ENDPOINT = 'https://b2.example.com';

      const res = makeRes();
      await handler(makeReq(type), res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { backend?: string })?.backend).toBe('b2');
      expect(getUploadS3Client).toHaveBeenCalledWith('b2');
      expect(getUploadBucket).toHaveBeenCalledWith('b2');
    }
  );

  it('Non-model/non-training upload (Default) never routes to B2 even with endpoint set', async () => {
    mockEnv.S3_UPLOAD_B2_ENDPOINT = 'https://b2.example.com';

    const res = makeRes();
    await handler(makeReq(UploadType.Default), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { backend?: string })?.backend).toBe('default');
    expect(getUploadS3Client).not.toHaveBeenCalled();
    expect(getUploadBucket).not.toHaveBeenCalled();
    expect(getMultipartPutUrl).toHaveBeenCalledWith(
      expect.any(String),
      1024,
      null,
      null,
      undefined,
      CHUNK_SIZE
    );
  });
});

/**
 * 🔴 THE RESPONSE MUST NOT DEPEND ON TELEMETRY — the `/api/upload` half of the contract
 * pinned for ./complete.ts and ./abort.ts in `upload-{complete,abort}-endpoint.test.ts`.
 *
 * This route was the worst of the four: no try/catch at all, and `await logToAxiom` sitting
 * between a successfully created multipart session and the 200 that hands the client its
 * presigned part URLs. During the 2026-08-23 Axiom outage that made it a 500 with nothing
 * logged anywhere — 292 of them, against a baseline of zero.
 *
 * These exist because the restructure was otherwise UNPINNED IN BOTH DIRECTIONS: an audit
 * showed that moving the log back ahead of the response, or deleting the containment
 * try/catch, both left this file green at 5/5. Two independent guards, because they fail
 * differently — one reads the ordering directly even with a healthy logger, the other only
 * bites when the logger is sick.
 */
describe('/api/upload — telemetry cannot gate or fail the response', () => {
  beforeEach(() => {
    vi.mocked(logToAxiom).mockReset();
    mockEnv.S3_UPLOAD_B2_ENDPOINT = 'https://b2.example.com';
  });

  it('ORDERING: the 200 is already committed by the time the event is logged', async () => {
    const res = makeRes();
    // Reads the response state AT LOG TIME. With the log ahead of the response — the
    // pre-2026-08-23 shape — this observes 0, because nothing has been sent yet.
    let statusAtLogTime: number | undefined;
    vi.mocked(logToAxiom).mockImplementation(async () => {
      statusAtLogTime = res.statusCode;
    });

    await handler(makeReq(UploadType.Model), res);

    expect(statusAtLogTime).toBe(200);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 's3-upload' })
    );
  });

  it('CONTAINMENT: a rejecting logger leaves the 200 intact and the handler settled', async () => {
    vi.mocked(logToAxiom).mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const res = makeRes();

    await expect(handler(makeReq(UploadType.Model), res)).resolves.toBeUndefined();

    // Without the inner try/catch the rejection unwinds into the handler's own catch and
    // overwrites this with a 500 — on a request whose upload session was created fine.
    expect(res.statusCode).toBe(200);
    expect((res.body as { uploadId?: string })?.uploadId).toBe('test-upload-id');
  });

  it('a create failure is a 500 with a STATIC body and its own logged event', async () => {
    getMultipartPutUrl.mockRejectedValueOnce(new Error('B2 said no: bucket civitai-modelfiles'));
    const res = makeRes();

    await expect(handler(makeReq(UploadType.Model), res)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(500);
    // Static, never the error's own text: the driver message must not reach the wire, and
    // `rest-error-envelope-ledger` fails if it does.
    expect(res.body).toEqual({ error: 'Failed to start upload' });
    expect(JSON.stringify(res.body)).not.toContain('civitai-modelfiles');
    // The detail goes to the log instead — before this change a failure here logged nothing.
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 's3-upload-create-error', error: expect.any(String) })
    );
  });
});
