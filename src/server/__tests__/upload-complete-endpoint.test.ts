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

const { mockCompleteMultipartUpload, mockObjectExists, mockS3Send } = vi.hoisted(() => ({
  mockCompleteMultipartUpload: vi.fn(),
  mockObjectExists: vi.fn(),
  mockS3Send: vi.fn(),
}));

// Keep the REAL module (so the real classifyS3MultipartError AND the real
// `headObject` / `isNotFoundError` run) and override only the network send + client
// factories. 🔴 The client factories return a stub whose `.send` is `mockS3Send`, so
// the post-completion HeadObject probe is driven by real AWS-SDK-shaped errors
// through the real not-found classifier — a fake `headObject` could encode the same
// wrong shape as the code and pass with the bug present.
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/s3-utils')>();
  return {
    ...actual,
    completeMultipartUpload: mockCompleteMultipartUpload,
    objectExists: mockObjectExists,
    getUploadS3Client: vi.fn(() => ({ send: mockS3Send })),
    getB2ImageS3Client: vi.fn(() => ({ send: mockS3Send })),
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
// Mocked in ~/__tests__/setup as vi.fn(); imported here so the LOG PAYLOAD is assertable.
import { logToAxiom } from '~/server/logging/client';
// The REAL helper (the vi.mock above spreads the actual module), driven directly to
// pin the never-throws contract the handler's fail-open depends on.
import { headObject } from '~/utils/s3-utils';

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
      // The bucket value is irrelevant to every assertion in this file, so it is kept
      // generic rather than naming a real one (matching `reqWithParts` below).
      bucket: 'test-bucket',
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
  mockObjectExists.mockReset();
  mockObjectExists.mockResolvedValue(false);
  // Default for the post-completion HeadObject probe: the object is there with real
  // bytes. That is the healthy case, so every test that isn't ABOUT the probe keeps
  // asserting the same status it always did.
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({ ContentLength: 1024 });
});

