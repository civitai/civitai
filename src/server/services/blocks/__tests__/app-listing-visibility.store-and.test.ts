import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE `AND`-NOT-OVERRIDE SEAM — the one property the whole feature rests on.
 *
 * A per-listing level answers "does the LEVEL admit this cohort". It is ANDed with the
 * SURFACE gate (`app-listings` / `app-blocks-enabled` → `StoreVisibilityScope`), and it may
 * never stand in for it. So a listing at `public` must STILL be invisible to a viewer the
 * surface refuses, and a moderator's floor must not lift a dark surface.
 *
 * ── WHY THIS IS ITS OWN FILE, AND WHY THE VALUE-MODEL SUITE IS NOT ENOUGH ────────
 * `src/shared/utils/__tests__/app-listing-visibility.test.ts` enumerates the (floor, level)
 * matrix, and it CANNOT see this defect: the predicate it tests never receives the scope.
 * The composition is done by the two store reads, so the claim has to be asserted where
 * both gates are in scope — which is here, against the real service functions.
 *
 * ⚠️ LABELS. [NEW] is behaviour this change introduces; [INV] is a property a later edit
 * could break. Nothing here is regression coverage against a base ref: the `floor`
 * parameter does not exist at the base, so these cases fail to COMPILE there rather than
 * going red, and reporting that as "red at base" would be laundering. The assurance behind
 * them is the mutation sweep recorded in the PR body.
 *
 * No DB in unit tests: mock `dbRead.$queryRaw` (the keyset id page — capture the SQL) and
 * the `appListing` delegate (hydration + the guarded manual-apply reads).
 */

/**
 * 🔴 NO PER-FILE MOCK OF THE DB CLIENT HERE — the CANONICAL shared mock, registered once in
 * the global test setup, is used instead. A per-file db mock freezes its own partial shape
 * into every later file in the same worker under `--no-isolate`; `no-direct-shared-module-mock`
 * is the ratchet that stops a new one being added. See docs/testing/shared-module-mocks.md.
 * (That guard scans this file's TEXT, so the specifier must not be spelled inside a mock
 * call even in prose — hence the wording.)
 */
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  // Pass the statement straight through to the shared mock's `$queryRaw` so the cached
  // keyset page is observable. 🔴 BOTH EXPORTS: `app-listing.service` imports `bustCacheTag`
  // too (it owns `bustAppListingCatalogCache`), and a one-key factory makes the WHOLE file
  // fail to import.
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      dbMock.dbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getListingDetail,
  listAvailableListings,
  listingLevelVisibilityFilter,
} from '../app-listing.service';
import type {
  AppListingVisibility,
  ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';
import {
  listingVisibleInStore,
  visibilitiesVisibleToForStatus,
} from '~/shared/utils/app-listing-visibility';

/** The `appListing` delegate on the shared mock — this file's only fake. */
const listing = dbMock.dbRead.appListing;

/** What the guarded `visibility` read answers for the seeded row. Set per case. */
let seededVisibility: AppListingVisibility | null | 'THROW_P2022' = 'public';
/** What the cached keyset page returns. */
let pageRows: unknown[] = [];

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg), comments stripped. */
function capturedPredicateSql(): string {
  // 🔴 THE LAST *PAGE* STATEMENT, NOT THE LAST STATEMENT. The level read also rides
  // `$queryRaw` now, so `calls.at(-1)` can be the level read and every SQL assertion would
  // be reading the wrong statement — green or red for reasons unrelated to the predicate.
  const pageCalls = dbMock.dbRead.$queryRaw.mock.calls.filter((c) => !isLevelRead(c[0]));
  const first = pageCalls.at(-1)?.[0] as { sql?: unknown } | undefined;
  const sql = first && typeof first.sql === 'string' ? first.sql : '';
  // 🔴 COMMENTS STRIPPED, AND IT IS LOAD-BEARING. The statement's own comments name the
  // predicates in prose ("the approved-only predicate"), so a bare match over the raw text
  // can be satisfied by a comment rather than by SQL. The sibling scope suite records the
  // same trap producing a confident fail-open report about a `FALSE` predicate.
  return sql.replace(/--[^\n]*/g, '');
}

