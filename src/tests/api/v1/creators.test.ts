import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

// The handler builds a tRPC caller via publicApiContext2 and calls
// `apiCaller.user.getCreators(req.query)`. Mock publicApiContext2 to return a
// caller whose `user.getCreators` is a vi.fn we control — this drives the
// handler's success + error-classification paths in isolation (mirrors the
// users/index handler test).
const { mockPublicApiContext2, mockGetCreators } = vi.hoisted(() => ({
  mockPublicApiContext2: vi.fn(),
  mockGetCreators: vi.fn(),
}));

vi.mock('~/server/createContext', () => ({
  publicApiContext2: mockPublicApiContext2,
}));

// PublicEndpoint is a simple passthrough wrapper in tests.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

// NOTE: isClientAbortError (~/server/utils/errorHandling), getPaginationLinks
// and mapCreatorItem (getEdgeUrl) are kept REAL so the handler's production
// classification + mapping logic runs unmodified.

import handler from '~/pages/api/v1/creators';

function createMocks({ query = {} }: { query?: Record<string, string | string[]> }) {
  const req = {
    method: 'GET',
    url: '/api/v1/creators',
    headers: { host: 'civitai.com' },
    query,
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  let ended = false;

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
    end() {
      ended = true;
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _ended: () => ended,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _ended: () => boolean;
  };

  return { req, res };
}

describe('/api/v1/creators error-body JSON.parse guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublicApiContext2.mockResolvedValue({ user: { getCreators: mockGetCreators } });
  });

  it('happy path is unchanged (200) with mapped items + metadata', async () => {
    mockGetCreators.mockResolvedValue({
      items: [{ username: 'alice', _count: { models: 3 } }],
      currentPage: 1,
      totalPages: 1,
    });
    const { req, res } = createMocks({ query: {} });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.items).toEqual([
      {
        username: 'alice',
        modelCount: 3,
        link: 'http://localhost:3000/api/v1/models?username=alice',
        image: undefined,
      },
    ]);
    expect(body.metadata.currentPage).toBe(1);
  });

  it('search path (?query=): hasMore metadata still emits a nextPage link + valid totals', async () => {
    // The username-search path drops the exact COUNT and returns hasMore-based
    // lower-bound pagination (totalPages = currentPage+1 while more remain). The
    // public response shape must stay intact: items mapped, metadata.totalItems /
    // totalPages present + numeric, and nextPage generated so REST pagination
    // keeps working.
    mockGetCreators.mockResolvedValue({
      items: [{ username: 'bob', _count: { models: 1 } }],
      totalItems: 21, // lower bound (skipped 20 + 1 item + 1 more)
      currentPage: 1,
      pageSize: 20,
      totalPages: 2, // currentPage + 1
      hasMore: true,
    });
    const { req, res } = createMocks({ query: { query: 'bo' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.items[0].username).toBe('bob');
    // contract fields present + numeric
    expect(typeof body.metadata.totalItems).toBe('number');
    expect(typeof body.metadata.totalPages).toBe('number');
    expect(body.metadata.currentPage).toBe(1);
    expect(body.metadata.hasMore).toBe(true);
    // nextPage link is emitted (currentPage < totalPages) so callers can page on.
    expect(body.metadata.nextPage).toContain('page=2');
  });

  it('a TRPCError with a JSON-stringified message is parsed and returned as before (no regression)', async () => {
    // Some errors legitimately carry a JSON-stringified body (zod/validation).
    // The pre-existing success path must keep parsing them.
    const jsonError = new TRPCError({
      code: 'BAD_REQUEST',
      message: JSON.stringify([{ path: ['limit'], message: 'must be a number' }]),
    });
    mockGetCreators.mockRejectedValue(jsonError);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual([{ path: ['limit'], message: 'must be a number' }]);
  });

  it('returns a clean 500 (no throw) for a throwDbError-wrapped TRPCError INTERNAL_SERVER_ERROR with a PLAIN-STRING message', async () => {
    // The real prod non-transient shape: a Prisma/app failure becomes a TRPCError
    // INTERNAL_SERVER_ERROR whose `message` is a bare string, NOT JSON. Against the
    // UN-hardened handler `JSON.parse('Database connection lost')` throws a
    // SyntaxError that escapes the catch → raw unhandled Next 500. The hardened
    // handler falls back to { message } with the correct HTTP status.
    const dbError = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Database connection lost',
    });
    mockGetCreators.mockRejectedValue(dbError);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({ message: 'Database connection lost' });
  });

  it('client abort (499) branch is unchanged — ends without a body', async () => {
    // isClientAbortError (kept real) recognizes the aborted-operation message.
    const abort = new Error('The operation was aborted');
    mockGetCreators.mockRejectedValue(abort);
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(499);
    expect(res._ended()).toBe(true);
    expect(res._getJSONData()).toBeUndefined();
  });

  it('a non-TRPCError failure still surfaces as a generic 500', async () => {
    mockGetCreators.mockRejectedValue(new Error('cannot read properties of undefined'));
    const { req, res } = createMocks({ query: {} });

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData().message).toBe('An unexpected error occurred');
  });
});
