import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🔴 civitai#3983 — AN ABSENT STORE SCOPE MUST FAIL CLOSED AT EVERY BRANCH.
 *
 * ## What production did, and why nothing caught it
 *
 * On the serving build, `resolveStoreVisibilityScope` produced NO value for an
 * anonymous principal — recorded as `store_scope_resolutions_total{principal="anon",
 * scope="undefined"}` at the resolver and, independently, as
 * `store_scope_applied_total{entrypoint="rest-list"|"rest-detail", scope="absent"}`
 * at each REST branch. One missing value then hit two DISAGREEING defaults:
 *
 *   - `listAvailableListings` / `getListingDetail`: `opts.scope ?? 'full'`
 *       → the WHOLE approved catalog, on-site apps included, to an unauthenticated
 *         caller of the public REST endpoints;
 *   - the store tRPC procs: `_storeScope ?? 'none'`
 *       → an EMPTY store for the cohort that was supposed to see it.
 *
 * Both halves were invisible: an over-wide catalog looks like a working public API,
 * and an empty one looks like an empty catalog. The existing handler suite
 * (`apps.test.ts`) never exercised an absent scope — its resolver mock only ever
 * returned `full` or `none` — so 75 green store-scope tests coexisted with the bug
 * for its whole life.
 *
 * These tests drive the REAL handlers with the resolver returning exactly what
 * production returns, and assert the handler refuses. They are RED before the
 * `narrowStoreScope` hardening (the list handler serves the mocked catalog; the
 * detail handler serves the mocked listing) and green after.
 *
 * ## What this suite structurally CANNOT see
 *
 * - WHY the resolver yields no value in the production runtime. The resolver is
 *   MOCKED here precisely so the assertion is about the consumers' defaults, which
 *   is the half that decides whether a missing value widens access. The mechanism
 *   upstream is still open; see the issue.
 * - The compiled production artifact. This runs the TypeScript source under vitest,
 *   and the same source resolves `none` correctly here while production does not.
 * - The tRPC branch point (`applyStoreScope`) — covered by the router suites.
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
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ message: (e as Error)?.message ?? 'error' }),
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
vi.mock('~/server/utils/pagination-helpers', () => ({ getNextPage: mockGetNextPage }));
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: mockIsHostForColor }));

import listHandler from '~/pages/api/v1/apps/index';
import detailHandler from '~/pages/api/v1/apps/[slug]';

type Handler = (req: unknown, res: unknown, user: unknown) => Promise<unknown>;

function createMocks(query: Record<string, string> = {}) {
  const req = {
    method: 'GET',
    url: '/api/v1/apps',
    query,
    headers: { host: 'civitai.com' },
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  let statusCode = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
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
      headers[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

/** The listing service is mocked NON-EMPTY on purpose: if the handler ever calls it
 *  with an absent scope, the catalog appears in the response and the test fails
 *  loudly rather than passing on an incidentally-empty page. */
const CATALOG = [
  { id: 'apl_1', slug: 'onsite-app', kind: 'onsite', name: 'Onsite App' },
  { id: 'apl_2', slug: 'offsite-app', kind: 'offsite', name: 'Offsite App' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(false);
  mockIsHostForColor.mockReturnValue(false);
  mockGetNextPage.mockReturnValue({ nextPage: undefined });
  mockList.mockResolvedValue({ items: CATALOG, nextCursor: undefined });
  mockDetail.mockResolvedValue({ id: 'apl_1', serialId: 1, slug: 'onsite-app', kind: 'onsite' });
});

/** Every runtime shape a "no scope" can arrive as. `undefined` is the one production
 *  is recorded emitting; the others are the same class and must not be treated as an
 *  entitlement either. */
const ABSENT_SCOPES: [string, unknown][] = [
  ['undefined (the value production records for an anonymous principal)', undefined],
  ['null', null],
  ['a string outside the closed set', 'FULL'],
  ['an empty string', ''],
  ['a non-string', 0],
];

describe('GET /api/v1/apps — an absent scope must never widen the catalog (civitai#3983)', () => {
  it.each(ABSENT_SCOPES)(
    'resolver yields %s → empty page, and the listing service is NEVER reached',
    async (_label, scope) => {
      mockResolveScope.mockResolvedValue(scope);
      const { req, res } = createMocks();
      await (listHandler as unknown as Handler)(req, res, undefined);

      expect(res._status()).toBe(200);
      expect(res._json()).toEqual({
        items: [],
        metadata: { nextCursor: undefined, nextPage: undefined },
      });
      // The load-bearing half: the handler must short-circuit, not rely on the
      // service to refuse. Calling it at all is what let `?? 'full'` decide.
      expect(mockList).not.toHaveBeenCalled();
    }
  );

  // POSITIVE CONTROL — without it, "items: []" is indistinguishable from a handler
  // wired to nothing, and a mutation that closed EVERY scope would pass the block
  // above while silently taking the store dark for the people entitled to it.
  it('POSITIVE CONTROL: a resolved `full` still serves the catalog', async () => {
    mockResolveScope.mockResolvedValue('full');
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect((mockList.mock.calls[0][1] as { scope: string }).scope).toBe('full');
    expect((res._json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it('POSITIVE CONTROL: a resolved `public-external` is threaded through unchanged', async () => {
    mockResolveScope.mockResolvedValue('public-external');
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect((mockList.mock.calls[0][1] as { scope: string }).scope).toBe('public-external');
  });
});

describe('GET /api/v1/apps/{slug} — an absent scope must never disclose a listing (civitai#3983)', () => {
  it.each(ABSENT_SCOPES)(
    'resolver yields %s → 404, and the detail service is NEVER reached',
    async (_label, scope) => {
      mockResolveScope.mockResolvedValue(scope);
      const { req, res } = createMocks({ slug: 'onsite-app' });
      await (detailHandler as unknown as Handler)(req, res, undefined);

      expect(res._status()).toBe(404);
      expect((res._json() as { code: string }).code).toBe('NOT_FOUND');
      expect(mockDetail).not.toHaveBeenCalled();
    }
  );

  it('POSITIVE CONTROL: a resolved `full` still serves the detail', async () => {
    mockResolveScope.mockResolvedValue('full');
    const { req, res } = createMocks({ slug: 'onsite-app' });
    await (detailHandler as unknown as Handler)(req, res, undefined);

    expect(res._status()).toBe(200);
    expect(mockDetail).toHaveBeenCalledTimes(1);
    expect((mockDetail.mock.calls[0][1] as { scope: string }).scope).toBe('full');
  });
});
