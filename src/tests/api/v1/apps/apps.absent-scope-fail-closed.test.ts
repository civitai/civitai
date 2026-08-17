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
 * ## 🔴 WHAT "FAIL CLOSED" MEANS AT A PUBLIC ENDPOINT — read before editing
 *
 * These two REST endpoints are a PUBLIC catalog by decision (see
 * `~/server/services/blocks/public-apps-catalog`): a caller who resolves no scope
 * of their own is served the catalog on purpose. So the invariant here is NOT "an
 * absent scope yields nothing" — at this surface, a resolved `none` does not yield
 * nothing either. The invariant is the one #3983 actually violated:
 *
 *   🔴 AN ABSENT SCOPE MUST NEVER BUY MORE THAN A CORRECTLY-RESOLVED `none`.
 *
 * That is what was broken: absent → `full` while resolved-`none` → empty, from the
 * same request, differing only in whether the resolver worked. It is pinned below as
 * an EQUIVALENCE (identical response and identical service call for both), plus the
 * withheld configuration (kill switch on), where both must produce nothing at all.
 * The absent value never gets its own branch, so there is nothing for it to widen.
 *
 * Everywhere OUTSIDE these two handlers the stronger rule still holds verbatim and
 * is pinned by its own suites: `narrowStoreScope` (`shared/utils/__tests__/`), the
 * listing service's `none`-means-FALSE predicate (`app-listing.public-scope.test.ts`)
 * and the tRPC branch point. None of them is touched by the public grant.
 *
 * ## What this suite structurally CANNOT see
 *
 * - WHY the resolver yields no value in the production runtime. The resolver is
 *   MOCKED here precisely so the assertion is about the consumers' defaults, which
 *   is the half that decides whether a missing value widens access. The mechanism
 *   upstream is still open; see the issue.
 * - The compiled production artifact. This runs the TypeScript source under vitest,
 *   and the same source resolves `none` correctly here while production does not.
 *   Nothing in this file is evidence about what the live endpoint serves.
 * - The tRPC branch point (`applyStoreScope`) — covered by the router suites.
 */

const {
  mockResolveScope,
  mockList,
  mockDetail,
  mockRateLimit,
  mockGetNextPage,
  mockIsHostForColor,
  mockIsFlipt,
} = vi.hoisted(() => ({
  mockResolveScope: vi.fn(),
  mockList: vi.fn(),
  mockDetail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetNextPage: vi.fn(),
  mockIsHostForColor: vi.fn(),
  mockIsFlipt: vi.fn(),
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
// The public-catalog kill switch is a Flipt flag; spread the real module so this
// mock does not go silently stale if the decision reads another export.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFlipt: mockIsFlipt,
}));

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
  // Kill switch OFF — its absent/dark state, and the as-merged production config.
  mockIsFlipt.mockResolvedValue(false);
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

/** Drive the LIST handler once for a given resolver answer; return what came out. */
async function callList(scope: unknown) {
  mockResolveScope.mockResolvedValue(scope);
  const { req, res } = createMocks();
  await (listHandler as unknown as Handler)(req, res, undefined);
  return {
    status: res._status(),
    body: res._json(),
    serviceCalls: mockList.mock.calls.map((c) => c[1]),
  };
}

/** Drive the DETAIL handler once for a given resolver answer. */
async function callDetail(scope: unknown) {
  mockResolveScope.mockResolvedValue(scope);
  const { req, res } = createMocks({ slug: 'onsite-app' });
  await (detailHandler as unknown as Handler)(req, res, undefined);
  return {
    status: res._status(),
    body: res._json(),
    serviceCalls: mockDetail.mock.calls.map((c) => c[1]),
  };
}

