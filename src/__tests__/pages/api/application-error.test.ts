import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EnvOther from '~/env/other';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLogToAxiom = loggingMock.logToAxiom;

// Covers the `resolveStack` opt-out and the same-origin beacon guard on `/api/application-error`.
//
// 🔴 Why this file exists rather than only client-side assertions: the client tests pin what the
// browser SENDS, and a mutation that made this handler IGNORE the flag — resolving every stack
// regardless — left that whole suite green. The amplification this opt-out exists to prevent could
// therefore return through a server-side edit with nothing going red. This pins the other half of
// the seam: that the handler HONOURS what the client asked for.
//
// The guard block below is the seam the guard's own unit suite
// (`src/server/utils/__tests__/beacon-same-origin.test.ts`) structurally CANNOT see: that suite
// pins the predicate, this one pins that the handler CALLS it, answers 400, and sheds the work
// behind it. A predicate that is correct and never called is green on both sides and broken in
// production.
//
// Mocks are SURGICAL (spread `importOriginal`, override one symbol) per the convention in
// `src/__tests__/pages/api/v1/image-upload/relay.test.ts` — a one-key wholesale factory collapses
// the file to "no tests" the moment the route imports a second symbol from that module, which is a
// silent zero rather than a failure.
//
// `logToAxiom` comes from the CANONICAL shared mock, not a local `vi.fn()`. That is enforced:
// `src/server/services/__tests__/no-direct-shared-module-mock.test.ts` fails the build otherwise,
// and `scripts/test-perf/codemod-shared-mocks.mjs --write <file>` performs the conversion. Found by
// CI, not locally — running only this file and the ErrorBoundary suites never executes that gate.

const { mockGetServerAuthSession, mockApplySourceMaps, prodFlag, devFlag } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockApplySourceMaps: vi.fn(),
  prodFlag: { value: true },
  devFlag: { value: false },
}));

// `~/env/client` validates at import and throws on a missing NEXT_PUBLIC_* — the worker setup mocks
// `~/env/server` but not this one. Same shape the `*.edge-cache-chain` tests use; `importOriginal`
// is deliberately NOT spread here, because the module under mock is the one that throws.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

// Both flags are GETTERS over a hoisted box rather than fixed values, so a single test can flip
// one without re-mocking the module. The dev case below is what makes that dynamism load-bearing,
// and it carries its own control: it asserts the SAME request 400s with the flag down and 200s
// with it up, so a getter that had silently frozen would fail rather than read as a pass.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  get isProd() {
    return prodFlag.value;
  },
  get isDev() {
    return devFlag.value;
  },
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  applySourceMaps: mockApplySourceMaps,
}));

const importHandler = async () => (await import('~/pages/api/application-error')).default;

/** The host this fixture pretends the app was served from. */
const HOST = 'example.test';

/**
 * A request as a real in-app report arrives: a browser `fetch()` of a RELATIVE path from a document
 * this app served, so `Origin` and `Host` are the same host by construction. `headers` overrides
 * that default, which is how the guard cases below vary one header at a time.
 */
const makeReqRes = (body: unknown, headers: Record<string, string | undefined> = {}) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    getHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const merged: Record<string, string | undefined> = {
    host: HOST,
    origin: `https://${HOST}`,
    referer: `https://${HOST}/models/1`,
    ...headers,
  };
  // An explicit `undefined` in the override means "this header was not sent", which is a distinct
  // case from "it was sent empty" and is exactly what the absent-header test needs.
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];

  const req = {
    method: 'POST',
    // The handler does `JSON.parse(req.body)`, so this must be the RAW string — which is what
    // Next's body parser yields when no JSON content-type is declared.
    body: JSON.stringify(body),
    headers: merged,
    socket: { remoteAddress: '10.42.0.9' },
    query: {},
  } as unknown as NextApiRequest;
  return { req, res };
};

const MINIFIED = 'Error: x\n  at a (https://example.test/_next/static/chunks/main-abc.js:1:2345)';

/**
 * Drive the REAL handler through its REAL wrapper once.
 *
 * `spies` holds the response mocks captured BEFORE the call. The wrapper instruments the response
 * object on entry and replaces some of its methods with its own, so reading `res.send` afterwards
 * yields a plain function and `toHaveBeenCalledWith` fails with "not a spy" — which reads as the
 * handler having taken a different branch rather than as the wrapper having swapped the method.
 */
