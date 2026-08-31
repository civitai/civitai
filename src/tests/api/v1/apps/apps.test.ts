import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Handler-level coverage for the PUBLIC app-catalog REST endpoints:
 *   - GET /api/v1/apps          (list + filter, keyset paginated)
 *   - GET /api/v1/apps/{slug}   (single detail)
 *
 * These endpoints are a PUBLIC catalog by decision: a caller who resolves no scope
 * of their own — anonymous or merely non-privileged — is served the catalog under
 * the deliberate grant in `~/server/services/blocks/public-apps-catalog`, and an
 * operator kill switch is the one thing that takes it away. A caller who DOES
 * resolve a scope (`full` for a mod / app-dev-tester, `public-external` for the
 * external-only cohort) keeps it verbatim, and the scope is threaded EXPLICITLY
 * into the listing service on every path — the guards below mock the service to
 * return NON-empty data so a handler that stopped threading the scope, or stopped
 * honouring the kill switch, fails rather than passing on an incidentally-empty
 * page.
 *
 * 🔴 WHAT THIS SUITE STRUCTURALLY CANNOT SEE — twice over:
 *   - its resolver mock returns only `full`, `public-external` or `none`, so the
 *     case production actually hit (civitai#3983: the resolver returning NOTHING)
 *     is not exercised here at all. Those cases live in
 *     `apps.absent-scope-fail-closed.test.ts`; keep them there rather than assuming
 *     this suite covers them.
 *   - every scope, flag and service answer here is a MOCK, so nothing in this file
 *     can attest that the live endpoint serves anything. It pins what the handler
 *     does with an answer, never what the answer is in production.
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
vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: mockGetNextPage,
}));
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: mockIsHostForColor,
}));
// The public-catalog KILL SWITCH is a Flipt flag, so the flag client is the seam.
// Spread the real module (rather than replacing it) so this stays honest if the
// decision module ever reads another export from it.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));

import type * as FliptClient from '~/server/flipt/client';
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
  // Default identity scope: mods → full, everyone else → none (they then meet the
  // public-catalog grant, which is what makes these endpoints public).
  mockResolveScope.mockImplementation(async ({ user }: { user?: { isModerator?: boolean } }) =>
    user?.isModerator ? 'full' : 'none'
  );
  // The kill switch is a DISABLE flag: `false` is its absent/dark state and means
  // the public catalog is OPEN. This mirrors what `isFlipt` returns for a flag that
  // does not exist — which is the as-merged production configuration.
  mockIsFlipt.mockResolvedValue(false);
  mockList.mockResolvedValue({ items: [card('a'), card('b')], nextCursor: undefined });
  mockDetail.mockResolvedValue(detail('a'));
});

