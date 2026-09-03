import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EnvOther from '~/env/other';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as S3Utils from '~/utils/s3-utils';
import type * as HttpErrors from '~/server/prom/http-errors';
import type * as OriginHelpers from '~/server/utils/origin-helpers';

// Covers the FALLBACK image-upload relay (`/api/v1/image-upload/relay`).
//
// These are NEW-FEATURE tests, not regression guards: the route did not exist before
// this change, so there is no pre-change revision at which they could be shown red.
// Stated explicitly so nobody later reads them as evidence that a specific defect was
// reproduced and fixed. The exceptions are the three cases marked AUDIT-*, which DO
// pin defects an adversarial audit found in the first draft of this route and which
// are red against that draft.
//
// Mocks are SURGICAL (spread `importOriginal`, override one symbol). A one-key
// wholesale factory for `~/utils/s3-utils` — which exports ~30 runtime symbols —
// collapses the whole file to "no tests" the moment the route imports a second
// symbol from it, which is the silent-zero shape `local-rules/no-wholesale-module-mock`
// exists to prevent.

const {
  mockGetServerAuthSession,
  mockUploadImageBufferToStore,
  mockIsAllowedOriginRequest,
  prodFlag,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockUploadImageBufferToStore: vi.fn(),
  mockIsAllowedOriginRequest: vi.fn(),
  // A getter-backed box, so a single test can flip `isProd` without a second file.
  prodFlag: { value: false },
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  get isProd() {
    return prodFlag.value;
  },
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  uploadImageBufferToStore: mockUploadImageBufferToStore,
}));

vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpErrors>()),
  instrumentApiResponse: vi.fn(),
}));

vi.mock('~/server/utils/origin-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof OriginHelpers>()),
  isAllowedOriginRequest: mockIsAllowedOriginRequest,
}));

import handler, {
  MAX_RELAY_BYTES,
  MAX_CONCURRENT_RELAYS,
  __getInFlightForTest,
} from '~/pages/api/v1/image-upload/relay';

/** Records the order in which the handler wrote a status vs destroyed the request. */
type Trace = string[];

function makeReq(
  chunks: Buffer[],
  opts?: { method?: string; contentType?: string; trace?: Trace }
): NextApiRequest {
  return decorate(Readable.from(chunks) as unknown as NextApiRequest, opts);
}

function decorate(
  stream: NextApiRequest,
  opts?: { method?: string; contentType?: string; trace?: Trace }
): NextApiRequest {
  stream.method = opts?.method ?? 'POST';
  stream.headers = { 'content-type': opts?.contentType ?? 'image/png' };
  stream.query = {};
  const trace = opts?.trace;
  const realDestroy = stream.destroy.bind(stream);
  stream.destroy = ((...args: unknown[]) => {
    trace?.push('destroy');
    return (realDestroy as (...a: unknown[]) => unknown)(...args);
  }) as typeof stream.destroy;
  return stream;
}

function makeRes(trace?: Trace) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    status(code: number) {
      trace?.push(`status:${code}`);
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    getHeader(k: string) {
      return this.headers[k];
    },
  };
  return res as unknown as NextApiResponse & typeof res;
}

const authed = { user: { id: 7, bannedAt: null } };

beforeEach(() => {
  vi.clearAllMocks();
  prodFlag.value = false;
  mockGetServerAuthSession.mockResolvedValue(authed);
  mockUploadImageBufferToStore.mockResolvedValue({
    key: 'server-minted-uuid',
    backend: 'backblaze',
  });
  // Default to an allowed origin; the CSRF cases override it. In test `isProd` is
  // false, so the guard is exempt anyway — these assertions pin the call, and the
  // prod behaviour is pinned by the dedicated case below.
  mockIsAllowedOriginRequest.mockReturnValue(true);
});

