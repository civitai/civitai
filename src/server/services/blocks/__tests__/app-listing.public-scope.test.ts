import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * External-before-onsite GA (Phase 1) — the STORE-SCOPE kind gate on the
 * AppListing-backed unified store read path (`app-listing.service`).
 *
 *   - listingPublicVisibilityFilter — the pure SQL drift-guard: `full` → TRUE,
 *     `public-external` → `al.kind = 'offsite'` (BOTH sub-kinds), `none` → FALSE.
 *   - listAvailableListings — under `public-external` the keyset WHERE carries the
 *     offsite-only predicate; under `full` it carries TRUE (unchanged).
 *   - getListingDetail — under `public-external` an ONSITE listing is treated as
 *     MISSING (null), while an OFFSITE listing (either sub-kind, incl. a `connect`
 *     listing with a `connectClientId`) is shown; `full` imposes no kind gate.
 *
 * No DB in unit tests: mock `dbRead.$queryRaw` (keyset id page — capture the SQL) +
 * `dbRead.appListing.findFirst/findMany` (hydration — return seeded rows).
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    // App Listing COLLABORATORS: `getAppListingDetail` now hydrates the PUBLIC BYLINE
    // (accepted + displayed collaborators) alongside the listing. Both reads go through
    // `safeCollaboratorQuery`, which swallows ONLY the missing-TABLE error — so an
    // absent mock surfaces as a TypeError instead of being silently absorbed. Empty
    // here: these suites assert the pre-collaborator projection, which must be
    // byte-identical when an app has no seats.
    appCollaborator: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // The MANUAL-APPLY `source_repo_url` column is read through its OWN guarded
      // `findUnique` (app-listing-source-repo.service) — never via
      // `listingHydrateSelect`, which the public /apps GRID shares. Mocked here so the
      // seam is exercised; `null` = "no source repo set", the default for these rows.
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ sourceRepoUrl: null })),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
}));

import {
  getListingDetail,
  listAvailableListings,
  listingPublicVisibilityFilter,
} from '../app-listing.service';

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg). */
function capturedSql(): string {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { sql?: unknown } | undefined;
  return first && typeof first.sql === 'string' ? first.sql : '';
}

/**
 * The captured SQL with `--` comments stripped.
 *
 * 🔴 Necessary, not cosmetic: the query's own comment reads "full scope emits TRUE
 * (unchanged)", so a bare `/\bTRUE\b/` over the raw text matches the PROSE and reports
 * a fail-open predicate on a query whose predicate is `FALSE`. An assertion that can be
 * satisfied by a comment is not an assertion about the SQL.
 */
function capturedPredicateSql(): string {
  return capturedSql().replace(/--[^\n]*/g, '');
}

/** A hydrated ONSITE listing row (as `listingHydrateSelect` returns). */
function onsiteRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_1',
    kind: 'onsite',
    slug: 'cool-app',
    name: 'Cool App',
    tagline: 't',
    description: 'body',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: null,
    connectClientId: null,
    appBlockId: 'ab_1',
    icon: null,
    cover: null,
    user: { id: 7, username: 'dev', image: null },
    metric: null,
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    appBlock: {
      currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
      manifest: { name: 'Cool App', page: { path: '/run' } },
    },
    screenshots: [],
    ...over,
  };
}

/** A hydrated OFFSITE external-link listing row — NO backing AppBlock. */
function offsiteExternalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_2',
    kind: 'offsite',
    slug: 'ext-app',
    name: 'Ext App',
    tagline: 't',
    description: 'body',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: 'https://example.com/ext',
    connectClientId: null,
    appBlockId: null,
    icon: null,
    cover: null,
    user: { id: 7, username: 'dev', image: null },
    metric: null,
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    appBlock: null,
    screenshots: [],
    ...over,
  };
}

/** A hydrated OFFSITE CONNECT listing row (links an OAuth client) — still offsite. */
function offsiteConnectRow(over: Record<string, unknown> = {}) {
  return offsiteExternalRow({
    id: 'apl_3',
    slug: 'connect-app',
    name: 'Connect App',
    externalUrl: null,
    connectClientId: 'oauthclient_abc',
    ...over,
  });
}