async function post(body: unknown, headers: Record<string, string | undefined> = {}) {
  const { req, res } = makeReqRes(body, headers);
  const spies = { status: res.status, send: res.send, end: res.end };
  await (
    await importHandler()
  )(req, res);
  return { req, res, spies };
}

beforeEach(() => {
  vi.clearAllMocks();
  prodFlag.value = true;
  devFlag.value = false;
  mockGetServerAuthSession.mockResolvedValue(null);
  mockApplySourceMaps.mockImplementation(async (s: string) => `RESOLVED:${s}`);
  mockLogToAxiom.mockResolvedValue(undefined);
});

describe('/api/application-error — the resolveStack opt-out', () => {
  it('SKIPS sourcemap resolution when the caller sets resolveStack false', async () => {
    const { res } = await post({ message: 'boom', stack: MINIFIED, resolveStack: false });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockApplySourceMaps).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    // The stack is still STORED — unresolved, and resolvable offline against the maps artifact.
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ stack: MINIFIED });
  });

  it('resolves as before when the flag is absent, so existing callers are unchanged', async () => {
    await post({ message: 'boom', stack: MINIFIED });

    expect(mockApplySourceMaps).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ stack: `RESOLVED:${MINIFIED}` });
  });

  it('resolves when the flag is explicitly true', async () => {
    await post({ message: 'boom', stack: MINIFIED, resolveStack: true });

    expect(mockApplySourceMaps).toHaveBeenCalledTimes(1);
  });

  // Positive control on the mock wiring: if the schema rejected the new field, every assertion
  // above would pass vacuously via the 400 path without `logToAxiom` ever being reached. This
  // asserts the 200 path is the one being exercised.
  it('accepts the field rather than 400ing on it', async () => {
    const { res } = await post({ message: 'boom', stack: MINIFIED, resolveStack: false });

    expect(res.status).toHaveBeenCalledWith(200);
    // Reaching `logToAxiom` is only possible past `schema.parse`, so this distinguishes the 200
    // path from the 400 path that a rejected field would take — without which the three
    // assertions above could all pass vacuously.
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
  });

  it('does not disturb the absent-name default that reporting depends on', async () => {
    // Requirement pinned next to the change that could have broken it: an absent `name` still
    // arrives downstream as the literal default, unchanged by the guard sitting in front.
    await post({ message: 'boom', stack: MINIFIED });
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ name: 'application-error' });
  });
});

/**
 * The same-origin beacon guard, driven through the REAL handler and its REAL wrapper.
 *
 * 🔴 The direction that matters here is the FALSE-REJECT one. A guard that lets too much through
 * costs a little noise; a guard that rejects our own pages deletes the operational signal the
 * endpoint exists to carry, and deletes it silently — `fetch` does not reject on a 4xx and the
 * reporting helper terminates its promise with `.catch`, so a wrongly-rejected report looks exactly
 * like no error having occurred. Every accept case below is therefore an assertion about a real
 * in-app request shape, not a convenience.
 */
