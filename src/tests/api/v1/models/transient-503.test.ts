import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression test for the /api/v1/models raw-500 landmine (mirrors the
 * /api/v1/users #2972 test). The `?query=` path calls resolveModelSearchIds
 * (Meilisearch). A transient backend brownout — the SDK's own transient error
 * types (MeiliSearchCommunicationError 408/429/5xx, gateway 502/503/504, a
 * network drop) OR civitai's wrapped ModelSearchMeiliTimeoutError — MUST surface
 * as a retryable 503 (no-store + Retry-After), NOT a raw unhandled 500. A
 * non-transient error (malformed filter 400 / real app bug / NOT_FOUND) must NOT
 * be masked as 503 and must still surface as its real status.
 *
 * The resolveModelSearchIds try/catch sits BEFORE the handler's outer try, so a
 * rethrown non-transient error escapes the handler (→ the wrapper's real
 * status), which is why the non-transient cases below assert the handler REJECTS
 * and never wrote a 503.
 */

// The handler builds its response via resolveModelSearchIds (Meili pre-step) +
// runModelSearch (data/shaping). We mock BOTH but keep the REAL
// ModelSearchMeiliTimeoutError class so the handler's `instanceof` branch runs
// its production logic.
// Fully mock the service (its real module graph pulls image.service / Prisma,
// which we don't need and which won't load in the unit env — same reason the
// sibling index-refactor.test.ts mocks it). ModelSearchMeiliTimeoutError is a
// hoisted local class: the handler imports THIS class and does `instanceof`
// against it, and the test throws instances of THIS same class, so the branch
// matches. (Defined via vi.hoisted so the hoisted mock factory can reference it.)
const { mockResolveModelSearchIds, mockRunModelSearch, ModelSearchMeiliTimeoutError } = vi.hoisted(
  () => {
    class ModelSearchMeiliTimeoutError extends Error {
      constructor() {
        super('Model search is temporarily overloaded — please retry.');
        this.name = 'ModelSearchMeiliTimeoutError';
      }
    }
    return {
      mockResolveModelSearchIds: vi.fn(),
      mockRunModelSearch: vi.fn(),
      ModelSearchMeiliTimeoutError,
    };
  }
);

vi.mock('~/server/services/model-search.service', () => ({
  resolveModelSearchIds: mockResolveModelSearchIds,
  runModelSearch: mockRunModelSearch,
  ModelSearchMeiliTimeoutError,
}));

// Keep the REAL isTransientMeiliError so the handler's defense-in-depth branch
// runs its production classification. Only stubbing the connection surface.
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/meilisearch/client')>();
  return { ...actual };
});

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: vi.fn().mockReturnValue('US'),
  isRegionRestricted: vi.fn().mockReturnValue(false),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkCollections: vi.fn().mockResolvedValue([]),
}));

// MixedAuthEndpoint → anon passthrough; handleEndpointError → a recording
// passthrough (the sibling models tests mock it the same way). The outer-try
// path's status mapping is handleEndpointError's own (already guarded in
// #2976 and unchanged here) — this test asserts only that a non-transient
// error is NOT reclassified as 503 by the fix.
const handleEndpointErrorSpy = vi.fn((res: any, e: any) => {
  const status = e instanceof TRPCError && e.code === 'NOT_FOUND' ? 404 : 500;
  return res.status(status).json({ error: String(e?.message ?? e) });
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
  handleEndpointError: (res: any, e: any) => handleEndpointErrorSpy(res, e),
}));

// Faithful meilisearch-js 0.33 SDK transient error shape (see client.ts
// isTransientMeiliError): name + numeric statusCode.
const makeCommunicationError = (statusCode: number) => {
  const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
    name: string;
    statusCode: number;
  };
  e.name = 'MeiliSearchCommunicationError';
  e.statusCode = statusCode;
  return e;
};

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

beforeAll(async () => {
  const mod = await import('~/pages/api/v1/models/index');
  handler = mod.default as any;
}, 120000);

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headersSent: false,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    _getHeader: (k: string) => headers[k.toLowerCase()],
  };
  return res as NextApiResponse & {
    statusCode?: number;
    body?: any;
    ended?: boolean;
    _getHeader: (k: string) => string | undefined;
  };
}

async function invoke(query: Record<string, unknown>) {
  const req = {
    method: 'GET',
    query,
    headers: { host: 'civitai.com' },
    url: '/api/v1/models',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/models transient-upstream 503 reclassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [1], nextCursor: undefined });
  });

  it('happy path is unchanged (200) with no Retry-After header', async () => {
    const res = await invoke({ query: 'foo' });
    expect(res.statusCode).toBe(200);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('maps the wrapped ModelSearchMeiliTimeoutError (service transient path) to a retryable 503', async () => {
    mockResolveModelSearchIds.mockRejectedValue(new ModelSearchMeiliTimeoutError());
    const res = await invoke({ query: 'bar' });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Model search is temporarily overloaded — please retry.' });
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(res._getHeader('Retry-After')).toBe('2');
    expect(handleEndpointErrorSpy).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'maps a raw SDK MeiliSearchCommunicationError(statusCode=%i) that escaped the service wrap to a retryable 503 (defense-in-depth)',
    async (status) => {
      mockResolveModelSearchIds.mockRejectedValue(makeCommunicationError(status));
      const res = await invoke({ query: 'carol' });

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        error: 'Model search is temporarily overloaded — please retry.',
      });
      expect(res._getHeader('Cache-Control')).toBe('no-store');
      expect(res._getHeader('Retry-After')).toBe('2');
    }
  );

  it('does NOT mask a non-transient SDK 400 (malformed filter) as 503 — rethrows, no 503 written', async () => {
    mockResolveModelSearchIds.mockRejectedValue(makeCommunicationError(400));
    const res = fakeRes();
    const req = {
      method: 'GET',
      query: { query: 'grace' },
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
    } as unknown as NextApiRequest;

    await expect(handler(req, res)).rejects.toBeTruthy();
    expect(res.statusCode).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('does NOT mask a generic app error (null deref) as 503 — rethrows, no 503 written', async () => {
    mockResolveModelSearchIds.mockRejectedValue(new Error('cannot read properties of undefined'));
    const res = fakeRes();
    const req = {
      method: 'GET',
      query: { query: 'frank' },
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
    } as unknown as NextApiRequest;

    await expect(handler(req, res)).rejects.toThrow('cannot read properties of undefined');
    expect(res.statusCode).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('does NOT mask a genuine (non-transient) TRPCError NOT_FOUND as 503 — rethrows, no 503 written', async () => {
    mockResolveModelSearchIds.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'nope' })
    );
    const res = fakeRes();
    const req = {
      method: 'GET',
      query: { query: 'eve' },
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
    } as unknown as NextApiRequest;

    await expect(handler(req, res)).rejects.toBeTruthy();
    expect(res.statusCode).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('a non-transient failure on the NON-query (runModelSearch) path goes through handleEndpointError, never 503', async () => {
    // No `query` → no Meili pre-step; the failure is in runModelSearch, inside
    // the outer try → handleEndpointError. The fix must not touch this path.
    mockRunModelSearch.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'model gone' })
    );
    const res = await invoke({});

    expect(handleEndpointErrorSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });
});
