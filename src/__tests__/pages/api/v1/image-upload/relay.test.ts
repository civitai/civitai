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
// wholesale factory for `~/utils/s3-utils` — which exports 31 runtime symbols —
// collapses the whole file to "no tests" the moment the route imports a second symbol
// from it: a silent zero, not a failure.
//
// ⚠ NOTHING ENFORCES THIS. An earlier version of this comment said the shape is what
// `local-rules/no-wholesale-module-mock` "exists to prevent", implying that rule
// covers this file. Measured in a round-2 audit: it does NOT — the rule is configured
// with an explicit five-module allowlist and none of the modules mocked here is on
// it. Planting the wholesale factory produces zero errors from that rule. Keep the
// mocks surgical by hand; no lint will catch you.

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
  NEXT_BODY_TRUNCATION_BYTES,
  MAX_CONCURRENT_RELAYS,
  RELAY_RETRY_AFTER_SECONDS,
  __getInFlightForTest,
  __resetInFlightForTest,
} from '~/pages/api/v1/image-upload/relay';

/** Records the order in which the handler wrote a status vs destroyed the request. */
type Trace = string[];

function makeReq(
  chunks: Buffer[],
  opts?: { method?: string; contentType?: string; trace?: Trace; contentLength?: number }
): NextApiRequest {
  return decorate(Readable.from(chunks) as unknown as NextApiRequest, opts);
}

/**
 * A request whose body records how many chunks were actually pulled from it.
 *
 * Needed because "rejected without reading the body" is a claim about CONSUMPTION,
 * and a status code cannot witness it — the route could read everything and still
 * answer 413. `pulled` is the observable, so a mutant that drops the pre-read
 * rejection and falls through to the running-total check is caught by a count rather
 * than by the status it happens to share.
 */
function makeCountingReq(
  chunks: Buffer[],
  opts?: { contentLength?: number }
): { req: NextApiRequest; pulled: Buffer[] } {
  const pulled: Buffer[] = [];
  const gen = (function* () {
    for (const c of chunks) {
      pulled.push(c);
      yield c;
    }
  })();
  return {
    req: decorate(Readable.from(gen) as unknown as NextApiRequest, opts),
    pulled,
  };
}