describe('GET /api/v1/apps (list)', () => {
  // 🔴 PUBLIC BY DECISION. An anonymous caller resolves `none` of their own and is
  // then served the catalog by the deliberate grant. This is the assertion that
  // fails if someone removes the grant, so the endpoint cannot silently go dark
  // again — which is exactly what merging the #4041 hardening alone would have done
  // to a live public URL.
  it('PUBLIC GRANT: an anonymous caller is served the catalog, under an explicit `full` scope', async () => {
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    expect((res._json() as { items: unknown[] }).items).toHaveLength(2);
    // Threaded EXPLICITLY — never left to a service-side default (civitai#3983).
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList.mock.calls[0][1]).toMatchObject({ scope: 'full' });
  });

  it('PUBLIC GRANT: a normal (non-privileged) authed user is served the same public catalog', async () => {
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, NORMAL);
    expect(res._status()).toBe(200);
    expect((res._json() as { items: unknown[] }).items).toHaveLength(2);
    expect(mockList.mock.calls[0][1]).toMatchObject({ scope: 'full' });
  });

  // The KILL SWITCH, asserted as a DISCRIMINATION rather than as one state: both
  // arms run in one test against one mocked catalog, so a handler that ignores the
  // switch fails the OFF→ON arm and a handler that serves nothing fails the ON→OFF
  // arm. Asserting only the "switch on → empty" half would pass on a handler that
  // is simply dark, which is the regression this whole change exists to prevent.
  it('KILL SWITCH discriminates: OFF → the catalog; ON → an empty page and the service is never reached', async () => {
    mockList.mockResolvedValue({ items: [card('a'), card('b')], nextCursor: 'x' });

    mockIsFlipt.mockResolvedValue(false);
    const open = createMocks();
    await (listHandler as unknown as Handler)(open.req, open.res, undefined);
    expect((open.res._json() as { items: unknown[] }).items).toHaveLength(2);

    mockIsFlipt.mockResolvedValue(true);
    const shut = createMocks();
    await (listHandler as unknown as Handler)(shut.req, shut.res, undefined);
    expect(shut.res._status()).toBe(200);
    expect((shut.res._json() as { items: unknown[] }).items).toEqual([]);
    // Withheld means SHORT-CIRCUITED, not "the service returned nothing".
    expect(mockList).toHaveBeenCalledTimes(1);
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

  // 🔴 civitai#4048: the external-only cohort is BELOW the public floor, so while the
  // grant is active they are LIFTED to it rather than held at `public-external`.
  // Before the fix they short-circuited past the grant, which meant signing in
  // REDUCED what this public endpoint returned (measured live: 4 items vs 14).
  it('lifts a `public-external` caller to the public floor while the grant is active', async () => {
    mockResolveScope.mockResolvedValueOnce('public-external');
    const { req, res } = createMocks();
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    const [, opts] = mockList.mock.calls[0];
    expect(opts).toMatchObject({ scope: 'full' });
  });

  // …and the other half of the same invariant: the kill switch withdraws the public
  // FLOOR, it does not revoke what the caller resolved for themselves. A handler that
  // narrowed this caller to `none` would 200-with-an-empty-page a cohort member who is
  // entitled to the offsite catalog.
  it('serves the public-external scope (offsite-only) when the grant is WITHHELD', async () => {
    mockResolveScope.mockResolvedValueOnce('public-external');
    mockIsFlipt.mockResolvedValue(true);
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

  it('invalid/expired token → treated as anonymous (no 500): the public catalog, never a crash', async () => {
    // MixedAuthEndpoint resolves an invalid bearer to `undefined`; the handler must
    // treat that as anon — i.e. the public grant applies — never as an error.
    const { req, res } = createMocks({ headers: { authorization: 'Bearer garbage' } });
    await (listHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    expect((res._json() as { items: unknown[] }).items).toHaveLength(2);
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
    mockRateLimit.mockImplementationOnce(
      async ({ res }: { res: { status: (n: number) => { json: (b: unknown) => unknown } } }) => {
        res.status(429).json({ message: 'Rate limit exceeded' });
        return true;
      }
    );
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
  // 🔴 PUBLIC BY DECISION — the detail sibling of the list guard above. Fails if the
  // grant is removed, so `/api/v1/apps/{slug}` cannot silently start 404ing.
  it('PUBLIC GRANT: an anonymous caller is served the detail, under an explicit `full` scope', async () => {
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith(
      { slug: 'my-app' },
      expect.objectContaining({ scope: 'full' })
    );
  });

  it('KILL SWITCH discriminates: OFF → 200 with the detail; ON → 404 and the service is never reached', async () => {
    mockDetail.mockResolvedValue(detail('secret-app'));

    mockIsFlipt.mockResolvedValue(false);
    const open = createMocks({ query: { slug: 'secret-app' } });
    await (detailHandler as unknown as Handler)(open.req, open.res, undefined);
    expect(open.res._status()).toBe(200);

    mockIsFlipt.mockResolvedValue(true);
    const shut = createMocks({ query: { slug: 'secret-app' } });
    await (detailHandler as unknown as Handler)(shut.req, shut.res, undefined);
    expect(shut.res._status()).toBe(404);
    expect(mockDetail).toHaveBeenCalledTimes(1);
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

  it('invalid/expired token → anonymous → served under the public grant (not a 500)', async () => {
    const { req, res } = createMocks({
      query: { slug: 'my-app' },
      headers: { authorization: 'Bearer garbage' },
    });
    await (detailHandler as unknown as Handler)(req, res, undefined);
    expect(res._status()).toBe(200);
  });

  it('429 when rate-limited: short-circuits before scope/service', async () => {
    mockRateLimit.mockImplementationOnce(
      async ({ res }: { res: { status: (n: number) => { json: (b: unknown) => unknown } } }) => {
        res.status(429).json({ message: 'Rate limit exceeded' });
        return true;
      }
    );
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(429);
    expect(mockDetail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REST parity — `sourceRepoUrl` on GET /api/v1/apps/{slug}
// ---------------------------------------------------------------------------

describe('GET /api/v1/apps/{slug} — sourceRepoUrl parity', () => {
  /**
   * 🔴 WHAT THIS PATH CANNOT DO FOR US, and why it is worth saying: this endpoint has
   * NO tRPC transformer, so whatever the service returns is `JSON.stringify`d straight
   * onto the wire. A `Date` or a class instance would serialise differently here than
   * over tRPC. `sourceRepoUrl` is a plain `string | null`, and these cases pin that the
   * handler passes it through UNCHANGED rather than reshaping or dropping it.
   *
   * The DTO's own JSON-safety (and the card/detail asymmetry) is asserted against the
   * REAL projection in `app-listing.service.test.ts` — this suite's service is a mock,
   * so it can only ever pin what the HANDLER does with an answer.
   */
  it('emits the field verbatim as a JSON-safe scalar', async () => {
    const REPO = 'https://github.com/civitai/cool-app';
    mockDetail.mockResolvedValueOnce({ ...detail('my-app'), sourceRepoUrl: REPO });
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);

    expect(res._status()).toBe(200);
    // Round-tripped, not merely read off the object the handler was handed.
    const wire = JSON.parse(JSON.stringify(res._json())) as Record<string, unknown>;
    expect(wire.sourceRepoUrl).toBe(REPO);
    expect(typeof wire.sourceRepoUrl).toBe('string');
  });

  it('emits an explicit null (never drops the key) for a listing with no source repo', async () => {
    // A client must not have to distinguish "absent" from "null"; the field is declared
    // non-optional on `ListingDetail`.
    mockDetail.mockResolvedValueOnce({ ...detail('my-app'), sourceRepoUrl: null });
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);

    expect(res._status()).toBe(200);
    const wire = JSON.parse(JSON.stringify(res._json())) as Record<string, unknown>;
    expect('sourceRepoUrl' in wire).toBe(true);
    expect(wire.sourceRepoUrl).toBeNull();
  });

  it('the 404 posture is UNCHANGED — a missing app still yields the error envelope, no field', async () => {
    mockDetail.mockResolvedValueOnce(null);
    const { req, res } = createMocks({ query: { slug: 'nope' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);

    expect(res._status()).toBe(404);
    const body = res._json() as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
    expect(body).not.toHaveProperty('sourceRepoUrl');
  });
});
