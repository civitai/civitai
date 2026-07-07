import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

// 1. Hoisted mocks. The handler builds a tRPC caller via publicApiContext2 and
// calls `apiCaller.user.getAll(...)`. We mock publicApiContext2 to return a
// caller whose `user.getAll` is a vi.fn we can resolve/reject — this drives the
// handler's success + error classification in isolation (mirrors the images
// handler test mocking the search service).
const { mockPublicApiContext2, mockGetAll } = vi.hoisted(() => ({
  mockPublicApiContext2: vi.fn(),
  mockGetAll: vi.fn(),
}));

vi.mock('~/server/createContext', () => ({
  publicApiContext2: mockPublicApiContext2,
}));

// Mock PublicEndpoint to be a simple passthrough wrapper (same as the images test).
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

// NOTE: isTransientMeiliError (~/server/meilisearch/client), isClientAbortError
// (~/server/utils/errorHandling) and the getAllUsersInput zod schema are kept
// REAL so the handler's production classification logic runs. env/prom at their
// module load are tolerated (no real connection opens in test).

// 2. Import the handler after the mocks are defined.
import handler from '~/pages/api/v1/users/index';

// 3. Helper to mock NextApiRequest/Response (mirrors the images handler test).
function createMocks({ query = {} }: { query?: Record<string, string | string[]> }) {
  const req = {
    method: 'GET',
    headers: {},
    query,
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  let ended = false;
  const headers: Record<string, string> = {};

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
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
    _getHeader: (name: string) => headers[name.toLowerCase()],
    _ended: () => ended,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _getHeader: (name: string) => string | undefined;
    _ended: () => boolean;
  };

  return { req, res };
}

// Faithful meilisearch-js 0.33 SDK transient error shapes (see
// client.ts isTransientMeiliError). Used for the defense-in-depth branch:
// a raw SDK error that escaped the getUsersWithSearch service wrap.
const makeCommunicationError = (statusCode: number) => {
  const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
    name: string;
    statusCode: number;
  };
  e.name = 'MeiliSearchCommunicationError';
  e.statusCode = statusCode;
  return e;
};

// The post-service-fix prod shape: getUsersWithSearch converts a transient Meili
// error to a TRPCError SERVICE_UNAVAILABLE, and the controller's throwDbError
// re-throws an existing TRPCError unchanged — so this is exactly what reaches
// the handler in production for a transient upstream.
const makeServiceUnavailableTrpcError = () =>
  new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'User search is temporarily overloaded — please retry.',
  });

// 4. Test Suite
describe('/api/v1/users transient-upstream 503 reclassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every request builds a caller whose user.getAll is our controllable mock.
    mockPublicApiContext2.mockResolvedValue({ user: { getAll: mockGetAll } });
  });

  it('happy path is unchanged (200) with no Retry-After header', async () => {
    const items = [{ id: 1, username: 'alice' }];
    mockGetAll.mockResolvedValue(items);
    const { req, res } = createMocks({ query: { query: 'ali' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ items });
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('maps a TRPCError SERVICE_UNAVAILABLE (the service-wrapped transient path) to a retryable 503', async () => {
    // This is the exact error shape the fixed getUsersWithSearch raises for a
    // transient Meili brownout, preserved unchanged through throwDbError. Against
    // the UNFIXED handler this hits `error instanceof TRPCError` → status 503 →
    // JSON.parse('User search is temporarily overloaded — please retry.') THROWS
    // → the throw escapes the catch → raw 500. The fix short-circuits to a clean
    // 503 before that JSON.parse landmine.
    mockGetAll.mockRejectedValue(makeServiceUnavailableTrpcError());
    const { req, res } = createMocks({ query: { query: 'bob' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toEqual({
      error: 'User search is temporarily overloaded — please retry.',
    });
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(res._getHeader('Retry-After')).toBe('2');
  });

  it.each([408, 429, 502, 503, 504])(
    'maps a raw SDK MeiliSearchCommunicationError(statusCode=%i) that escaped the service wrap to a retryable 503 (defense-in-depth)',
    async (status) => {
      mockGetAll.mockRejectedValue(makeCommunicationError(status));
      const { req, res } = createMocks({ query: { query: 'carol' } });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: 'User search is temporarily overloaded — please retry.',
      });
      expect(res._getHeader('Cache-Control')).toBe('no-store');
      expect(res._getHeader('Retry-After')).toBe('2');
    }
  );

  it('DOES map a transport-layer MeiliSearchCommunicationError(statusCode=500) (empty body) to a retryable 503', async () => {
    mockGetAll.mockRejectedValue(makeCommunicationError(500));
    const { req, res } = createMocks({ query: { query: 'dave' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getHeader('Retry-After')).toBe('2');
  });

  it('does NOT mask a genuine (non-transient) TRPCError NOT_FOUND as 503 — keeps its real 404, no Retry-After', async () => {
    // Message is JSON so the handler's existing JSON.parse(error.message) branch
    // resolves cleanly (that pre-existing branch is how this endpoint formats
    // real tRPC errors). The key assertions: NOT 503, no Retry-After.
    const notFound = new TRPCError({
      code: 'NOT_FOUND',
      message: JSON.stringify({ message: 'User not found' }),
    });
    mockGetAll.mockRejectedValue(notFound);
    const { req, res } = createMocks({ query: { query: 'eve' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('does NOT mask a generic app error (null deref) as 503 — bubbles to 500', async () => {
    // A non-transient, non-TRPCError failure must still surface as a hard 500 —
    // only transient search errors become 503.
    mockGetAll.mockRejectedValue(new Error('cannot read properties of undefined'));
    const { req, res } = createMocks({ query: { query: 'frank' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({
      message: 'An unexpected error occurred',
      error: 'cannot read properties of undefined',
    });
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('does NOT mask a non-transient upstream 400 (malformed filter) as 503', async () => {
    // A 4xx-other from the SDK (malformed filter / auth) is a real client/app
    // error, not a retryable brownout. It is not a TRPCError, so it falls to the
    // generic mapping → 500. The key assertion: it is NOT 503, no Retry-After.
    mockGetAll.mockRejectedValue(makeCommunicationError(400));
    const { req, res } = createMocks({ query: { query: 'grace' } });

    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });
});
