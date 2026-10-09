import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The viewer-scoped `restrictedAudience` field on the STORE READS — the grid card
 * (`listAvailableListings`), the detail (`getListingDetail`) and the moderator review
 * preview (`getListingPreviewForReview`) — driven through the real service functions.
 *
 * [NEW] behaviour: the field does not exist at the base ref. The assurance is the mutation
 * matrix in the PR body.
 *
 * 🔴 FIXTURE IDS ARE PAIRWISE DISTINCT. The listing id is a string, the owner is user 4101,
 * and every other viewer has its own id, so an implementation that compared the viewer to
 * the wrong key (the listing id, a viewer to itself) cannot pass by coincidence.
 *
 * Uses the CANONICAL shared db mock from the global setup (see the sibling
 * `app-listing-visibility.store-and.test.ts` for why no per-file db mock).
 */
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      dbMock.dbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getListingDetail,
  getListingPreviewForReview,
  listAvailableListings,
} from '../app-listing.service';
import type {
  AppListingVisibility,
  ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';

const LISTING_ID = 'apl_ra_listing_01';
const OWNER_ID = 4101;

type Viewer = 'owner' | 'moderator' | 'tester' | 'regular' | 'anonymous';

/** What the router hands the service for each viewer: their resolved floor + identity. */
const VIEWERS: Record<
  Viewer,
  { floor: ListingAudienceFloor; viewer: { userId: number | null; isModerator: boolean } }
> = {
  // An ordinary, non-tester account that happens to own the listing.
  owner: { floor: 'public', viewer: { userId: OWNER_ID, isModerator: false } },
  moderator: { floor: 'moderators', viewer: { userId: 5202, isModerator: true } },
  tester: { floor: 'testers', viewer: { userId: 6303, isModerator: false } },
  regular: { floor: 'public', viewer: { userId: 7404, isModerator: false } },
  anonymous: { floor: 'public', viewer: { userId: null, isModerator: false } },
};

const listing = dbMock.dbRead.appListing;

/** The stored level the raw visibility reads answer with. Set per case. */
let seededVisibility: AppListingVisibility | null | 'THROW_P2022' | 'THROW_OTHER' = null;
let pageRows: unknown[] = [];

function row(over: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    serialId: 9,
    kind: 'offsite',
    slug: 'ra-app',
    name: 'RA App',
    tagline: 't',
    description: 'body',
    category: null,
    contentRating: null,
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    revisionOfId: null,
    status: 'approved',
    updatedAt: new Date('2026-01-01'),
    icon: null,
    cover: null,
    screenshots: [],
    metric: null,
    appBlock: null,
    appBlockId: null,
    user: { id: OWNER_ID, username: 'owner', image: null },
    ...over,
  };
}

const isVisibilityRead = (stmt: unknown) =>
  typeof (stmt as { sql?: unknown })?.sql === 'string' &&
  /"visibility" FROM "app_listings"/.test((stmt as { sql: string }).sql);

async function fakeQueryRaw(stmt: unknown): Promise<unknown[]> {
  if (isVisibilityRead(stmt)) {
    if (seededVisibility === 'THROW_P2022') {
      throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
    }
    if (seededVisibility === 'THROW_OTHER') throw new Error('connection reset');
    // One shape answers both the single read and the page read: the single read ignores
    // the extra `id` key.
    return [{ id: LISTING_ID, visibility: seededVisibility }];
  }
  return pageRows;
}

beforeEach(() => {
  vi.clearAllMocks();
  seededVisibility = null;
  pageRows = [];
  dbMock.dbRead.$queryRaw.mockImplementation(fakeQueryRaw);
  listing.findFirst.mockImplementation(async () => row());
  listing.findUnique.mockImplementation(async (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> } | undefined)?.select ?? {};
    if ('sourceRepoUrl' in select) return { sourceRepoUrl: null };
    if ('isBeta' in select) return { isBeta: false, betaMessage: null };
    return row();
  });
  listing.findMany.mockImplementation(async () => [row()]);
});

async function detailFor(viewer: Viewer) {
  const { floor, viewer: v } = VIEWERS[viewer];
  const detail = await getListingDetail({ slug: 'ra-app' }, { scope: 'full', floor, viewer: v });
  return detail === null ? 'NOT_FOUND' : detail.restrictedAudience;
}

describe('getListingDetail — restrictedAudience, viewer × level on an APPROVED listing', () => {
  // 🔴 LITERAL expectations. `NOT_FOUND` is the level GATE refusing the page (the detail is
  // `null`); any other value is the field on a served detail. Columns:
  // private | moderators | testers | public | null.
  //
  // ⚠️ The owner row is all NOT_FOUND for restricted levels, and that is TODAY'S GATE, not
  // this field: the store detail read admits by cohort only, so an owner outside the
  // admitted cohort cannot open their own restricted listing's store page at all. The
  // owner arm of the derivation is reached on the moderator preview and by any future
  // owner bypass of the gate; see the pure matrix in `app-listing-visibility.restricted-
  // audience.test.ts`.
  //
  // ⚠️ CONSEQUENCE, STATED SO THIS MATRIX IS NOT READ AS MORE THAN IT IS: every cell that
  // serves a detail is one the viewer's COHORT already admits, so this matrix cannot tell
  // whether `getListingDetail` threads `opts.viewer` into the derivation at all — a mutant
  // passing the anonymous viewer instead stays green here — and NOTHING else pins it: the
  // grid suite drives a different function, and the router test mocks the service. That
  // mutant is behaviour-identical in production today (the gate serves only cohort-admitted
  // cells). If the detail gate is ever widened for owners, add a detail case reaching an
  // owner through it — that is the moment this wiring becomes observable.
  const LEVELS = ['private', 'moderators', 'testers', 'public', null] as const;
  const EXPECTED: Record<Viewer, ReadonlyArray<string | null>> = {
    owner: ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', null, null],
    moderator: ['NOT_FOUND', 'moderators', 'testers', null, null],
    tester: ['NOT_FOUND', 'NOT_FOUND', 'testers', null, null],
    regular: ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', null, null],
    anonymous: ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', null, null],
  };

  for (const viewer of Object.keys(EXPECTED) as Viewer[]) {
    LEVELS.forEach((level, i) => {
      it(`${viewer} × ${String(level)} → ${String(EXPECTED[viewer][i])}`, async () => {
        seededVisibility = level;
        expect(await detailFor(viewer)).toBe(EXPECTED[viewer][i]);
      });
    });
  }

  it('[POSITIVE CONTROL] the fixture serves a detail at all (a `public` listing, anonymous)', async () => {
    seededVisibility = 'public';
    const detail = await getListingDetail({ slug: 'ra-app' }, { scope: 'full', floor: 'public' });
    expect(detail?.slug).toBe('ra-app');
  });
});

