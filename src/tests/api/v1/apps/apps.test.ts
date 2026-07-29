import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Handler-level coverage for the PUBLIC app-catalog REST endpoints:
 *   - GET /api/v1/apps          (list + filter, keyset paginated)
 *   - GET /api/v1/apps/{slug}   (single detail)
 *
 * The security crux is the DEFAULT-CLOSED per-user scope gate: an anonymous /
 * non-privileged caller resolves scope `none` and MUST receive the empty page /
 * 404 — NEVER the full catalog — even though the underlying listing service
 * defaults to `full`. The load-bearing guards (`does NOT leak the catalog to
 * anon`) mock the service to return NON-empty data and assert the handler still
 * returns nothing for an unscoped caller, so deleting the scope wiring fails the
 * test.
 */

const {
  mockResolveScope,
  mockList,
  mockDetail,
  mockRateLimit,
  mockGetNextPage,
  mockIsHostForColor,
} = vi.hoisted(() => ({
  mockResolveScope: vi.fn(),
  mockList: vi.fn(),
  mockDetail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetNextPage: vi.fn(),
  mockIsHostForColor: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: unknown) => handler,
  handleEndpointError: (res: { status: (n: number) => { json: (b: unknown) => unknown } }, e: unknown) =>
    res.status(500).json({ message: (e as Error)?.message ?? 'error' }),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mockResolveScope,
}));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: mockList,
  getListingDetail: mockDetail,
}));
vi.mock('~/server/utils/apps-catalog-rate-limit', () => ({
  enforceAppsCatalogRateLimit: mockRateLimit,
}));
vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: mockGetNextPage,
}));
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: mockIsHostForColor,
}));

import listHandler from '~/pages/api/v1/apps/index';
import detailHandler from '~/pages/api/v1/apps/[slug]';

type Handler = (req: unknown, res: unknown, user: unknown) => Promise<unknown>;

