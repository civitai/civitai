import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the shared ~/env/server / logging / prom mocks
// before the handler evaluates env at module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * /api/upload/abort — S3 error classification (prod raw-500 landmine).
 *
 * Same landmine class as /api/upload/complete (~5 raw-500s/12h): the catch block
 * `res.status(500)`'d every thrown S3 error, including the AWS-SDK `NoSuchUpload`
 * (HTTP 404) for an upload that was already gone (completed/aborted).
 *
 * 409-vs-204 decision for abort: aborting an already-gone upload is IDEMPOTENT — the
 * desired end-state (the upload no longer exists) ALREADY holds, so it's a success,
 * not a conflict. We return 204 (the sole caller, s3-upload.store.ts, fire-and-forgets
 * abort and ignores the response, so 204 is safe and terminal). Transient/real-fault
 * mapping matches complete (503 / 500).
 *
 * Fails before the fix (everything is a raw 500); passes after.
 */

const { mockAbortMultipartUpload } = vi.hoisted(() => ({
  mockAbortMultipartUpload: vi.fn(),
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/s3-utils')>();
  return {
    ...actual,
    abortMultipartUpload: mockAbortMultipartUpload,
    getUploadS3Client: vi.fn(() => ({})),
    getB2ImageS3Client: vi.fn(() => ({})),
  };
});

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: 42, bannedAt: null } })),
}));

// The real s3-utils imports ~/server/db/client (dbWrite); stub it so loading the
// real module for `classifyS3MultipartError` doesn't spin up a real Prisma engine.
vi.mock('~/server/db/client', () => ({ dbWrite: {}, dbRead: {} }));

import handler from '~/pages/api/upload/abort';

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    headers,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    removeHeader() {
      return this;
    },
    getHeader(name: string) {
      return headers[name];
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    ended: boolean;
    headers: Record<string, string>;
  };
}

function makeReq() {
  return {
    method: 'POST',
    body: {
      bucket: 'civitai-modelfiles',
      key: 'some/key.safetensors',
      type: 'model',
      uploadId: 'test-upload-id',
      backend: 'b2',
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

const s3Error = (props: Record<string, unknown>) =>
  Object.assign(new Error((props.message as string) ?? 'error'), props);

beforeEach(() => {
  mockAbortMultipartUpload.mockReset();
});

describe('/api/upload/abort — error classification', () => {
  it('happy path: abortMultipartUpload resolves → 200', async () => {
    mockAbortMultipartUpload.mockResolvedValue(undefined);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
  });

  it('NoSuchUpload (already gone) → 204 idempotent success, not 500', async () => {
    mockAbortMultipartUpload.mockRejectedValue(
      s3Error({
        name: 'NoSuchUpload',
        message:
          'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
        $metadata: { httpStatusCode: 404 },
      })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('InvalidPart (name + $metadata 400) → 422 + no-store, not 500', async () => {
    mockAbortMultipartUpload.mockRejectedValue(
      s3Error({
        name: 'InvalidPart',
        message:
          'One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part\'s entity tag.',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'Upload parts invalid or incomplete — please re-upload' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('an unknown 400 (not a parts fault) STILL surfaces as 500, not 422', async () => {
    mockAbortMultipartUpload.mockRejectedValue(
      s3Error({ name: 'SomeUnknownClientError', $metadata: { httpStatusCode: 400 } })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it('transient S3 500 → 503 + Retry-After header, not 500', async () => {
    mockAbortMultipartUpload.mockRejectedValue(
      s3Error({ name: 'InternalError', $metadata: { httpStatusCode: 500 } })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('status-less network failure (ETIMEDOUT) → 503', async () => {
    mockAbortMultipartUpload.mockRejectedValue(
      s3Error({ code: 'ETIMEDOUT', message: 'connection timed out' })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
  });

  it('a genuine server fault (unknown error) STILL surfaces as 500', async () => {
    mockAbortMultipartUpload.mockRejectedValue(s3Error({ message: 'unexpected boom' }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });
});