describe('/api/upload/complete — error classification', () => {
  it('happy path: completeMultipartUpload resolves → 200 + Location', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('https://cdn/x');
  });

  const noSuchUpload = () =>
    s3Error({
      name: 'NoSuchUpload',
      message:
        'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
      $metadata: { httpStatusCode: 404 },
    });

  it('NoSuchUpload with no object in the bucket → 409, not 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(noSuchUpload());
    mockObjectExists.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Upload already finalized or aborted' });
  });

  // A retry whose first attempt actually succeeded: reporting 409 here would strand
  // a fully uploaded file with no DB row, which is the whole bug this guards.
  it('NoSuchUpload but the object exists (retry after success) → 200', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(noSuchUpload());
    mockObjectExists.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
  });

  it('NoSuchUpload with an unreachable bucket → 409 (does not assume success)', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(noSuchUpload());
    mockObjectExists.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
  });

  it('InvalidPart (name + $metadata 400) → 422 + no-store, not 500', async () => {
    mockCompleteMultipartUpload.mockRejectedValue(
      s3Error({
        name: 'InvalidPart',
        message:
          "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.",
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

describe('/api/upload/complete — the completion LOG must record the completion SHAPE', () => {
  /**
   * WHY THIS EXISTS. A multipart completion can resolve WITHOUT THROWING and still
   * leave the session unfinished with no object in the bucket. S3 documents that
   * CompleteMultipartUpload "can contain either a success or an error" and that an
   * error "might be embedded in the 200 OK response" — so a non-throwing call is not
   * proof of a finalized object.
   *
   * That happened in production: rows were registered 472 ms after a completion the
   * SDK reported as successful, for sessions the backend still lists as unfinished
   * with no object. The rows are then indistinguishable from healthy ones, and the
   * log had nothing in it to tell them apart after the fact.
   *
   * 🔴 These assert the PAYLOAD, not that logging happened. Asserting only that
   * logToAxiom was called passes with the bug fully present — the old payload had no
   * partCount, no location and no etag, which is exactly why the incident could not
   * be diagnosed from logs.
   */
  const logged = () => {
    const calls = vi.mocked(logToAxiom).mock.calls.map((c) => c[0] as Record<string, unknown>);
    return calls.find((c) => c?.name === 's3-upload-complete');
  };

  const reqWithParts = (parts: unknown) =>
    ({
      method: 'POST',
      body: {
        // Bucket value is irrelevant to what these tests assert; kept generic on
        // purpose rather than naming a real one.
        bucket: 'test-bucket',
        key: 'some/key.safetensors',
        type: 'model',
        uploadId: 'test-upload-id',
        parts,
        backend: 'b2',
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest);

  beforeEach(() => vi.mocked(logToAxiom).mockClear());

  it('records partCount, location and etag on a successful completion', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x', ETag: '"abc123"' });
    await handler(makeReq(), makeRes());
    const ev = logged();
    expect(ev).toBeDefined();
    expect(ev?.partCount).toBe(1);
    expect(ev?.location).toBe('https://cdn/x');
    expect(ev?.etag).toBe('"abc123"');
  });

  it('THE MOTIVATING CASE: a completion that resolves with NO Location is still logged as such', async () => {
    // The silent-empty shape. Before this change the event carried no `location` key
    // at all, so this run and a healthy one produced identical log lines.
    mockCompleteMultipartUpload.mockResolvedValue({});
    const res = makeRes();
    await handler(reqWithParts([{ ETag: 'e', PartNumber: 1 }]), res);
    const ev = logged();
    expect(ev).toBeDefined();
    expect(ev).toHaveProperty('location');
    expect(ev?.location).toBeNull();
    expect(ev?.etag).toBeNull();
    // Behaviour is deliberately unchanged — this commit adds visibility only.
    expect(res.statusCode).toBe(200);
  });

  it('partCount reflects the manifest length, so a truncated manifest is visible', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/y', ETag: '"e"' });
    await handler(
      reqWithParts([
        { ETag: 'a', PartNumber: 1 },
        { ETag: 'b', PartNumber: 2 },
        { ETag: 'c', PartNumber: 3 },
      ]),
      makeRes()
    );
    expect(logged()?.partCount).toBe(3);
  });

  it('a non-array parts body logs partCount null rather than throwing', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/z', ETag: '"e"' });
    const res = makeRes();
    await handler(reqWithParts(undefined), res);
    expect(logged()?.partCount).toBeNull();
    expect(res.statusCode).toBe(200);
  });
});

describe('/api/upload/complete — a successful completion must be VERIFIED against the bucket', () => {
  /**
   * WHY THIS EXISTS — silent data loss, proven in production.
   *
   * CompleteMultipartUpload can resolve WITHOUT THROWING and still leave the session
   * unfinished with no object: S3 documents that the call "can contain either a
   * success or an error" and that an error "might be embedded in the 200 OK
   * response". A completion resolved as successful, the file row was written 472 ms
   * later, and the storage backend still lists that session unfinished with NO
   * object. Nothing re-verified, so the row is permanent, indistinguishable from a
   * healthy one, and unrecoverable — the browser had already dropped the bytes.
   *
   * The fix is one HeadObject before the 200, so the failure lands while the client
   * still holds the file and can re-upload.
   *
   * 🔴 These assert the STATUS AND BODY THE CLIENT SEES, never that HeadObject was
   * called. A spy-count assertion passes with a handler that issues the probe and
   * then ignores the answer — which is the entire bug.
   *
   * 🔴 The probe runs through the REAL `headObject` and the REAL not-found
   * classifier; only `s3.send` is stubbed, with AWS-SDK-shaped errors.
   */
  const notFound = () =>
    Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

  const unverifiedEvent = () =>
    vi
      .mocked(logToAxiom)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((c) => c?.name === 's3-upload-complete-unverified');

  const completeEvent = () =>
    vi
      .mocked(logToAxiom)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((c) => c?.name === 's3-upload-complete');

  beforeEach(() => vi.mocked(logToAxiom).mockClear());

  it('🔴 THE DEFECT: completion resolves but the object is ABSENT → 422, never a success', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x', ETag: '"abc"' });
    mockS3Send.mockRejectedValue(notFound());
    const res = makeRes();
    await handler(makeReq(), res);
    // Before this change the handler returned 200 with result.Location here, and the
    // client went on to register a row for a file that does not exist.
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: 'Upload completed but the file was not stored — please re-upload',
    });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).not.toBe('https://cdn/x');
  });

  it('the absent case is separately alertable and records the probe verdict', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x', ETag: '"abc"' });
    mockS3Send.mockRejectedValue(notFound());
    await handler(makeReq(), makeRes());
    expect(unverifiedEvent()).toBeDefined();
    expect(completeEvent()?.objectStatus).toBe('absent');
    expect(completeEvent()?.objectVerified).toBe(false);
  });

  it('object present with real bytes → 200 + Location, unchanged', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x', ETag: '"abc"' });
    mockS3Send.mockResolvedValue({ ContentLength: 4096 });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('https://cdn/x');
    expect(unverifiedEvent()).toBeUndefined();
    expect(completeEvent()?.objectVerified).toBe(true);
    expect(completeEvent()?.objectSize).toBe(4096);
  });

  it('object present but ZERO bytes → 422 (presence alone is not enough)', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x', ETag: '"abc"' });
    mockS3Send.mockResolvedValue({ ContentLength: 0 });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(422);
    expect(completeEvent()?.objectSize).toBe(0);
  });

  /**
   * 🔴 FAIL-OPEN CASES. A verification step that turns a working upload into an error
   * is worse than the bug it guards. Only a bucket that ANSWERS "not there" — or
   * answers with a definitively zero length — may reject. Everything else is "we
   * could not consult the bucket", which is not evidence of loss.
   */
  it('HeadObject 403 (rotated/absent credentials) → 200, not a rejection', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('https://cdn/x');
    expect(completeEvent()?.objectStatus).toBe('unknown');
    expect(completeEvent()?.objectVerified).toBe(true);
  });

  it('HeadObject network failure (ECONNRESET) → 200, not a rejection', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('https://cdn/x');
  });

  // The probe's own timeout budget firing must not fail the upload it is checking —
  // this is the "the verification step causes the failure it looks for" case.
  it('HeadObject aborted by its own timeout → 200, not a rejection', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(completeEvent()?.objectStatus).toBe('unknown');
  });

  // `size: null` means the backend reported NO length. That is not zero, and a size
  // check that treats it as zero rejects healthy uploads on every backend that omits
  // ContentLength.
  it('object present but the backend reports no ContentLength → 200', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({ Location: 'https://cdn/x' });
    mockS3Send.mockResolvedValue({});
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(completeEvent()?.objectStatus).toBe('present');
    expect(completeEvent()?.objectSize).toBeNull();
  });

  // A backend that finalizes the object but echoes no Location is HEALTHY. The probe
  // is stronger evidence than the response shape, so it — not the shape — decides.
  it('a completion with NO Location but a real object still returns 200', async () => {
    mockCompleteMultipartUpload.mockResolvedValue({});
    mockS3Send.mockResolvedValue({ ContentLength: 512 });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(unverifiedEvent()).toBeUndefined();
  });
});

describe('headObject — the probe itself can never throw into its caller', () => {
  // The whole guard rests on this: `headObject` resolving to `unknown` instead of
  // throwing is what makes the handler's fail-open reachable at all. A client object
  // with no usable `send` is the cheapest deterministic stand-in for "the client
  // could not be used".
  it('a client whose send throws synchronously resolves to unknown', async () => {
    const broken = {
      send: () => {
        throw new TypeError('boom');
      },
    } as never;
    await expect(headObject('test-bucket', 'k', broken)).resolves.toEqual({ status: 'unknown' });
  });

  it('reports the ContentLength the backend returned', async () => {
    const ok = { send: async () => ({ ContentLength: 77 }) } as never;
    await expect(headObject('test-bucket', 'k', ok)).resolves.toEqual({
      status: 'present',
      size: 77,
    });
  });
});