function createMocks({
  query = {},
  headers = {},
}: { query?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const req = {
    method: 'GET',
    url: '/api/v1/apps',
    query,
    headers,
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  let statusCode = 200;
  let payload: unknown;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      responseHeaders[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
    _headers: () => responseHeaders,
  };
  return { req, res };
}

const MOD = { id: 7, isModerator: true };
const NORMAL = { id: 8, isModerator: false };

function card(slug: string) {
  return { id: `al_${slug}`, slug, kind: 'onsite', name: slug, category: 'utility' };
}
function detail(slug: string) {
  return { id: `al_${slug}`, serialId: 1, slug, kind: 'onsite', name: slug, screenshots: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(false); // not rate-limited by default
  mockIsHostForColor.mockReturnValue(false); // non-red host by default
  mockGetNextPage.mockImplementation(({ nextCursor }: { nextCursor?: string }) => ({
    baseUrl: new URL('http://localhost/api/v1/apps'),
    nextPage: nextCursor ? `http://localhost/api/v1/apps?cursor=${nextCursor}` : undefined,
  }));
  // Default identity scope: mods → full, everyone else → none (the pre-launch default).
  mockResolveScope.mockImplementation(async ({ user }: { user?: { isModerator?: boolean } }) =>
    user?.isModerator ? 'full' : 'none'
  );
  mockList.mockResolvedValue({ items: [card('a'), card('b')], nextCursor: undefined });
  mockDetail.mockResolvedValue(detail('a'));
});

describe('GET /api/v1/apps (list)', () => {
  it('SECURITY: anonymous caller gets the CLOSED scope — empty page, NOT the full catalog', async () => {
    // The service is mocked to ALWAYS return items; the handler must still return
    // empty for an unscoped (anon) caller. This fails if the scope gate is removed.
    mockList.mockResolvedValue({ items: [card('leak-a'), card('leak-b')], nextCursor: 'x' });
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    expect((res._json() as { items: unknown[] }).items).toEqual([]);
    // The catalog service is never consulted for a `none` scope.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('SECURITY: a normal (non-privileged) authed user also gets the closed scope', async () => {
    mockList.mockResolvedValue({ items: [card('leak')], nextCursor: undefined });
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, NORMAL);
    expect((res._json() as { items: unknown[] }).items).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a mod (full scope) gets the catalog — service called WITH the resolved scope', async () => {
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(200);
    const body = res._json() as { items: unknown[]; metadata: { nextCursor?: string } };
    expect(body.items).toHaveLength(2);
    // The scope is threaded EXPLICITLY into the service (guards against a caller
    // falling through to the service default of `full`).
    expect(mockList).toHaveBeenCalledTimes(1);
    const [, opts] = mockList.mock.calls[0];
    expect(opts).toMatchObject({ scope: 'full' });
  });

  it('serves the public-external scope (offsite-only) to a widened caller', async () => {
    mockResolveScope.mockResolvedValueOnce('public-external');
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    const [, opts] = mockList.mock.calls[0];
    expect(opts).toMatchObject({ scope: 'public-external' });
  });

  it('passes every filter param through to the service, coercing limit to a number', async () => {
    const { req, res } = createMocks({
      query: { kind: 'offsite', category: 'utility', sort: 'newest', cursor: 'c1', limit: '5' },
    });
    await (listHandler as unknown as Handler)(req, res, MOD);
    const [input] = mockList.mock.calls[0];
    expect(input).toEqual({
      kind: 'offsite',
      category: 'utility',
      sort: 'newest',
      cursor: 'c1',
      limit: 5,
    });
  });

  it('applies schema defaults when no filters are supplied', async () => {
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, MOD);
    const [input] = mockList.mock.calls[0];
    expect(input).toEqual({ kind: 'all', sort: 'top-rated', limit: 20 });
  });

  it('cursor pagination round-trips: nextCursor surfaces in metadata + nextPage', async () => {
    mockList.mockResolvedValueOnce({ items: [card('a')], nextCursor: 'c2' });
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, MOD);
    const md = (res._json() as { metadata: { nextCursor?: string; nextPage?: string } }).metadata;
    expect(md.nextCursor).toBe('c2');
    expect(md.nextPage).toContain('cursor=c2');

    // Page 2: a cursor in, no cursor out → terminal page.
    mockList.mockResolvedValueOnce({ items: [card('c')], nextCursor: undefined });
    const { req: req2, res: res2 } = createMocks({ query: { cursor: 'c2' } });
    await (listHandler as unknown as Handler)(req2, res2, MOD);
    const md2 = (res2._json() as { metadata: { nextCursor?: string } }).metadata;
    expect(md2.nextCursor).toBeUndefined();
    expect(mockList.mock.calls[1][0]).toMatchObject({ cursor: 'c2' });
  });

  it('threads redCapable from a red-capable host into the service', async () => {
    mockIsHostForColor.mockReturnValue(true);
    const { req, res } = createMocks({ headers: { host: 'civitai.red' } });
    await (listHandler as unknown as Handler)(req, res, MOD);
    const [, opts] = mockList.mock.calls[0];
    expect(opts).toMatchObject({ redCapable: true });
  });

  it('invalid/expired token → treated as anonymous (no 500): user undefined → empty page', async () => {
    // MixedAuthEndpoint resolves an invalid bearer to `undefined`; the handler
    // must treat that as anon (empty), never crash.
    const { req, res } = createMocks({ headers: { authorization: 'Bearer garbage' } });
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    expect((res._json() as { items: unknown[] }).items).toEqual([]);
  });

  it('400 on an out-of-range limit', async () => {
    const { req, res } = createMocks({ query: { limit: '0' } });
    await (listHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();

    const { req: r2, res: res2 } = createMocks({ query: { limit: '51' } });
    await (listHandler as unknown as Handler)(r2, res2, MOD);
    expect(res2._status()).toBe(400);
  });

  it('429 when rate-limited: the limiter short-circuits before any scope/service work', async () => {
    mockRateLimit.mockImplementationOnce(async ({ res }: { res: { status: (n: number) => { json: (b: unknown) => unknown } } }) => {
      res.status(429).json({ message: 'Rate limit exceeded' });
      return true;
    });
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(429);
    expect(mockResolveScope).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('maps a service throw to a 500 via handleEndpointError (not an unhandled crash)', async () => {
    mockList.mockRejectedValueOnce(new Error('db exploded'));
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(500);
  });
});

describe('GET /api/v1/apps/{slug} (detail)', () => {
  it('SECURITY: an out-of-scope (anon) caller gets 404, and the service is never called', async () => {
    // Service mocked to return a real listing; the scope gate must still 404.
    mockDetail.mockResolvedValue(detail('secret-app'));
    const { req, res } = createMocks({ query: { slug: 'secret-app' } });
    await (detailHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(404);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it('found in scope → 200 with the detail + manifest-derived fields', async () => {
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(200);
    expect((res._json() as { slug: string }).slug).toBe('a');
    // Scope threaded explicitly into the service, keyed by slug.
    expect(mockDetail).toHaveBeenCalledWith(
      { slug: 'my-app' },
      expect.objectContaining({ scope: 'full' })
    );
  });

  it('absent listing (service returns null) → 404', async () => {
    mockDetail.mockResolvedValueOnce(null);
    const { req, res } = createMocks({ query: { slug: 'ghost' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(404);
  });

  it('400 on a missing/empty slug', async () => {
    const { req, res } = createMocks({ query: {} });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(400);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it('invalid/expired token → anonymous → 404 (not a 500)', async () => {
    const { req, res } = createMocks({ query: { slug: 'my-app' }, headers: { authorization: 'Bearer garbage' } });
    await (detailHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(404);
  });

  it('429 when rate-limited: short-circuits before scope/service', async () => {
    mockRateLimit.mockImplementationOnce(async ({ res }: { res: { status: (n: number) => { json: (b: unknown) => unknown } } }) => {
      res.status(429).json({ message: 'Rate limit exceeded' });
      return true;
    });
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(429);
    expect(mockDetail).not.toHaveBeenCalled();
  });
});