describe('listingPublicVisibilityFilter — SQL drift-guard', () => {
  it('full → TRUE (no kind restriction, byte-identical to today)', () => {
    expect(listingPublicVisibilityFilter('full').sql).toBe('TRUE');
  });

  it("public-external → al.kind = 'offsite' (both sub-kinds; NOT gated on connect_client_id)", () => {
    const sql = listingPublicVisibilityFilter('public-external').sql;
    expect(sql).toBe("al.kind = 'offsite'");
    // 🔴 the merged model: the gate is kind='offsite', NEVER connect_client_id.
    expect(sql).not.toMatch(/connect_client_id/i);
  });

  it('none → FALSE (fail-closed defense-in-depth)', () => {
    expect(listingPublicVisibilityFilter('none').sql).toBe('FALSE');
  });
});

describe('listAvailableListings — STORE-SCOPE kind gate in the keyset WHERE', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.appListing.findMany.mockReset();
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it("public-external → WHERE carries al.kind = 'offsite'", async () => {
    await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 20 },
      { scope: 'public-external' }
    );
    expect(capturedSql()).toMatch(/al\.kind = 'offsite'/i);
  });

  it('full → WHERE carries the TRUE predicate (no offsite narrowing)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { scope: 'full' });
    const sql = capturedSql();
    // The TRUE predicate is ANDed; the offsite-only clause must NOT appear.
    expect(sql).not.toMatch(/al\.kind = 'offsite'/i);
  });

  // 🔴 civitai#3983 REGRESSION GUARD — the fail-open default this replaced.
  //
  // The test that used to sit here read: "no scope passed → defaults to full (offsite
  // clause absent)". It asserted an ABSENCE (`not.toMatch(/al.kind = 'offsite'/)`) that
  // `full` (TRUE) and `none` (FALSE) BOTH satisfy, so it could not tell the whole
  // catalog from an empty one — it was green for the entire time production served the
  // full approved catalog, on-site apps included, to anonymous callers of
  // `GET /api/v1/apps` through exactly this `?? 'full'` default.
  //
  // Assert the PREDICATE that is emitted, positively, for each way a scope can be
  // missing or uninterpretable. `FALSE` is the whole claim: an absent scope selects
  // nothing.
  it.each([
    ['omitted entirely', undefined as unknown],
    ['explicitly undefined', undefined as unknown],
    ['null', null as unknown],
    ['a string outside the closed set', 'FULL' as unknown],
    ['a non-string', 1 as unknown],
  ])('ABSENT SCOPE FAILS CLOSED — %s → the FALSE predicate, never TRUE', async (_label, value) => {
    await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 20 },
      // deliberately bypassing the compile-time union: the point is the RUNTIME value
      // production actually carried past a green typecheck.
      { scope: value as never }
    );
    const sql = capturedPredicateSql();
    expect(sql).toMatch(/\bFALSE\b/);
    expect(sql).not.toMatch(/\bTRUE\b/);
  });

  // POSITIVE CONTROL for the guard above: the same assertion must be able to FAIL.
  // A privileged caller still emits TRUE, so "matches FALSE / not TRUE" is a claim
  // about the absent-scope case and not a property of every query this builds.
  it('POSITIVE CONTROL: an explicit `full` scope still emits TRUE, not FALSE', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { scope: 'full' });
    const sql = capturedPredicateSql();
    expect(sql).toMatch(/\bTRUE\b/);
    expect(sql).not.toMatch(/\bFALSE\b/);
  });

  // 🔴 SECURITY (W13 draft-at-submit): a pre-approval DRAFT onsite listing exists in
  // `app_listings` from submit time. The store LIST keyset WHERE must hard-gate
  // `status='approved'` (+ `revision_of_id IS NULL`) under EVERY scope so a draft can
  // NEVER surface on `/api/v1/apps` (or the tRPC store grid). This is the security
  // crux — assert the gate is present regardless of the store-visibility scope.
  it('DRAFTS CANNOT LEAK — the keyset WHERE hard-gates status=approved + revision_of_id IS NULL (both scopes)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { scope: 'full' });
    const full = capturedSql();
    expect(full).toMatch(/al\.status = 'approved'/i);
    expect(full).toMatch(/al\.revision_of_id IS NULL/i);

    await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 20 },
      { scope: 'public-external' }
    );
    const ext = capturedSql();
    expect(ext).toMatch(/al\.status = 'approved'/i);
    expect(ext).toMatch(/al\.revision_of_id IS NULL/i);
  });

  it("public-external + client override input.kind='onsite' → offsite predicate STILL wins (empty)", async () => {
    // Security-audit (a): a public viewer cannot escape the offsite-only gate by
    // asking for onsite. The scope predicate `al.kind = 'offsite'` is emitted
    // UNCONDITIONALLY, alongside the client kind filter (`al.kind = <onsite>`), so
    // the WHERE self-contradicts (onsite AND offsite) → no onsite row can return.
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    const result = await listAvailableListings(
      { kind: 'onsite', sort: 'newest', limit: 20 },
      { scope: 'public-external' }
    );
    const sql = capturedSql();
    // The scope predicate is present regardless of the client-supplied kind...
    expect(sql).toMatch(/al\.kind = 'offsite'/i);
    // ...AND the client kind filter clause is ALSO applied (the parameterized
    // `... IS NULL OR al.kind = ...`), so an onsite override can never DROP the
    // offsite predicate — the two clauses AND together, never replace each other.
    expect(sql).toMatch(/IS NULL OR al\.kind =/i);
    // Net effect at the DB: contradictory WHERE → no onsite listing is returned.
    expect(result).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('getListingDetail — STORE-SCOPE kind gate (app-layer)', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
  });

  it('public-external → HIDES (null) an ONSITE listing even by a crafted id/slug', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'public-external' })).toBeNull();
  });

  it('public-external → SHOWS an OFFSITE external-link listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...offsiteExternalRow(),
      status: 'approved',
    });
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_2');
  });

  it('public-external → SHOWS an OFFSITE CONNECT listing (offsite = both sub-kinds)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...offsiteConnectRow(),
      status: 'approved',
    });
    const detail = await getListingDetail({ slug: 'connect-app' }, { scope: 'public-external' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_3');
  });

  it('full → SHOWS an ONSITE listing (no kind gate — unchanged)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_1');
  });

  // 🔴 civitai#3983 REGRESSION GUARD — replaces "default scope (none passed) → full:
  // ONSITE shown (back-compat)", the test that CODIFIED the fail-open default. Under
  // it, an absent scope reached an ONSITE listing's full detail through the public,
  // unauthenticated `GET /api/v1/apps/{slug}`.
  //
  // The DB assertion is the load-bearing half: the guard must short-circuit BEFORE the
  // hydration read, so a mocked approved row cannot leak even if a later projection
  // change would have rendered it.
  it.each([
    ['omitted entirely', undefined as unknown],
    ['explicitly undefined', undefined as unknown],
    ['null', null as unknown],
    ['a string outside the closed set', 'FULL' as unknown],
  ])(
    'ABSENT SCOPE FAILS CLOSED — %s → null, and the DB is never touched',
    async (_label, value) => {
      mockDbRead.appListing.findFirst.mockResolvedValueOnce({
        ...onsiteRow(),
        status: 'approved',
      });
      expect(await getListingDetail({ slug: 'cool-app' }, { scope: value as never })).toBeNull();
      expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
    }
  );

  // POSITIVE CONTROL: the seeded row IS reachable with a real scope, so the nulls
  // above are attributable to the scope and not to a broken fixture.
  it('POSITIVE CONTROL: the same seeded row IS returned under an explicit `full`', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).not.toBeNull();
  });

  // 🔴 SECURITY (W13 draft-at-submit): the DETAIL proc app-layer gate returns null for
  // ANY non-approved row (`row.status !== 'approved'`), so a pre-approval DRAFT (or a
  // PENDING) onsite listing is indistinguishable from a missing one — even under the
  // most-permissive `full` scope. A crafted slug/id can never reach a draft's data on
  // the public REST `/api/v1/apps/[slug]` or the tRPC store detail.
  it('DRAFT CANNOT LEAK — a pre-approval DRAFT onsite listing → null under full scope', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...onsiteRow(),
      status: 'draft',
      appBlockId: null,
      appBlock: null,
    });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).toBeNull();
  });

  it('DRAFT CANNOT LEAK — a PENDING onsite listing → null under full scope', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'pending' });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).toBeNull();
  });

  it('none → HIDES (null) even an approved listing, and never touches the DB (default-closed guard)', async () => {
    // Defense-in-depth symmetric with listingPublicVisibilityFilter('none') → FALSE:
    // a caller with no store visibility gets nothing. The guard short-circuits before
    // the hydration read, so an approved row mocked here must NOT leak.
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'none' })).toBeNull();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
  });
});