/** A hydrated row as `listingHydrateSelect` + the detail extras return it. */
function approvedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_and',
    kind: 'offsite',
    slug: 'and-app',
    name: 'And App',
    tagline: 't',
    description: 'body',
    category: null,
    contentRating: null,
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    status: 'approved',
    featured: false,
    featuredOrder: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    icon: null,
    cover: null,
    screenshots: [],
    metric: null,
    appBlock: null,
    user: { id: 7, username: 'dev', image: null, deletedAt: null },
    ...over,
  };
}

/** The default guarded-read behaviour for the Prisma delegate. */
async function defaultFindUnique(args: unknown): Promise<unknown> {
  const select = (args as { select?: Record<string, unknown> } | undefined)?.select ?? {};
  if ('sourceRepoUrl' in select) return { sourceRepoUrl: null };
  return { isBeta: false, betaMessage: null };
}

/** Is this statement the level read rather than the cached keyset page? */
const isLevelRead = (stmt: unknown) =>
  typeof (stmt as { sql?: unknown })?.sql === 'string' &&
  (stmt as { sql: string }).sql.includes('SELECT "visibility" FROM "app_listings"');

/**
 * 🔴 BOTH THE LEVEL READ AND THE CACHED PAGE NOW GO THROUGH `$queryRaw`, so this fake
 * discriminates on the STATEMENT. The level column is `// @no-type` — absent from the
 * generated client — so it can only be reached by raw SQL; that is the fix for the P2022
 * that 500d off-site submit on the PR preview, and it means the delegate can no longer
 * answer for it. A fake keyed on the method alone would hand the keyset page's rows to the
 * level reader and vice versa.
 */
async function defaultQueryRaw(stmt: unknown): Promise<unknown[]> {
  if (isLevelRead(stmt)) {
    if (seededVisibility === 'THROW_P2022') {
      throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
    }
    return [{ visibility: seededVisibility }];
  }
  return pageRows;
}

beforeEach(() => {
  // 🔴 `clearAllMocks` CLEARS CALLS, NOT IMPLEMENTATIONS, and that cost a real failure
  // while this file was being written. The P2022-throwing `findUnique` installed by the
  // column-unavailable case below survived into the NEXT test, which then saw
  // `available: false`, fell back to the approved-only predicate, and reported a draft
  // listing as invisible to its own cohort — a red test naming the wrong cause. Every
  // implementation this file overrides is therefore reinstalled here, explicitly.
  vi.clearAllMocks();
  seededVisibility = 'public';
  listing.findFirst.mockImplementation(async () => approvedRow());
  listing.findUnique.mockImplementation(defaultFindUnique);
  pageRows = [];
  dbMock.dbRead.$queryRaw.mockImplementation(defaultQueryRaw);
});

