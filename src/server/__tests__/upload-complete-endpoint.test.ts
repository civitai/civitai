import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the shared ~/env/server / logging / prom mocks
// before the handler evaluates env at module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * /api/upload/complete — S3 error classification (prod raw-500 landmine).
 *
 * The handler's catch block used to `res.status(500).json({ error })` for EVERY
 * thrown S3 error. On dp-prod this surfaced ~22 raw-500s/12h whose message was the
 * AWS-SDK `NoSuchUpload` (HTTP 404): "The specified upload does not exist. …" — a
 * client/STATE fault (the multipart upload was already completed or aborted, i.e. a
 * double-submit / retry-after-success). Because every retry re-500'd, the same
 * `key`+`uploadId` repeated across pods → amplification.
 *
 * These drive the REAL handler through the REAL `classifyS3MultipartError` (only the
 * s3 send + client getters + auth are stubbed), asserting the response STATUS the
 * client sees:
 *   - NoSuchUpload / 404      → 409 Conflict  (terminal → client stops retrying)
 *   - transient S3 5xx / net  → 503 + Retry-After: 2  (mirror #2972/#3049)
 *   - a genuine server fault  → 500  (fails LOUD, never masked)
 *
 * Fails before the fix (everything is a raw 500); passes after.
 */

const { mockCompleteMultipartUpload } = vi.hoisted(() => ({
  mockCompleteMultipartUpload: vi.fn(),
}));

// Keep the REAL module (so the real classifyS3MultipartError runs) and override
// only the network send + client factories.
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/s3-utils')>();
  return {
    ...actual,
    completeMultipartUpload: mockCompleteMultipartUpload,
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

// NOTE: lives under src/server/__tests__ (not beside the handler) — Next.js scans
// every .ts under src/pages/api as an API route and its route-type validator
// rejects a test module.
import handler from '~/pages/api/upload/complete';

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
    // instrumentApiResponse registers a fire-and-forget res.once('finish', …).
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
      parts: [{ ETag: 'e', PartNumber: 1 }],
      backend: 'b2',
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

const s3Error = (props: Record<string, unknown>) =>
  Object.assign(new Error((props.message as string) ?? 'error'), props);

beforeEach(() => {
  mockCompleteMultipartUpload.mockReset();
});

describe('/api/upload/complete — error classification', () => {
  it('happy path: completeMultipartUpload resolves → 200 + Location', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('https://cdn/x');
  });

  it('NoSuchUpload (name + $metadata 404) → 409, not 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({
        name: 'NoSuchUpload',
        message:
          'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
        $metadata: { httpStatusCode: 404 },
      })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Upload already finalized or aborted' });
  });

  it('InvalidPart (name + $metadata 400) → 422 + no-store, not 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
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

  it('InvalidRequest ("must specify at least one part") + 400 → 422', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({
        name: 'InvalidRequest',
        message: 'You must specify at least one part',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(422);
  });

  it('an unknown 400 (not a parts fault) STILL surfaces as 500, not 422', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({ name: 'SomeUnknownClientError', $metadata: { httpStatusCode: 400 } })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it('transient S3 503 → 503 + Retry-After header, not 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('status-less network failure (ECONNRESET) → 503', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({ code: 'ECONNRESET', message: 'socket hang up' })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
  });

  it('a genuine server fault (unknown error) STILL surfaces as 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(s3Error({ message: 'unexpected boom' }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });
});
