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
  // Shape matches production exactly: `getUploadPartUrl` returns `{ url }` and nothing else
  // (~/utils/s3-utils). An earlier version added a `partNumber` the real helper never emits —
  // the same fixture-fidelity defect this suite's sibling was fixed for.
  mockGetUploadPartUrl: vi.fn(async () => ({ url: 'https://b2.example.com/signed' })),
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

  /**
   * 🔴 "Committed" means the BODY was written, not just that `res.status()` was called.
   * `res.status(200)` alone sends nothing — a mutant that splits the two
   * (`res.status(200); await log; res.json(result)`) leaves the client waiting exactly as
   * long as the pre-fix code did, and a status-only assertion passes it. So capture the body
   * too; `undefined` there is the tell.
   */
  it('ORDERING: the 200 is already committed by the time the event is logged', async () => {
    const res = makeRes();
    let statusAtLogTime: number | undefined;
    let bodyAtLogTime: unknown;
    vi.mocked(logToAxiom).mockImplementation(async () => {
      statusAtLogTime = res.statusCode;
      bodyAtLogTime = res.body;
    });

    await handler(makeReq(), res);

    // With the log ahead of the response — the pre-fix shape — this observes 0/undefined.
    expect(statusAtLogTime).toBe(200);
    expect(bodyAtLogTime).toEqual({ url: 'https://b2.example.com/signed' });
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
    let bodyAtLogTime: unknown;
    vi.mocked(logToAxiom).mockImplementation(async () => {
      statusAtLogTime = res.statusCode;
      bodyAtLogTime = res.body;
    });

    await handler(makeReq(), res);

    expect(statusAtLogTime).toBe(500);
    expect(bodyAtLogTime).toEqual({ error: 'B2 unavailable' });
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 's3-upload-sign-part-error' })
    );
  });
});

/**
 * The route's three authorization guards. They PRE-DATE this PR and are not part of it — but
 * this PR creates the only test file for the route, which makes it their natural home, and a
 * mutation sweep found all three silently removable. `getUploadPartUrl` hands back a presigned
 * WRITE url, so a missing guard is an arbitrary-object write for any signed-in user, not a
 * cosmetic defect.
 */
describe('/api/upload/sign-part — authorization guards', () => {
  it('refuses a bucket outside the upload allowlist', async () => {
    const res = makeRes();
    const req = makeReq() as unknown as { body: Record<string, unknown> };
    req.body.bucket = 'some-other-bucket';

    await handler(req as never, res);

    expect(res.statusCode).toBe(403);
    expect(mockGetUploadPartUrl).not.toHaveBeenCalled();
  });

  it("refuses a key outside the caller's own prefix", async () => {
    const res = makeRes();
    const req = makeReq() as unknown as { body: Record<string, unknown> };
    // Session user is 42; this key belongs to 99.
    req.body.key = 'model/99/someone-elses.safetensors';

    await handler(req as never, res);

    expect(res.statusCode).toBe(403);
    expect(mockGetUploadPartUrl).not.toHaveBeenCalled();
  });

  // 0/-1 exercise `partNumber < 1`; 1.5/'three'/undefined exercise `!Number.isInteger`.
  // Measured as a clean partition rather than assumed: removing only the lower bound fails
  // exactly 2 of these, removing only the integer check fails exactly 3 — so neither clause is
  // vacuous and no value is absorbed by an earlier check.
  // Title uses vitest's `$0` (pretty-format: `+0`, `'three'`, `undefined`), not `%p` — vitest
  // does not interpolate `%p`, so all five cases would otherwise report under one identical
  // name and a failure could not be attributed to a value.
  it.each([0, -1, 1.5, 'three', undefined])(
    'rejects partNumber $0 as a 400',
    async (partNumber) => {
      const res = makeRes();
      const req = makeReq() as unknown as { body: Record<string, unknown> };
      req.body.partNumber = partNumber;

      await handler(req as never, res);

      expect(res.statusCode).toBe(400);
      expect(mockGetUploadPartUrl).not.toHaveBeenCalled();
    }
  );

  // The same 400 guard has three `typeof … !== 'string'` disjuncts that had NO case at all, so
  // any one of them could be deleted silently. One field per case, the others left valid.
  it.each(['bucket', 'key', 'uploadId'])('rejects a non-string %s as a 400', async (field) => {
    const res = makeRes();
    const req = makeReq() as unknown as { body: Record<string, unknown> };
    req.body[field] = 12345;

    await handler(req as never, res);

    expect(res.statusCode).toBe(400);
    expect(mockGetUploadPartUrl).not.toHaveBeenCalled();
  });
});