describe('the level is an AND with the surface scope, never an override', () => {
  it('[INV] a `public` listing is INVISIBLE in the detail read when the surface says `none`', () => {
    // 🔴 THE OWED TEST. `public` is the widest level there is; if a level could stand in
    // for the surface gate, this is where it would show — and pre-GA that would publish
    // every app whose owner picked `public` to the entire internet.
    seededVisibility = 'public';
    return expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'none', floor: 'public' })
    ).resolves.toBeNull();
  });

  it('[INV] a MODERATOR floor does not lift a dark surface either', async () => {
    // The widest cohort against the narrowest surface. A moderator is the audience most
    // likely to be special-cased past a gate, and the store-scope resolver's own
    // "never narrow a moderator" invariant is about not NARROWING them — it says nothing
    // that would license widening the surface for them here.
    seededVisibility = 'public';
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'none', floor: 'moderators' })
    ).resolves.toBeNull();
    // And the refusal happened BEFORE any row read, so it cannot be a coincidence of the
    // fixture: the scope gate short-circuits.
    expect(listing.findFirst).not.toHaveBeenCalled();
  });

  it('[INV] the KIND gate still applies on top of the level', async () => {
    // `public-external` admits only offsite listings. A `public` ONSITE listing must stay
    // invisible to that cohort — the level widens WHO, never WHICH KINDS.
    seededVisibility = 'public';
    listing.findFirst.mockImplementation(async () =>
      approvedRow({ kind: 'onsite', appBlock: { currentVersionDeployedAt: new Date() } })
    );
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'public-external', floor: 'moderators' })
    ).resolves.toBeNull();
  });

  it('[INV][POSITIVE CONTROL] the same listing IS visible once the surface admits it', async () => {
    // Without this pair, every null above is indistinguishable from a harness wired to
    // nothing — the fixture could simply never resolve a listing at all.
    seededVisibility = 'public';
    const detail = await getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' });
    expect(detail).not.toBeNull();
    expect(detail?.slug).toBe('and-app');
  });

  it('[INV] an OMITTED floor makes the LIST path bind the `public` level only', async () => {
    // 🔴 THE LIST-PATH HALF OF THE FAIL-CLOSED DEFAULT, and it was UNCOVERED until a
    // mutation sweep showed it: changing `opts.floor ?? 'public'` to `?? 'moderators'` in
    // `listAvailableListings` killed no test, i.e. a one-word edit would have served every
    // draft listing's id page to every caller that omitted the argument — and the detail
    // path's own default case cannot see it, because they are two separate defaults.
    // Asserted on the BOUND VALUES rather than the SQL text, since the levels ride as
    // parameters and the statement text is identical for every floor.
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 10 } as never, {
      scope: 'full',
    });
    const last = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
    const values = ((last?.[0] as { values?: unknown[] } | undefined)?.values ?? []).filter(
      (v) => typeof v === 'string'
    );
    expect(values).toContain('public');
    expect(values).not.toContain('moderators');
    expect(values).not.toContain('testers');
  });

  it('[INV] the LIST statement carries the surface predicate AND the level predicate', async () => {
    // The list path composes the two as separate `AND` terms rather than choosing between
    // them. Asserted on the composed SQL because that is the artefact a refactor would
    // change; the detail path's equivalent is the behavioural pair above.
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 10 } as never, {
      scope: 'public-external',
      floor: 'moderators',
    });
    const sql = capturedPredicateSql();
    // The surface (kind) gate.
    expect(sql).toContain("al.kind = 'offsite'");
    // The level gate, in the same WHERE.
    expect(sql).toContain('al.visibility IN');
    // 🔴 AND THE APPROVED BASELINE SURVIVES BOTH. If this disappeared, the level would
    // have replaced the pre-feature predicate rather than widened it.
    expect(sql).toContain("al.status = 'approved'");
  });
});