function decorate(
  stream: NextApiRequest,
  opts?: { method?: string; contentType?: string; trace?: Trace; contentLength?: number }
): NextApiRequest {
  stream.method = opts?.method ?? 'POST';
  stream.headers = {
    'content-type': opts?.contentType ?? 'image/png',
    // Omitted unless a case asks for it, so every pre-existing case keeps exercising
    // the no-declared-length path (a chunked sender) rather than silently switching
    // to the Content-Length guards added for the truncation fix.
    ...(opts?.contentLength !== undefined ? { 'content-length': String(opts.contentLength) } : {}),
  };
  stream.query = {};
  const trace = opts?.trace;
  const realDestroy = stream.destroy.bind(stream);
  stream.destroy = ((...args: unknown[]) => {
    trace?.push('destroy');
    return (realDestroy as (...a: unknown[]) => unknown)(...args);
  }) as typeof stream.destroy;
  // Pass-THROUGH spy, deliberately not a stub. An earlier version replaced `resume`
  // outright, which could only observe the call and not its effect — and that is how a
  // `resume()` that was inert (a no-op while the async iterator holds a `'readable'`
  // listener) survived a green suite. Calling through keeps the real behaviour
  // observable while still recording that it happened.
  const realResume = stream.resume.bind(stream);
  stream.resume = ((...args: unknown[]) => {
    trace?.push('resume');
    return (realResume as (...a: unknown[]) => unknown)(...args);
  }) as typeof stream.resume;
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
  // A case that leaves a slot held would otherwise make the NEXT case fail for an
  // unrelated reason — measured as a false cascading failure during round-2 mutation.
  __resetInFlightForTest();
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

  // AUDIT-F5 + AUDIT-F6. Two properties of the oversize path.
  //
  //  * F5: the 413 must reach the client. Three earlier attempts did not deliver it or
  //    delivered it for the wrong reason — `req.destroy()` RSTs the socket;
  //    `Connection: close` makes `res.end()` call `socket.destroySoon()` which RSTs it
  //    too when inbound data is unread; and a `req.resume()` "drain" turned out to be a
  //    no-op, because driving the stream's async iterator keeps a `'readable'` listener
  //    registered and `Readable.resume()` does nothing while `readableListening` is
  //    true. Measured against a real socket, NOT closing the connection is the whole
  //    fix. So: no `Connection` header, no destroy, and no resume call.
  //  * F6: the running-total property. Asserting the 413 alone does NOT pin it — a
  //    measure-at-the-end implementation returns the same 413. What discriminates is
  //    that a running total STOPS READING, so the stream never reaches EOF.
  //
  // 🔴 THIS TEST CANNOT SEE DELIVERY. `makeReq` is a `Readable.from` and `makeRes` an
  // object literal — no socket. It pins the calls the real-socket measurement showed
  // matter. An earlier version ALSO stubbed `req.resume` to assert it was called, which
  // could only ever observe the call and not its effect — which is exactly how an inert
  // line survived a green suite. The stub is gone; `readableFlowing` below is a state
  // assertion the fixture genuinely supports.
  //
  // ⚠ What does NOT work: counting chunks the async source yielded. Node's Readable
  // reads AHEAD of the consumer, so the running-total implementation still pulls the
  // chunk after the one that trips the cap.
  it('writes the 413 without closing or draining, and stops reading before EOF', async () => {
    const trace: Trace = [];
    const half = Math.floor(MAX_RELAY_BYTES / 2) + 1;
    const req = makeReq([Buffer.alloc(half), Buffer.alloc(half)], { trace });
    const res = makeRes(trace);

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    // F5: `Connection: close` is what destroyed the socket before the status landed.
    expect(res.headers['Connection']).toBeUndefined();
    // F5: and nothing may destroy the request either.
    expect(trace).toEqual(['status:413']); // no 'destroy', no 'resume'
    // F5: no drain is attempted at all. `readableFlowing`/`readableEnded` CANNOT pin
    // this — `resume()` schedules its reads asynchronously, so on this fixture a real
    // drain has moved neither by the time the handler returns (measured: a
    // `removeAllListeners('readable') + resume()` mutant passes both). The trace above
    // is what pins it, via a pass-through spy rather than a stub.
    // F6: a measure-at-the-end implementation consumes to EOF and fails here while
    // still returning the same 413.
    expect((req as unknown as { readableEnded: boolean }).readableEnded).toBe(false);
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
  it('sheds with 429 once MAX_CONCURRENT_RELAYS are in flight', async () => {
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
    // 429, NOT 503: `instrumentApiResponse` counts every status >= 500 as an app
    // error, so shedding with a 5xx would report deliberate healthy load-shedding as
    // a server fault in this route's own attribution.
    expect(shedRes.statusCode).toBe(429);
    expect(shedRes.headers['Retry-After']).toBe(String(RELAY_RETRY_AFTER_SECONDS));

    release();
    await Promise.all(held);
    // Every slot handed back.
    expect(__getInFlightForTest()).toBe(0);
  });

  it('releases its slot on EVERY exit path, not just success', async () => {
    // A leaked slot is permanent: the route wedges, shedding every request with 429
    // until the pod restarts,
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

  // AUDIT-5 — these ARE regression guards, and they are red against f47b17e9ff.
  //
  // Verified on a deployed preview (Next 16.3.1): the framework truncates a request
  // body at 10MB and ENDS the stream, so the route saw a clean end-of-body, stored the
  // fragment and returned 200 with an id. A valid 14,523,378-byte PNG came back as a
  // 10,485,209-byte object with no IEND terminator. The unit tier could not see it
  // because these fixtures drive `Readable.from`, which never truncates — so the
  // guards are what is pinned here, not the framework behaviour.
  describe('truncated and over-size bodies never reach the store', () => {
    it('refuses a declared Content-Length over the cap WITHOUT reading the body', async () => {
      const { req, pulled } = makeCountingReq([Buffer.from('a'), Buffer.from('b')], {
        contentLength: MAX_RELAY_BYTES + 1,
      });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(413);
      // The point of rejecting early: nothing was buffered.
      expect(pulled).toHaveLength(0);
      expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
    });

    it('rejects a body that ends short of its declared length', async () => {
      // 10 bytes promised, 4 delivered — the shape Next's truncation produces.
      const req = makeReq([Buffer.from('abcd')], { contentLength: 10 });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Upload body was incomplete' });
      // 🔴 The assertion that matters. A 400 with the object still written would be
      // the same corruption wearing a different status.
      expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
    });

    it('accepts a body that matches its declared length', async () => {
      // Positive control for BOTH guards above: without it, a mutant that rejects
      // unconditionally would pass every case in this block.
      const req = makeReq([Buffer.from('abc'), Buffer.from('de')], { contentLength: 5 });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
      const [sent] = mockUploadImageBufferToStore.mock.calls[0] as [Buffer];
      expect(sent.toString()).toBe('abcde');
    });

    it('still accepts a complete body when no Content-Length is declared', async () => {
      // Chunked senders declare nothing; the guards must not turn that into a refusal.
      const req = makeReq([Buffer.from('abcde')]);
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
    });

    it('keeps MAX_RELAY_BYTES at or below the point where Next truncates', () => {
      // 🔴 A RELATIONSHIP, not a value. Raising MAX_RELAY_BYTES above the framework's
      // truncation point silently restores the original defect: bodies between the two
      // are cut mid-stream, and the running-total cap never fires because the stream
      // ends before it is exceeded. Whoever raises it must raise
      // `middlewareClientMaxBodySize` in next.config.mjs in the same change — this
      // fails until they do.
      expect(MAX_RELAY_BYTES).toBeLessThanOrEqual(NEXT_BODY_TRUNCATION_BYTES);
    });

    it('releases the in-flight slot after refusing a truncated body', async () => {
      // The refusal returns through the same `finally`; a leaked slot would wedge the
      // route into shedding every later request with 429 until the pod restarts.
      const before = __getInFlightForTest();
      await handler(makeReq([Buffer.from('ab')], { contentLength: 99 }), makeRes());
      expect(__getInFlightForTest()).toBe(before);
    });
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