describe('image-upload relay', () => {
  it('uploads the body and returns the SERVER-minted key', async () => {
    const req = makeReq([Buffer.from('image-bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'server-minted-uuid' });

    expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
    const [buf, opts] = mockUploadImageBufferToStore.mock.calls[0];
    expect(Buffer.from(buf).toString()).toBe('image-bytes');
    expect(opts).toEqual({ contentType: 'image/png' });
  });

  it('reassembles a MULTI-CHUNK body in order', async () => {
    const req = makeReq([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const [buf] = mockUploadImageBufferToStore.mock.calls[0];
    expect(Buffer.from(buf).toString()).toBe('abcdefghi');
  });

  it('ignores any caller-supplied key — the store mints it', async () => {
    const req = makeReq([Buffer.from('bytes')]);
    (req as unknown as { query: Record<string, string> }).query = {
      key: 'victim-uuid',
      id: 'victim-uuid',
    };
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'server-minted-uuid' });
    expect(JSON.stringify(mockUploadImageBufferToStore.mock.calls[0])).not.toContain('victim-uuid');
  });

  // Chunks each UNDER the cap that only exceed it in sum. NOTE this asserts the
  // OUTCOME only — see the next test for the one that pins the running-total
  // property itself. Kept separate because the 413 and the property are different
  // claims and a reader should not mistake this one for the stronger one.
  it('rejects a body whose chunks each fit but which sums past the cap', async () => {
    const half = Math.floor(MAX_RELAY_BYTES / 2) + 1;
    const req = makeReq([Buffer.alloc(half), Buffer.alloc(half)]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  // AUDIT-F5 + AUDIT-F6, and this single trace pins BOTH — deliberately, because
  // neither is expressible on its own here.
  //
  //  * F5: `req.destroy()` tears down the socket, so a status written afterwards
  //    goes into a dead socket and the client sees a transport error, never the 413.
  //    Hence `status:413` must precede `destroy`.
  //  * F6: the running-total property. Asserting the 413 alone does NOT pin it — a
  //    measure-at-the-end implementation returns the same 413, which is why the
  //    first draft's cap test left that mutant alive. The tell is the LEADING
  //    entry: measure-at-end consumes to EOF, and a stream that ends auto-destroys,
  //    producing ['destroy', 'status:413', 'destroy']. A running total throws before
  //    EOF, so no destroy precedes the status. Confirmed by mutation.
  //
  // ⚠ What does NOT work, so nobody re-derives it: counting how many chunks the
  // async source yielded. Node's Readable reads AHEAD of the consumer, so the real
  // running-total implementation still pulls the chunk after the one that trips the
  // cap. Generator-pull count measures the stream's buffering, not the handler's.
  it('writes the 413 before destroying, and does not consume the stream to EOF', async () => {
    const trace: Trace = [];
    const half = Math.floor(MAX_RELAY_BYTES / 2) + 1;
    const req = makeReq([Buffer.alloc(half), Buffer.alloc(half)], { trace });
    const res = makeRes(trace);

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(trace).toEqual(['status:413', 'destroy']);
  });

  it('accepts a body exactly AT the cap — the boundary is inclusive', async () => {
    // Guards the off-by-one directly: `>` not `>=`. A fixture one byte under would
    // pass against either spelling and prove nothing about the boundary.
    const req = makeReq([Buffer.alloc(MAX_RELAY_BYTES)]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body', async () => {
    const req = makeReq([Buffer.alloc(0)]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller before touching the store', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const req = makeReq([Buffer.from('bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects a banned user before touching the store', async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: { id: 7, bannedAt: new Date('2026-01-01') },
    });
    const req = makeReq([Buffer.from('bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('rejects a non-POST method', async () => {
    const req = makeReq([Buffer.from('bytes')], { method: 'GET' });
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
  });

  // AUDIT-F2. The first draft returned `error.message` verbatim. Those messages come
  // from the AWS SDK and carry bucket names, endpoint hostnames, request ids and
  // signature detail. The assertion is on the WIRE BODY, not on "handleEndpointError
  // was called" — a structural check would pass against a call that still leaked.
  // AUDIT-F3. This route is cookie-authenticated, accepts a raw body and an arbitrary
  // Content-Type — which makes a cross-site POST a CORS-*simple* request, so no
  // preflight protects it. Without an origin check any third-party page could make a
  // logged-in visitor write attacker-chosen bytes into the media bucket. The direct
  // presign route is not exposed this way (its presigned URL is unreadable
  // cross-origin), so this is new surface rather than parity.
  it('blocks a cross-origin request in production, before touching the store', async () => {
    prodFlag.value = true;
    mockIsAllowedOriginRequest.mockReturnValue(false);
    const req = makeReq([Buffer.from('bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
    // Before auth too: an unauthenticated cross-origin probe must not even reach the
    // session lookup.
    expect(mockGetServerAuthSession).not.toHaveBeenCalled();
  });

  it('allows a same-origin request in production', async () => {
    prodFlag.value = true;
    mockIsAllowedOriginRequest.mockReturnValue(true);
    const req = makeReq([Buffer.from('bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockIsAllowedOriginRequest).toHaveBeenCalled();
  });

  // AUDIT-F4. The route buffers whole, so unbounded concurrency is an OOMKill of the
  // pod — taking every unrelated request on it down, not just uploads.
  it('sheds with 503 once MAX_CONCURRENT_RELAYS are in flight', async () => {
    // Hold every slot open by never resolving the store call.
    let release: () => void = () => undefined;
    mockUploadImageBufferToStore.mockImplementation(
      () =>
        new Promise((r) => {
          const prev = release;
          release = () => {
            prev();
            r({ key: 'server-minted-uuid', backend: 'backblaze' });
          };
        })
    );

    const held = Array.from({ length: MAX_CONCURRENT_RELAYS }, () =>
      handler(makeReq([Buffer.from('bytes')]), makeRes())
    );
    // Let each occupy its slot before the one that should be shed arrives.
    await new Promise((r) => setTimeout(r, 10));
    expect(__getInFlightForTest()).toBe(MAX_CONCURRENT_RELAYS);

    const shedRes = makeRes();
    await handler(makeReq([Buffer.from('bytes')]), shedRes);
    expect(shedRes.statusCode).toBe(503);
    expect(shedRes.headers['Retry-After']).toBe('5');

    release();
    await Promise.all(held);
    // Every slot handed back.
    expect(__getInFlightForTest()).toBe(0);
  });

  it('releases its slot on EVERY exit path, not just success', async () => {
    // A leaked slot is permanent: the route wedges at 503 until the pod restarts,
    // which is worse than the OOM the cap prevents. Drive each early return.
    const before = __getInFlightForTest();

    mockUploadImageBufferToStore.mockRejectedValue(new Error('store down'));
    await handler(makeReq([Buffer.from('bytes')]), makeRes());
    expect(__getInFlightForTest()).toBe(before);

    await handler(makeReq([Buffer.alloc(0)]), makeRes()); // empty-body 400
    expect(__getInFlightForTest()).toBe(before);

    const half = Math.floor(MAX_RELAY_BYTES / 2) + 1;
    await handler(makeReq([Buffer.alloc(half), Buffer.alloc(half)]), makeRes()); // 413
    expect(__getInFlightForTest()).toBe(before);
  });

  it('does NOT put the store error message on the wire', async () => {
    mockUploadImageBufferToStore.mockRejectedValue(
      new Error('bucket EXAMPLE-BUCKET endpoint s3.example.invalid reqId REQ-123')
    );
    const req = makeReq([Buffer.from('bytes')]);
    const res = makeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('EXAMPLE-BUCKET');
    expect(wire).not.toContain('s3.example.invalid');
    expect(wire).not.toContain('REQ-123');
  });
});