describe('listingLevelVisibilityFilter — the SQL drift guard', () => {
  it('[NEW] pins the WHOLE predicate, normalised — not three substrings of it', () => {
    // 🔴 `toBe` ON THE NORMALISED STRING, AND THE CHANGE FROM `toContain` IS THE WHOLE
    // POINT. Three `toContain` checks over `al.status = 'approved'`, `al.status IN` and
    // `al.visibility IN` are satisfied by predicates that mean completely different
    // things, and a mutation sweep proved it: flipping the inner `AND` to `OR` SURVIVED,
    // which admits a `removed` or `rejected` listing whose level is `public` into the
    // public grid with no status restriction at all — fail-open on the exact un-takedown
    // property this feature is built around. Dropping the fragment's outer parentheses
    // survived too, which lets an approved row escape the statement's
    // `al.revision_of_id IS NULL` and surface a shadow revision.
    //
    // A cosmetic reformat of the SQL now fails this test. That is the price, and it is
    // worth paying for a machine-readable claim about a security predicate — the
    // `available === false` case below was already pinned this way, and that asymmetry was
    // the tell that this one was under-specified.
    const norm = (frag: { sql: string }) => frag.sql.replace(/\s+/g, ' ').trim();
    expect(norm(listingLevelVisibilityFilter('moderators'))).toBe(
      "( (al.visibility IS NULL AND al.status = 'approved') OR (al.visibility IS NOT NULL " +
        "AND ((al.status = 'approved' AND al.visibility IN (?,?,?)) OR (al.status IN (?,?) " +
        'AND al.visibility IN (?)))) )'
    );
    // 🔴 AND THE NON-MODERATOR FLOORS CARRY NO UNREVIEWED ARM AT ALL — that is the review
    // ceiling in the data layer. A non-moderator cohort can reach NO unreviewed listing at
    // any level, so the arm is OMITTED rather than emitted as a bare `FALSE`: an empty
    // `IN ()` is a syntax error, and a stray `FALSE` here trips the sibling kind-gate
    // drift-guard that scans this statement for exactly that word.
    expect(norm(listingLevelVisibilityFilter('testers'))).toBe(
      "( (al.visibility IS NULL AND al.status = 'approved') OR (al.visibility IS NOT NULL " +
        "AND ((al.status = 'approved' AND al.visibility IN (?,?)))) )"
    );
    expect(norm(listingLevelVisibilityFilter('public'))).toBe(
      "( (al.visibility IS NULL AND al.status = 'approved') OR (al.visibility IS NOT NULL " +
        "AND ((al.status = 'approved' AND al.visibility IN (?)))) )"
    );
    // Neither emits a bare FALSE, which is the property the sibling guard rests on.
    for (const f of ['moderators', 'testers', 'public'] as const) {
      expect(norm(listingLevelVisibilityFilter(f))).not.toMatch(/\bFALSE\b/);
    }
  });

  it('[NEW] binds the statuses and levels as PARAMETERS, allowlisted', () => {
    // Parameterised, not interpolated: the predicate cannot be built by splicing a string
    // into SQL source. Order follows the two arms — the approved arm's levels, then the
    // unreviewed statuses and the single level the ceiling admits there.
    expect(listingLevelVisibilityFilter('moderators').values).toEqual([
      'moderators',
      'testers',
      'public',
      'draft',
      'pending',
      'moderators',
    ]);
    // 🔴 A NON-MODERATOR FLOOR BINDS NO UNREVIEWED STATUS AT ALL — not `draft`, not
    // `pending`. The arm is a literal FALSE, so there is nothing to bind.
    for (const floor of ['testers', 'public'] as const) {
      const vals = listingLevelVisibilityFilter(floor).values;
      expect(vals).not.toContain('draft');
      expect(vals).not.toContain('pending');
    }
    // `removed` and `rejected` appear nowhere, for any floor — the status set is an
    // allowlist.
    for (const floor of ['moderators', 'testers', 'public'] as const) {
      const vals = listingLevelVisibilityFilter(floor).values;
      expect(vals).not.toContain('removed');
      expect(vals).not.toContain('rejected');
    }
  });

  it('[INV] a narrower floor binds strictly fewer levels', () => {
    // The cohort distinction, visible in the bound parameters. If every floor bound the
    // same list, the enum would be inert in the data layer while every unit test of the
    // value model stayed green.
    // Scoped to the APPROVED arm, which is the one where the cohort rule is the only
    // constraint — the unreviewed arm is governed by the review ceiling instead and is
    // asserted above.
    const approvedLevels = (floor: 'moderators' | 'testers' | 'public') =>
      visibilitiesVisibleToForStatus(floor, 'approved');
    expect(approvedLevels('moderators')).toEqual(['moderators', 'testers', 'public']);
    expect(approvedLevels('testers')).toEqual(['testers', 'public']);
    expect(approvedLevels('public')).toEqual(['public']);
    // `private` is bound for NO floor — it admits nobody.
    for (const f of ['moderators', 'testers', 'public'] as const) {
      expect(listingLevelVisibilityFilter(f).values).not.toContain('private');
    }
  });
});

