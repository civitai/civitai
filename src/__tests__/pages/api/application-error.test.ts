import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EnvOther from '~/env/other';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  APPLICATION_ERROR_RATE_LIMIT_MAX,
  APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS,
} from '~/server/utils/application-error-rate-limit';
const mockLogToAxiom = loggingMock.logToAxiom;
const mockSysRedis = redisMock.sysRedis;

// Covers the `resolveStack` opt-out on `/api/application-error`.
//
// 🔴 Why this file exists rather than only client-side assertions: the client tests pin what the
// browser SENDS, and a mutation that made this handler IGNORE the flag — resolving every stack
// regardless — left that whole suite green. The amplification this opt-out exists to prevent could
// therefore return through a server-side edit with nothing going red. This pins the other half of
// the seam: that the handler HONOURS what the client asked for.
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

const { mockGetServerAuthSession, mockApplySourceMaps, prodFlag } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockApplySourceMaps: vi.fn(),
  prodFlag: { value: true },
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

vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  applySourceMaps: mockApplySourceMaps,
}));

const importHandler = async () => (await import('~/pages/api/application-error')).default;

/**
 * `clientIp` makes the request EDGE-ATTESTED from that address (`cf-connecting-ip`
 * alongside `cf-ray`), which is what the per-IP limiter keys its bucket on.
 * Omitting it leaves every request on one shared transport peer, which is the
 * right default for the `resolveStack` cases below — they do not vary by client.
 */
const makeReqRes = (body: unknown, clientIp?: string) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    getHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST',
    // The handler does `JSON.parse(req.body)`, so this must be the RAW string — which is what
    // Next's body parser yields when no JSON content-type is declared.
    body: JSON.stringify(body),
    headers: {
      referer: 'https://example.test/models/1',
      ...(clientIp ? { 'cf-ray': '8a1b2c3d4e5f6789-IAD', 'cf-connecting-ip': clientIp } : {}),
    },
    socket: { remoteAddress: '10.42.0.9' },
    query: {},
  } as unknown as NextApiRequest;
  return { req, res };
};

const MINIFIED = 'Error: x\n  at a (https://example.test/_next/static/chunks/main-abc.js:1:2345)';

/**
 * A real in-memory fixed-window counter behind the canonical redis mock, keyed on
 * the key the limiter actually builds.
 *
 * 🔴 Load-bearing for the whole file, not only the rate-limit block. Left on the
 * mock's vivified defaults the limiter's MULTI chain throws, the limiter FAILS
 * OPEN, and every request is served — so the `resolveStack` assertions would pass
 * while measuring the catch block instead of the limiter. Wiring a working
 * counter is what keeps those cases on the path production takes.
 */
let store: Map<string, { count: number; ttl: number }>;

function installRateLimitCounter() {
  store = new Map();
  mockSysRedis.multi.mockImplementation(() => {
    let key: string | undefined;
    const chain = {
      set(k: string, _v: string, opts: { NX?: boolean; EX?: number }) {
        key = k;
        if (opts?.NX && !store.has(k)) store.set(k, { count: 0, ttl: opts.EX ?? -1 });
        return chain;
      },
      incr(k: string) {
        key = k;
        return chain;
      },
      async exec() {
        const entry = store.get(key as string);
        if (!entry) return ['OK', null];
        entry.count += 1;
        return ['OK', entry.count];
      },
    };
    return chain;
  });
  mockSysRedis.ttl.mockImplementation(async (k: string) => store.get(k)?.ttl ?? -2);
  mockSysRedis.expire.mockImplementation(async (k: string, seconds: number) => {
    const entry = store.get(k);
    if (entry) entry.ttl = seconds;
    return true;
  });
}

/** Drive the REAL endpoint `times` times from one address. */
async function post(times: number, clientIp: string) {
  let last!: ReturnType<typeof makeReqRes>;
  for (let i = 0; i < times; i++) {
    last = makeReqRes({ message: 'boom', stack: MINIFIED }, clientIp);
    await (
      await importHandler()
    )(last.req, last.res);
  }
  return last;
}

beforeEach(() => {
  vi.clearAllMocks();
  prodFlag.value = true;
  mockGetServerAuthSession.mockResolvedValue(null);
  mockApplySourceMaps.mockImplementation(async (s: string) => `RESOLVED:${s}`);
  mockLogToAxiom.mockResolvedValue(undefined);
  installRateLimitCounter();
});