describe('listAvailableListings — restrictedAudience on the GRID card', () => {
  beforeEach(() => {
    pageRows = [{ id: LISTING_ID, sort_key: '000000100' }];
  });

  async function cardFor(viewer: Viewer) {
    const { floor, viewer: v } = VIEWERS[viewer];
    const { items } = await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 10 } as never,
      { scope: 'full', floor, viewer: v }
    );
    expect(items).toHaveLength(1);
    return (items[0] as { restrictedAudience: unknown }).restrictedAudience;
  }

  it('a tester sees `testers` on a `testers` card', async () => {
    seededVisibility = 'testers';
    expect(await cardFor('tester')).toBe('testers');
  });

  it('a moderator sees `moderators` on a `moderators` card', async () => {
    seededVisibility = 'moderators';
    expect(await cardFor('moderator')).toBe('moderators');
  });

  it('`public` and unset render no badge', async () => {
    seededVisibility = 'public';
    expect(await cardFor('regular')).toBeNull();
    seededVisibility = null;
    expect(await cardFor('anonymous')).toBeNull();
  });

  it('🔴 a STALE cached page row whose level is now narrower than the viewer tells them NOTHING', async () => {
    // The id page is cached per floor; the level is read live. If an owner narrowed a
    // `public` listing to `moderators` and the bust was missed, a regular viewer's cached
    // page still carries the row — the badge must not disclose the new level to them.
    seededVisibility = 'moderators';
    expect(await cardFor('regular')).toBeNull();
    // Positive control on the same row: the cohort that IS admitted is told.
    expect(await cardFor('moderator')).toBe('moderators');
  });

  it('the OWNER of a stale row is told its level (ownership, not cohort)', async () => {
    seededVisibility = 'testers';
    expect(await cardFor('owner')).toBe('testers');
    // …and a different regular account on the same row is not.
    expect(await cardFor('regular')).toBeNull();
  });

  it('a MISSING visibility column (manual migration outstanding) renders no badge, not a crash', async () => {
    seededVisibility = 'THROW_P2022';
    expect(await cardFor('moderator')).toBeNull();
  });

  it('🔴 an OMITTED viewer is ANONYMOUS: a stale `moderators` row on the `public` floor gets no badge', async () => {
    // Pins the fail-closed default. A default of "moderator" (or any identity) would return
    // `moderators` here; anonymous on the `public` floor can be told nothing.
    seededVisibility = 'moderators';
    const { items } = await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 10 } as never,
      { scope: 'full', floor: 'public' }
    );
    expect(items).toHaveLength(1);
    expect((items[0] as { restrictedAudience: unknown }).restrictedAudience).toBeNull();
  });

  it('an anonymous `public`-floor page issues NO level read (nothing it could disclose)', async () => {
    seededVisibility = 'moderators';
    await cardFor('anonymous');
    const levelReads = dbMock.dbRead.$queryRaw.mock.calls.filter((c) => isVisibilityRead(c[0]));
    expect(levelReads).toHaveLength(0);
    // Positive control: a signed-in viewer on the SAME floor does read it (they may own a row).
    await cardFor('regular');
    expect(dbMock.dbRead.$queryRaw.mock.calls.filter((c) => isVisibilityRead(c[0]))).toHaveLength(
      1
    );
  });

  it('ANY other level-read fault renders no badge rather than failing the grid', async () => {
    seededVisibility = 'THROW_OTHER';
    expect(await cardFor('moderator')).toBeNull();
  });
});

describe('getListingPreviewForReview — the moderator preview', () => {
  it('carries the stored level, read from the PARENT for a shadow', async () => {
    seededVisibility = 'private';
    listing.findUnique.mockImplementation(async (args: unknown) => {
      const select = (args as { select?: Record<string, unknown> } | undefined)?.select ?? {};
      if ('sourceRepoUrl' in select) return { sourceRepoUrl: null };
      if ('isBeta' in select) return { isBeta: false, betaMessage: null };
      return row({ id: 'apl_ra_shadow_02', revisionOfId: LISTING_ID, status: 'draft' });
    });
    const res = await getListingPreviewForReview({ listingId: 'apl_ra_shadow_02' });
    expect(res?.card.restrictedAudience).toBe('private');
    expect(res?.detail.restrictedAudience).toBe('private');
    // The level read was keyed on the PARENT id, not the shadow's.
    const levelRead = dbMock.dbRead.$queryRaw.mock.calls
      .map((c) => c[0] as { sql: string; values: unknown[] })
      .find((s) => isVisibilityRead(s));
    expect(levelRead?.values).toEqual([LISTING_ID]);
  });
});