describe('the SQL predicate and the app-layer predicate AGREE', () => {
  /**
   * 🔴 TWO INDEPENDENT IMPLEMENTATIONS OF ONE RULE, AND THIS IS THE SEAM BETWEEN THEM. The
   * list path decides in SQL (`listingLevelVisibilityFilter`); the detail path decides in
   * TypeScript (`listingVisibleInStore`). Nothing else compares them, and a disagreement is
   * invisible from either side: each surface would be self-consistently wrong, which is the
   * "verified in isolation" shape — the defect lives in the seam neither owns.
   *
   * The SQL side is evaluated here by interpreting the fragment's OWN emitted structure and
   * bound parameters rather than by restating the predicate: the eligible statuses and the
   * admitted levels are read back out of `frag.values`, so a change to either list moves
   * this check with it. What is hand-written is only the SHAPE of the disjunction — and that
   * shape is independently pinned, whole, by the `toBe` case above, so a mutation to it
   * cannot pass both.
   */
  const SQL_SHAPE = (
    status: string,
    visibility: AppListingVisibility | null,
    floor: ListingAudienceFloor
  ): boolean => {
    // (al.visibility IS NULL AND al.status = 'approved')
    if (visibility === null) return status === 'approved';
    // OR (al.visibility IS NOT NULL AND ( approvedArm OR unreviewedArm ))
    // Each arm's admitted level list is read back out of the helper the fragment itself
    // uses, so a change to either moves this check with it rather than needing a restated
    // predicate. An EMPTY list is the literal FALSE the fragment emits.
    const approvedArm =
      status === 'approved' &&
      visibilitiesVisibleToForStatus(floor, 'approved').includes(visibility);
    const unreviewedArm =
      (status === 'draft' || status === 'pending') &&
      visibilitiesVisibleToForStatus(floor, 'draft').includes(visibility);
    return approvedArm || unreviewedArm;
  };

  it('[INV] the two predicates agree on EVERY (status, level, floor) combination', () => {
    const statuses = ['draft', 'pending', 'approved', 'rejected', 'removed'];
    const levels: (AppListingVisibility | null)[] = [
      null,
      'private',
      'moderators',
      'testers',
      'public',
    ];
    const floors: ListingAudienceFloor[] = ['moderators', 'testers', 'public'];
    const disagreements: string[] = [];
    let compared = 0;
    for (const status of statuses) {
      for (const visibility of levels) {
        for (const floor of floors) {
          compared += 1;
          const app = listingVisibleInStore({ status, visibility, floor });
          const sql = SQL_SHAPE(status, visibility, floor);
          if (app !== sql) {
            disagreements.push(`${status}/${visibility ?? 'NULL'}/${floor}: app=${app} sql=${sql}`);
          }
        }
      }
    }
    // POSITIVE CONTROL for the loop itself — without it an empty matrix passes vacuously.
    expect(compared).toBe(statuses.length * levels.length * floors.length);
    expect(disagreements, 'the list path and the detail path would show different rows').toEqual(
      []
    );
  });

  it('[INV][CONTROL] the comparison can distinguish them — it is not comparing a value to itself', () => {
    // The agreement case above would be vacuous if both sides were the same expression.
    // These are the combinations where the rule is non-trivial, asserted as literals so the
    // matrix is anchored to stated behaviour rather than to either implementation.
    expect(listingVisibleInStore({ status: 'approved', visibility: null, floor: 'public' })).toBe(
      true
    );
    expect(
      listingVisibleInStore({ status: 'approved', visibility: 'private', floor: 'moderators' })
    ).toBe(false);
    expect(listingVisibleInStore({ status: 'draft', visibility: null, floor: 'moderators' })).toBe(
      false
    );
    expect(
      listingVisibleInStore({ status: 'draft', visibility: 'moderators', floor: 'moderators' })
    ).toBe(true);
    expect(
      listingVisibleInStore({ status: 'removed', visibility: 'public', floor: 'moderators' })
    ).toBe(false);
  });
});