describe('GET /api/v1/apps — an absent scope must never buy more than a resolved `none` (civitai#3983)', () => {
  it.each(ABSENT_SCOPES)(
    'resolver yields %s → EXACTLY what a resolved `none` yields (response AND service call)',
    async (_label, scope) => {
      const absent = await callList(scope);
      vi.clearAllMocks();
      mockRateLimit.mockResolvedValue(false);
      mockIsHostForColor.mockReturnValue(false);
      mockGetNextPage.mockReturnValue({ nextPage: undefined });
      mockList.mockResolvedValue({ items: CATALOG, nextCursor: undefined });
      mockIsFlipt.mockResolvedValue(false);
      const none = await callList('none');

      // The whole of #3983 in one assertion: these two differ only in whether the
      // resolver produced a value, and they must be indistinguishable downstream.
      expect(absent.status).toEqual(none.status);
      expect(absent.body).toEqual(none.body);
      expect(absent.serviceCalls).toEqual(none.serviceCalls);
    }
  );

  it.each(ABSENT_SCOPES)(
    'KILL SWITCH ON — resolver yields %s → empty page, and the listing service is NEVER reached',
    async (_label, scope) => {
      mockIsFlipt.mockResolvedValue(true);
      const res = await callList(scope);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [],
        metadata: { nextCursor: undefined, nextPage: undefined },
      });
      // The load-bearing half: the handler must short-circuit, not rely on the
      // service to refuse. Calling it at all is what let `?? 'full'` decide.
      expect(res.serviceCalls).toEqual([]);
    }
  );

  // POSITIVE CONTROL — without it, "items: []" above is indistinguishable from a
  // handler wired to nothing, and a mutation that closed EVERY scope would pass the
  // block above while silently taking the catalog dark for everyone.
  it('POSITIVE CONTROL: with the switch ON, a resolved `full` is STILL served (privileged callers are untouched)', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const res = await callList('full');

    expect(res.serviceCalls).toEqual([expect.objectContaining({ scope: 'full' })]);
    expect((res.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('POSITIVE CONTROL: a resolved `public-external` is threaded through unchanged', async () => {
    const res = await callList('public-external');
    expect(res.serviceCalls).toEqual([expect.objectContaining({ scope: 'public-external' })]);
  });

  // The PUBLIC half, and the reason this endpoint may merge: while the resolver
  // defect persists in production, an absent scope must still leave the public
  // catalog SERVED rather than empty. Red before the public-catalog grant.
  it('the public grant applies to an absent scope too — the endpoint does NOT go dark on a resolver failure', async () => {
    const res = await callList(undefined);
    expect(res.serviceCalls).toEqual([expect.objectContaining({ scope: 'full' })]);
    expect((res.body as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('GET /api/v1/apps/{slug} — an absent scope must never buy more than a resolved `none` (civitai#3983)', () => {
  it.each(ABSENT_SCOPES)(
    'resolver yields %s → EXACTLY what a resolved `none` yields (response AND service call)',
    async (_label, scope) => {
      const absent = await callDetail(scope);
      vi.clearAllMocks();
      mockRateLimit.mockResolvedValue(false);
      mockIsHostForColor.mockReturnValue(false);
      mockDetail.mockResolvedValue({
        id: 'apl_1',
        serialId: 1,
        slug: 'onsite-app',
        kind: 'onsite',
      });
      mockIsFlipt.mockResolvedValue(false);
      const none = await callDetail('none');

      expect(absent.status).toEqual(none.status);
      expect(absent.body).toEqual(none.body);
      expect(absent.serviceCalls).toEqual(none.serviceCalls);
    }
  );

  it.each(ABSENT_SCOPES)(
    'KILL SWITCH ON — resolver yields %s → 404, and the detail service is NEVER reached',
    async (_label, scope) => {
      mockIsFlipt.mockResolvedValue(true);
      const res = await callDetail(scope);

      expect(res.status).toBe(404);
      expect((res.body as { code: string }).code).toBe('NOT_FOUND');
      expect(res.serviceCalls).toEqual([]);
    }
  );

  it('POSITIVE CONTROL: with the switch ON, a resolved `full` still serves the detail', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const res = await callDetail('full');

    expect(res.status).toBe(200);
    expect(res.serviceCalls).toEqual([expect.objectContaining({ scope: 'full' })]);
  });

  it('the public grant applies to an absent scope too — the detail endpoint does NOT start 404ing on a resolver failure', async () => {
    const res = await callDetail(undefined);
    expect(res.status).toBe(200);
    expect(res.serviceCalls).toEqual([expect.objectContaining({ scope: 'full' })]);
  });
});
