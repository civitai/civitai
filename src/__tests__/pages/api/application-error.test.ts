import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EnvOther from '~/env/other';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import type * as LoggingClient from '~/server/logging/client';

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

const { mockGetServerAuthSession, mockApplySourceMaps, mockLogToAxiom, prodFlag } = vi.hoisted(
  () => ({
    mockGetServerAuthSession: vi.fn(),
    mockApplySourceMaps: vi.fn(),
    mockLogToAxiom: vi.fn(),
    prodFlag: { value: true },
  })
);

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

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: mockLogToAxiom,
}));

const importHandler = async () => (await import('~/pages/api/application-error')).default;

const makeReqRes = (body: unknown) => {
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
    headers: { referer: 'https://example.test/models/1' },
    query: {},
  } as unknown as NextApiRequest;
  return { req, res };
};

const MINIFIED = 'Error: x\n  at a (https://example.test/_next/static/chunks/main-abc.js:1:2345)';

beforeEach(() => {
  vi.clearAllMocks();
  prodFlag.value = true;
  mockGetServerAuthSession.mockResolvedValue(null);
  mockApplySourceMaps.mockImplementation(async (s: string) => `RESOLVED:${s}`);
  mockLogToAxiom.mockResolvedValue(undefined);
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