describe('the manual-apply column degrades via a CATCH, not a probe', () => {
  /**
   * ⚠️ THESE TWO CASES CHANGED SHAPE RATHER THAN BEING DELETED, and the reason is the whole
   * point of the change they track. The degradation used to be driven by a pre-flight PROBE
   * (`isListingVisibilityColumnAvailable`), so the behaviour was reachable by calling
   * `listingLevelVisibilityFilter(floor, false)` directly — which is what the old cases did,
   * and why hardwiring the probe to `true` once SURVIVED a mutation sweep: nothing proved
   * the probe's answer reached the statement.
   *
   * The probe is gone — it cost a round trip on every grid read including cache hits, and
   * neither in-tree sibling for a manual-apply column does it. The degradation is now a
   * catch on 42703 that re-runs the pre-feature predicate, matching those siblings. So the
   * coverage is re-pointed at the catch: drive the real read with the column missing and
   * assert the SECOND statement, which is the only place the behaviour now exists.
   */
  it('[INV] a 42703 on the real read re-runs with the pre-feature predicate', async () => {
    // 🔴 THE OUTAGE THIS PREVENTS: a statement naming `al.visibility` against a database
    // that has not had the migration applied is a P2022 on the PUBLIC grid, not a missing
    // badge. The retry must be the approved-only test — not `private` (which would empty
    // the grid) and not `public` (which would admit drafts).
    let page = 0;
    dbMock.dbRead.$queryRaw.mockImplementation(async (stmt: unknown) => {
      if (isLevelRead(stmt)) return [{ visibility: seededVisibility }];
      page += 1;
      if (page === 1) {
        throw Object.assign(new Error('column al.visibility does not exist'), { code: 'P2022' });
      }
      return [];
    });
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 10 } as never, {
      scope: 'full',
      floor: 'moderators',
    });
    // Two PAGE statements were issued, and it is the SECOND that must be level-free.
    expect(page).toBe(2);
    const sql = capturedPredicateSql();
    expect(sql).not.toContain('al.visibility');
    expect(sql).toContain("al.status = 'approved'");
  });

  it('[INV][POSITIVE CONTROL] with the column present there is ONE statement, and it names the column', async () => {
    // Without the pair, the `not.toContain` above is indistinguishable from a statement that
    // never names the column at all — and the call COUNT is what separates "degraded" from
    // "never tried", which the old probe-shaped case could not express.
    let page = 0;
    dbMock.dbRead.$queryRaw.mockImplementation(async (stmt: unknown) => {
      if (isLevelRead(stmt)) return [{ visibility: seededVisibility }];
      page += 1;
      return [];
    });
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 10 } as never, {
      scope: 'full',
      floor: 'moderators',
    });
    expect(page).toBe(1);
    expect(capturedPredicateSql()).toContain('al.visibility');
  });

  it('[INV] a NON-column error PROPAGATES — a dead replica must not read as a short store', async () => {
    // The catch is narrow on purpose. Swallowing a timeout here would turn a real outage
    // into a quietly truncated grid, which is the failure mode the degradation exists to
    // avoid rather than cause.
    const boom = Object.assign(new Error('Timed out fetching a connection'), { code: 'P2024' });
    dbMock.dbRead.$queryRaw.mockImplementation(async (stmt: unknown) => {
      if (isLevelRead(stmt)) return [{ visibility: seededVisibility }];
      throw boom;
    });
    await expect(
      listAvailableListings({ kind: 'all', sort: 'newest', limit: 10 } as never, {
        scope: 'full',
        floor: 'moderators',
      })
    ).rejects.toBe(boom);
  });

  it('[INV] the DETAIL read degrades through `null`, with no `available` branch', async () => {
    // The detail path needs no special case at all now: the guarded reader catches the
    // missing column and answers `visibility: null`, which already resolves to the
    // pre-feature rule. An approved listing stays visible; a draft stays hidden.
    seededVisibility = 'THROW_P2022';
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' })
    ).resolves.not.toBeNull();
    listing.findFirst.mockImplementation(async () => approvedRow({ status: 'draft' }));
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'moderators' })
    ).resolves.toBeNull();
  });
});

