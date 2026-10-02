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
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';

/** The `appListing` delegate on the shared mock — this file's only fake. */
const listing = dbMock.dbRead.appListing;

/** What the guarded `visibility` read answers for the seeded row. Set per case. */
let seededVisibility: AppListingVisibility | null = 'public';

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg), comments stripped. */
function capturedPredicateSql(): string {
  const last = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { sql?: unknown } | undefined;
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

/** The default guarded-read behaviour: answer whichever manual-apply `select` is asked. */
async function defaultFindUnique(args: unknown): Promise<unknown> {
  const select = (args as { select?: Record<string, unknown> } | undefined)?.select ?? {};
  if ('visibility' in select) return { visibility: seededVisibility };
  if ('sourceRepoUrl' in select) return { sourceRepoUrl: null };
  return { isBeta: false, betaMessage: null };
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
  dbMock.dbRead.$queryRaw.mockImplementation(async () => []);
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
  it('[NEW] emits ONLY the approved-only predicate while the column is absent', () => {
    // 🔴 THE MANUAL-APPLY GUARANTEE, AS SQL. If this ever named `al.visibility`, the
    // public grid would 500 on P2022 from the moment the code deployed until a human ran
    // the migration — the outage the guarded-reader pattern exists to prevent.
    for (const floor of ['moderators', 'testers', 'public'] as const) {
      const sql = listingLevelVisibilityFilter(floor, false).sql;
      expect(sql).toBe("al.status = 'approved'");
      expect(sql).not.toContain('visibility');
    }
  });

  it('[NEW] widens ONLY `draft`/`pending`, and binds the levels as parameters', () => {
    const frag = listingLevelVisibilityFilter('moderators', true);
    // The approved baseline is the first disjunct.
    expect(frag.sql).toContain("al.status = 'approved'");
    expect(frag.sql).toContain('al.status IN');
    expect(frag.sql).toContain('al.visibility IN');
    // 🔴 PARAMETERISED, NOT INTERPOLATED. The statuses and levels ride as bound values, so
    // the predicate cannot be built by splicing a string into SQL source.
    expect(frag.values).toEqual(['draft', 'pending', 'moderators', 'testers', 'public']);
    // `removed` and `rejected` appear nowhere — the widening is an allowlist.
    expect(frag.values).not.toContain('removed');
    expect(frag.values).not.toContain('rejected');
  });

  it('[INV] a narrower floor binds strictly fewer levels', () => {
    // The cohort distinction, visible in the bound parameters. If every floor bound the
    // same list, the enum would be inert in the data layer while every unit test of the
    // value model stayed green.
    const levels = (floor: 'moderators' | 'testers' | 'public') =>
      listingLevelVisibilityFilter(floor, true).values.filter(
        (v) => v !== 'draft' && v !== 'pending'
      );
    expect(levels('moderators')).toEqual(['moderators', 'testers', 'public']);
    expect(levels('testers')).toEqual(['testers', 'public']);
    expect(levels('public')).toEqual(['public']);
    // `private` is bound for NO floor — it admits nobody.
    for (const f of ['moderators', 'testers', 'public'] as const) {
      expect(listingLevelVisibilityFilter(f, true).values).not.toContain('private');
    }
  });
});

describe('the detail read falls back to the pre-feature predicate, not to `private`', () => {
  it('[INV] an APPROVED listing is still shown when the column is unavailable', async () => {
    // 🔴 THE OUTAGE THIS PREVENTS. Degrading an unreadable level to `private` would hide
    // every approved listing's detail page — fail-closed in form, a store outage in
    // effect. The fallback is the predicate that shipped before this feature.
    listing.findUnique.mockImplementation(async (args: unknown) => {
      const select = (args as { select?: Record<string, unknown> } | undefined)?.select ?? {};
      if ('visibility' in select) {
        throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
      }
      if ('sourceRepoUrl' in select) return { sourceRepoUrl: null };
      return { isBeta: false, betaMessage: null };
    });
    const detail = await getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' });
    expect(detail).not.toBeNull();
  });

  it('[INV] an APPROVED listing is shown even at the `private` level', async () => {
    // The newly-approved-vanishes regression, at the service layer. The column defaults to
    // `private`, so an approve that ran before the backfill — or any row the backfill
    // missed — must not be hidden.
    seededVisibility = 'private';
    const detail = await getListingDetail({ slug: 'and-app' }, { scope: 'full', floor: 'public' });
    expect(detail).not.toBeNull();
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