describe('/api/application-error — the same-origin beacon guard', () => {
  it('ACCEPTS a same-origin report — the shape every in-app caller actually sends', async () => {
    const { res } = await post({ message: 'boom', stack: MINIFIED });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status).not.toHaveBeenCalledWith(400);
    // Past the guard AND past the schema: `logToAxiom` is unreachable from the rejection branch,
    // so this distinguishes "accepted" from "400ed for some other reason".
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTS on Referer alone when the client suppressed Origin', async () => {
    // The sibling beacons' documented fallback. Asserted rather than assumed, because this is the
    // arm that decides whether a browser or privacy setting that omits Origin loses its reports.
    const { res } = await post({ message: 'boom', stack: MINIFIED }, { origin: undefined });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTS when the served host carries a port, which the comparison keeps on both sides', async () => {
    // `new URL(...).host` includes a non-default port, and so does the `Host` header. A guard that
    // compared hostname to host would reject every non-443 deployment — preview and local included.
    const { res } = await post(
      { message: 'boom', stack: MINIFIED },
      {
        host: 'preview.example.test:8443',
        origin: 'https://preview.example.test:8443',
        // Referer is overridden to MATCH as well, so this case isolates the port. Left on the
        // default it would also fail whenever the Origin/Referer precedence is disturbed, and a
        // mutant that flips that precedence would die here as well as at the test that names it —
        // reading as coverage of a property this case does not actually pin.
        referer: 'https://preview.example.test:8443/models/1',
      }
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a cross-origin post with 400', async () => {
    const { res } = await post(
      { message: 'boom', stack: MINIFIED },
      { origin: 'https://attacker.example', referer: 'https://attacker.example/x' }
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  it('SHEDS the work: a rejected post writes no report and resolves no sourcemap', async () => {
    // A 400 alone would be satisfied by a handler that did all its work and then changed the
    // status code. This asserts the guard actually bounds what the endpoint contributes
    // downstream, which is why it sits ahead of the session read and the parse.
    await post(
      { message: 'boom', stack: MINIFIED },
      { origin: 'https://attacker.example', referer: 'https://attacker.example/x' }
    );

    expect(mockLogToAxiom).not.toHaveBeenCalled();
    expect(mockApplySourceMaps).not.toHaveBeenCalled();
    expect(mockGetServerAuthSession).not.toHaveBeenCalled();
  });

  it('REJECTS when NEITHER header is present — absent is not allowed', async () => {
    // 🔴 The strict direction, pinned deliberately. An allow-on-absent rule is satisfied by
    // sending nothing at all, so it would bound nobody; this test is what stops a later edit
    // "fixing" the guard into inertness. It is also why the two accept cases above exist — they
    // are what says the strict direction does not catch our own pages.
    const { res } = await post(
      { message: 'boom', stack: MINIFIED },
      { origin: undefined, referer: undefined }
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('REJECTS a malformed Origin rather than throwing out of the handler', async () => {
    // Bot and scraper traffic sends these. `new URL()` throws on them, and an unguarded throw here
    // would land on the catch block's 400 with a parser message instead of the guard's.
    const { res, spies } = await post(
      { message: 'boom', stack: MINIFIED },
      { origin: ':://not a url', referer: undefined }
    );

    expect(res.status).toHaveBeenCalledWith(400);
    // The GUARD's message, not the catch block's. Both branches answer 400, so the status alone
    // cannot tell "rejected by the guard" from "the guard threw and the catch caught it" — and a
    // guard that throws on hostile input is a different defect from one that rejects it.
    expect(spies.send).toHaveBeenCalledWith({ message: 'invalid request' });
  });

  it('prefers Origin over Referer: a matching Referer does not rescue a mismatched Origin', async () => {
    const { res } = await post(
      { message: 'boom', stack: MINIFIED },
      { origin: 'https://attacker.example' }
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('is INERT in dev, and the same request proves the branch is live', async () => {
    // Both arms on ONE fixture, so this cannot pass by the request being acceptable anyway.
    const cross = { origin: 'https://attacker.example', referer: 'https://attacker.example/x' };

    devFlag.value = false;
    const prod = await post({ message: 'boom', stack: MINIFIED }, cross);
    expect(prod.res.status).toHaveBeenCalledWith(400);

    devFlag.value = true;
    const dev = await post({ message: 'boom', stack: MINIFIED }, cross);
    expect(dev.res.status).toHaveBeenCalledWith(200);
    // The rest of the handler still runs in dev — unlike the siblings, which return 200 before
    // their body parse. That is the deliberate divergence documented at the call site.
    expect(dev.res.status).not.toHaveBeenCalledWith(400);
  });

  it('POSITIVE CONTROL: the 200 and 400 arms are distinguishable on the SAME fixture', async () => {
    // Guards against a harness in which every request 400s (or none does) for a reason unrelated
    // to the guard — the two arms differ only in the Origin header.
    const ok = await post({ message: 'boom', stack: MINIFIED });
    expect(ok.res.status).toHaveBeenCalledWith(200);

    const bad = await post(
      { message: 'boom', stack: MINIFIED },
      { origin: 'https://attacker.example', referer: 'https://attacker.example/x' }
    );
    expect(bad.res.status).toHaveBeenCalledWith(400);
  });
});