describe('the detail read falls back to the pre-feature predicate, not to `private`', () => {
  it('[INV] an APPROVED listing is still shown when the column is unavailable', async () => {
    // 🔴 THE OUTAGE THIS PREVENTS. Degrading an unreadable level to `private` would hide
    // every approved listing's detail page — fail-closed in form, a store outage in
    // effect. The fallback is the predicate that shipped before this feature.
    seededVisibility = 'THROW_P2022';
    const detail = await getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' });
    expect(detail).not.toBeNull();
  });

  it('[INV] an APPROVED listing with an UNSET level is shown', async () => {
    // The newly-approved-vanishes regression, at the service layer. Every existing row and
    // every row a future approval mints carries NULL, so an unset level on an approved
    // listing must resolve to the pre-feature baseline rather than to `private`.
    seededVisibility = null;
    const detail = await getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' });
    expect(detail).not.toBeNull();
  });

  it('[NEW] an APPROVED listing is HIDDEN once its level is set below the viewer', async () => {
    // 🔴 THE RESTRICT CAPABILITY, at the service layer. A set level binds on an approved
    // listing, so an owner can pull a live listing back to a cohort or out of the store
    // entirely. DISCOVERY-ONLY — the run route never reads this column.
    seededVisibility = 'private';
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' })
    ).resolves.toBeNull();
    seededVisibility = 'testers';
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' })
    ).resolves.toBeNull();
    // POSITIVE CONTROL: the cohort the level names still sees it, so the nulls above are
    // the level binding rather than the fixture failing to resolve a row at all.
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'testers' })
    ).resolves.not.toBeNull();
  });

  it('[INV] an OMITTED floor behaves as `public` — the least-privileged default', async () => {
    // 🔴 THE SERVICE-SIDE HALF OF "A DEFAULT IS AN AUTHORIZATION DECISION". Both store
    // reads default `opts.floor` themselves, so a caller that forgets to thread it must
    // see only what an anonymous viewer could already see. A default of `moderators` here
    // would hand every draft listing to every caller that omitted one argument.
    listing.findFirst.mockImplementation(async () => approvedRow({ status: 'draft' }));
    seededVisibility = 'moderators';
    await expect(getListingDetail({ slug: 'and-app' }, { scope: 'full' })).resolves.toBeNull();
    // POSITIVE CONTROL: the same row IS reachable once a floor that admits it is passed,
    // so the null above is the default at work and not an unrelated refusal.
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'moderators' })
    ).resolves.not.toBeNull();
  });

  it('[NEW] a DRAFT listing is hidden from a general viewer and shown to its cohort', async () => {
    listing.findFirst.mockImplementation(async () => approvedRow({ status: 'draft' }));
    seededVisibility = 'moderators';
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' })
    ).resolves.toBeNull();
    await expect(
      getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'testers' })
    ).resolves.toBeNull();
    const seen = await getListingDetail(
      { slug: 'and-app' },
      { scope: 'full', floor: 'moderators' }
    );
    expect(seen).not.toBeNull();
  });

  it('[INV] a REMOVED listing stays hidden from every cohort, whatever its level says', async () => {
    // A row can carry a level set BEFORE it was taken down, so the status allowlist is
    // checked at the read as well as at the write. This is the H1 guard at the data layer.
    listing.findFirst.mockImplementation(async () => approvedRow({ status: 'removed' }));
    seededVisibility = 'public';
    for (const floor of ['moderators', 'testers', 'public'] as const) {
      await expect(
        getListingDetail({ slug: 'and-app' }, { scope: 'full', floor })
      ).resolves.toBeNull();
    }
  });
});