describe('/api/application-error — the resolveStack opt-out', () => {
  it('SKIPS sourcemap resolution when the caller sets resolveStack false', async () => {
    const handler = await importHandler();
    const { req, res } = makeReqRes({ message: 'boom', stack: MINIFIED, resolveStack: false });

    await handler(req, res);

    expect(mockApplySourceMaps).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    // The stack is still STORED — unresolved, and resolvable offline against the maps artifact.
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ stack: MINIFIED });
  });

  it('resolves as before when the flag is absent, so existing callers are unchanged', async () => {
    const handler = await importHandler();
    const { req, res } = makeReqRes({ message: 'boom', stack: MINIFIED });

    await handler(req, res);

    expect(mockApplySourceMaps).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ stack: `RESOLVED:${MINIFIED}` });
  });

  it('resolves when the flag is explicitly true', async () => {
    const handler = await importHandler();
    const { req, res } = makeReqRes({ message: 'boom', stack: MINIFIED, resolveStack: true });

    await handler(req, res);

    expect(mockApplySourceMaps).toHaveBeenCalledTimes(1);
  });

  // Positive control on the mock wiring: if the schema rejected the new field, every assertion
  // above would pass vacuously via the 400 path without `logToAxiom` ever being reached. This
  // asserts the 200 path is the one being exercised.
  it('accepts the field rather than 400ing on it', async () => {
    const handler = await importHandler();
    const { req, res } = makeReqRes({ message: 'boom', stack: MINIFIED, resolveStack: false });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Reaching `logToAxiom` is only possible past `schema.parse`, so this distinguishes the 200
    // path from the 400 path that a rejected field would take — without which the three
    // assertions above could all pass vacuously.
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
  });
});

/**
 * The per-IP bound, driven through the REAL handler and its REAL wrapper.
 *
 * The limiter's own unit suite
 * (`src/server/utils/__tests__/application-error-rate-limit.test.ts`) pins the
 * counter semantics. What that suite structurally CANNOT see is the seam: whether
 * this handler calls the limiter at all, whether it answers 429, and whether the
 * work the limit exists to shed is actually shed. A limiter that is correct and
 * never called is green on both sides of that seam and broken in production.
 */
describe('/api/application-error — the per-IP rate limit', () => {
  it('serves every request UP TO the limit', async () => {
    const { res } = await post(APPLICATION_ERROR_RATE_LIMIT_MAX, '203.0.113.7');
    expect(res.status).toHaveBeenLastCalledWith(200);
    expect(mockLogToAxiom).toHaveBeenCalledTimes(APPLICATION_ERROR_RATE_LIMIT_MAX);
  });

  it('answers 429 once the limit is exceeded', async () => {
    await post(APPLICATION_ERROR_RATE_LIMIT_MAX, '203.0.113.7');
    const { res } = await post(1, '203.0.113.7');
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('sets Retry-After on the refusal, so a caller is told when to come back', async () => {
    await post(APPLICATION_ERROR_RATE_LIMIT_MAX, '203.0.113.7');
    const { res } = await post(1, '203.0.113.7');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      String(APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS)
    );
  });

  it('SHEDS the work: a limited request writes no report and resolves no sourcemap', async () => {
    // The 429 status alone would be satisfied by a handler that did all its work
    // and then changed the status code. This asserts the limit actually bounds
    // what the endpoint contributes downstream, which is the entire point.
    await post(APPLICATION_ERROR_RATE_LIMIT_MAX, '203.0.113.7');
    const before = mockLogToAxiom.mock.calls.length;
    const resolvedBefore = mockApplySourceMaps.mock.calls.length;

    await post(1, '203.0.113.7');

    expect(mockLogToAxiom.mock.calls.length).toBe(before);
    expect(mockApplySourceMaps.mock.calls.length).toBe(resolvedBefore);
  });

  it('is PER IP: an exhausted address does not spend another address budget', async () => {
    await post(APPLICATION_ERROR_RATE_LIMIT_MAX + 1, '203.0.113.7');
    const noisyRefused = await post(1, '203.0.113.7');
    expect(noisyRefused.res.status).toHaveBeenCalledWith(429);

    // A different client, mid-incident, is still heard.
    const bystander = await post(1, '198.51.100.4');
    expect(bystander.res.status).toHaveBeenCalledWith(200);
    expect(bystander.res.status).not.toHaveBeenCalledWith(429);
  });

  it('POSITIVE CONTROL: the 200 and 429 arms are distinguishable on the SAME fixture', async () => {
    // Guards against a harness in which every request 429s (or none does) for a
    // reason unrelated to the counter — the two arms differ only in how many
    // requests preceded them.
    const first = await post(1, '192.0.2.10');
    expect(first.res.status).toHaveBeenCalledWith(200);

    await post(APPLICATION_ERROR_RATE_LIMIT_MAX, '192.0.2.10');
    const past = await post(1, '192.0.2.10');
    expect(past.res.status).toHaveBeenCalledWith(429);
  });

  it('FAILS OPEN when the limiter dependency is down', async () => {
    // The chosen direction: an outage of the limiter must not delete the signal
    // this endpoint carries. Asserted through the handler, since that is where
    // the consequence is visible.
    mockSysRedis.multi.mockImplementation(() => {
      throw new Error('redis down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { res } = await post(APPLICATION_ERROR_RATE_LIMIT_MAX + 5, '203.0.113.7');

    expect(res.status).toHaveBeenLastCalledWith(200);
    expect(res.status).not.toHaveBeenCalledWith(429);
    warn.mockRestore();
  });

  it('does not disturb the absent-name default that reporting depends on', async () => {
    // Requirement pinned next to the change that could have broken it: an absent
    // `name` still arrives downstream as the literal default, unchanged by the
    // limiter sitting in front of the handler.
    await post(1, '203.0.113.7');
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({ name: 'application-error' });
  });
});
