import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the shared ~/env/server / logging / prom mocks
// before the handler evaluates env at module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * /api/upload/sign-part — telemetry must not gate or fail the response.
 *
 * The fourth upload route, and the one most expensive to lose: it re-signs a part URL for a
 * multi-hour transfer whose 12 h URLs expired, so a stall here costs the whole upload rather
 * than one request.
 *
 * Both `logToAxiom` calls used to sit between the work and the response. During the
 * 2026-08-23 Axiom outage that meant a 30 s stall (the `@axiomhq/axiom-node` axios timeout)
 * followed by a throw, on a path where the signed URL had already been minted successfully.
 * Its three siblings were fixed and pinned; this one was fixed in the same PR and needs the
 * same pins, or the guard is one route wide of the defect.
 *
 * Lives under src/server/__tests__ rather than beside the handler: Next.js treats every .ts
 * under src/pages/api as a route and its route-type validator rejects a test module.
 */

const { mockGetUploadPartUrl, mockGetUploadBucket, mockGetUploadS3Client } = vi.hoisted(() => ({
  mockGetUploadPartUrl: vi.fn(async () => ({
    url: 'https://b2.example.com/signed',
    partNumber: 3,
  })),
  // The handler builds its allowlist from these, so they must return the bucket the request
  // names or every case 403s before reaching the code under test.
  mockGetUploadBucket: vi.fn((backend: string) =>
    backend === 'b2' ? 'civitai-modelfiles' : 'civitai-default'
  ),
  mockGetUploadS3Client: vi.fn(() => ({})),
}));

vi.mock('~/utils/s3-utils', () => ({
  getUploadPartUrl: mockGetUploadPartUrl,
  getUploadBucket: mockGetUploadBucket,
  getUploadS3Client: mockGetUploadS3Client,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: 42, bannedAt: null } })),
}));

import handler from '~/pages/api/upload/sign-part';
// Mocked in ~/__tests__/setup as vi.fn(); imported so log ORDER is observable and the logger
// can be made to REJECT.
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
    once() {
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq() {
  return {
    method: 'POST',
    body: {
      bucket: 'civitai-modelfiles',
      // The handler scopes re-signing to `key.split('/')[1] === String(userId)`, so the 42
      // here is load-bearing: any other value 403s.
      key: 'model/42/thing.safetensors',
      uploadId: 'test-upload-id',
      partNumber: 3,
      backend: 'b2',
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  mockGetUploadPartUrl.mockClear();
  vi.mocked(logToAxiom).mockReset();
});

describe('/api/upload/sign-part — telemetry cannot gate or fail the response', () => {
  it('happy path still returns 200 with the signed URL', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { url?: string })?.url).toBe('https://b2.example.com/signed');
  });

  it('ORDERING: the 200 is already committed by the time the event is logged', async () => {
    const res = makeRes();
    let statusAtLogTime: number | undefined;
    vi.mocked(logToAxiom).mockImplementation(async () => {
      statusAtLogTime = res.statusCode;
    });

    await handler(makeReq(), res);

    // With the log ahead of the response — the pre-fix shape — this observes 0.
    expect(statusAtLogTime).toBe(200);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 's3-upload-sign-part' })
    );
  });

  it('CONTAINMENT: a rejecting logger leaves the 200 intact and the handler settled', async () => {
    vi.mocked(logToAxiom).mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const res = makeRes();

    await expect(handler(makeReq(), res)).resolves.toBeUndefined();

    // Without the inner try/catch this unwinds into the handler's catch and becomes a 500 on
    // a request whose URL was signed fine — which is exactly what the outage did.
    expect(res.statusCode).toBe(200);
  });

  it('ERROR PATH: the 500 is sent even when the logger is also failing', async () => {
    mockGetUploadPartUrl.mockRejectedValueOnce(new Error('B2 unavailable'));
    vi.mocked(logToAxiom).mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const res = makeRes();

    await expect(handler(makeReq(), res)).resolves.toBeUndefined();

    // Pre-fix the awaited log ran FIRST, so a sick logger meant no response was written at
    // all — the client saw an unhandled-rejection 500 with no event recorded.
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'B2 unavailable' });
  });

  /**
   * 🔴 ORDERING ON THE ERROR PATH TOO — added because a mutation sweep found the test above
   * does NOT catch moving the error log back ahead of the 500. Once the log is contained, a
   * reordered version still ends up sending the same 500, so a status-only assertion cannot
   * see it; what it reintroduces is the 2 s telemetry stall in front of the client's answer,
   * which is the half of the outage the containment does not fix.
   *
   * A status-only assertion is the weaker guard on BOTH paths. This reads the response state
   * at log time, so it fails on reordering alone.
   */
  it('ORDERING (error path): the 500 is committed before the error event is logged', async () => {
    mockGetUploadPartUrl.mockRejectedValueOnce(new Error('B2 unavailable'));
    const res = makeRes();
    let statusAtLogTime: number | undefined;
    vi.mocked(logToAxiom).mockImplementation(async () => {
      statusAtLogTime = res.statusCode;
    });

    await handler(makeReq(), res);

    expect(statusAtLogTime).toBe(500);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 's3-upload-sign-part-error' })
    );
  });
});
