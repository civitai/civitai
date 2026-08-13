import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

// The handler builds a tRPC caller via publicApiContext2 and calls
// `apiCaller.tag.getAll(...)`. Mock publicApiContext2 to return a caller whose
// `tag.getAll` is a vi.fn we control — drives the handler's success + error
// classification paths in isolation (mirrors the users/index handler test).
const { mockPublicApiContext2, mockGetAll } = vi.hoisted(() => ({
  mockPublicApiContext2: vi.fn(),
  mockGetAll: vi.fn(),
}));

vi.mock('~/server/createContext', () => ({
  publicApiContext2: mockPublicApiContext2,
}));

// PublicEndpoint is a simple passthrough wrapper in tests.
// 🔴 Spread the ORIGINAL. This handler's catch now delegates to
// `handleEndpointError` (civitai#3845/4 — the hand-rolled envelope it used to
// carry leaked driver text), so replacing the module wholesale with a one-key
// object makes the route call `undefined` and fail for a reason unrelated to
// what this suite tests.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: any) => handler,
}));

// The handler imports the full appRouter; stub it so importing the handler does
// not pull the entire server graph. Only publicApiContext2 (mocked above) is
// used at runtime to build the caller.
vi.mock('~/server/routers', () => ({ appRouter: {} }));

// NOTE: isClientAbortError (~/server/utils/errorHandling) and getPaginationLinks
// are kept REAL so the handler's production classification logic runs unmodified.

import handler from '~/pages/api/v1/tags';

function createMocks({ query = {} }: { query?: Record<string, string | string[]> }) {
  const req = {
    method: 'GET',
    url: '/api/v1/tags',
    headers: { host: 'civitai.com' },
    query,
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  let ended = false;

  const headers: Record<string, unknown> = {};

  const res = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      payload = body;
      return res;
    },
    // Required since the route delegates to `handleEndpointError`, which marks a
    // genericized error response `no-store` (civitai#3845/4). Its absence here
    // surfaced as `TypeError: res.setHeader is not a function` in the full suite —
    // a fixture gap, not a production one, but the header IS asserted below so the
    // stub cannot quietly swallow a regression.
    setHeader(key: string, value: unknown) {
      headers[key] = value;
      return res;
    },
    end() {
      ended = true;
      return res;
    },
    _getHeader: (k: string) => headers[k],
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _ended: () => ended,
  } as unknown as NextApiResponse & {
    _getHeader: (k: string) => unknown;
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _ended: () => boolean;
  };

  return { req, res };
}

describe('/api/v1/tags error-body JSON.parse guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublicApiContext2.mockResolvedValue({ tag: { getAll: mockGetAll } });
  });

  it('happy path is unchanged (200) with mapped items + metadata', async () => {
    mockGetAll.mockResolvedValue({
      items: [{ name: 'anime', models: [] }],
      currentPage: 1,
      totalPages: 1,
    });
    const { req, res } = createMocks({ query: {} });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.items).toEqual([
      { name: 'anime', link: 'http://localhost:3000/api/v1/models?tag=anime' },
    ]);
    expect(body.metadata.currentPage).toBe(1);
  });

  it('a TRPCError with a JSON-stringified message is parsed and returned as before (no regression)', async () => {
    const jsonError = new TRPCError({
      code: 'BAD_REQUEST',
      message: JSON.stringify([{ path: ['limit'], message: 'must be a number' }]),
    });
    mockGetAll.mockRejectedValue(jsonError);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual([{ path: ['limit'], message: 'must be a number' }]);
  });

  it('returns a clean 500 (no throw) for a throwDbError-wrapped TRPCError INTERNAL_SERVER_ERROR with a PLAIN-STRING message', async () => {
    // The real prod non-transient shape: a Prisma/app failure becomes a TRPCError
    // INTERNAL_SERVER_ERROR whose `message` is a bare string, NOT JSON. Against the
    // UN-hardened handler `JSON.parse('Database connection lost')` throws a
    // SyntaxError that escapes the catch → raw unhandled Next 500. The point of
    // this test is that no input shape can produce that throw; it still holds.
    //
    // 🔴 The BODY assertion changed with civitai#3845/4. It used to read
    // `toEqual({ message: 'Database connection lost' })` — i.e. it PINNED the
    // driver text reaching an unauthenticated caller. This route now delegates to
    // `handleEndpointError`, which genericizes every 5xx and logs the un-redacted
    // text instead. The generic body is asserted by VALUE (not just "some 500") so
    // a regression that re-widens it fails here as well as in
    // `src/tests/api/rest-envelope-consolidation.test.ts`.
    const dbError = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Database connection lost',
    });
    mockGetAll.mockRejectedValue(dbError);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      error: 'An unexpected error occurred',
    });
    // `PublicEndpoint` stamps `public, s-maxage=300` on every response before the
    // handler runs, errors included. A genericized error must opt out.
    expect(res._getHeader('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('client abort (499) branch is unchanged — ends without a body', async () => {
    // isClientAbortError (kept real) recognizes the aborted-operation message.
    const abort = new Error('The operation was aborted');
    mockGetAll.mockRejectedValue(abort);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(499);
    expect(res._ended()).toBe(true);
    expect(res._getJSONData()).toBeUndefined();
  });

  it('a non-TRPCError failure still surfaces as a generic 500', async () => {
    mockGetAll.mockRejectedValue(new Error('cannot read properties of undefined'));
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData().message).toBe('An unexpected error occurred');
  });
});
