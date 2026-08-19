import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3929 — own-excluded images appearing on ANOTHER creator's feed when the
// caller addresses that creator by `username` instead of `userId`.
//
// `fetchBitdexPrimary` decides whether to run the "own excluded" second pass
// from `input.userId`. When the request names the creator by handle, that field
// is empty at the point the decision is made — the handle used to be resolved
// later and locally, inside `getImagesFromBitdexPreFilter` — so the "viewing
// someone else's profile" guard read `undefined`, did not fire, and the
// caller's own private/blocked/nsfw0 content was merged into a feed it does not
// belong to.
//
// Not a cross-user exposure: every document involved belongs to the caller. The
// defect is feed integrity — the feed misrepresents what that creator posted.
//
// Same minimal-seam mocking as bitdex-empty-fallback.test.ts: stub the
// event-engine-common submodule + infra clients + env so importing
// image.service doesn't boot real infra, and null out the Meili client so the
// Meili leg still RUNS (and still stamps source 'meili') without a live index.

import type * as BitdexClient from '~/server/bitdex/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';

const { queryBitdexMock, getFliptVariantMock } = vi.hoisted(() => ({
  queryBitdexMock: vi.fn(),
  getFliptVariantMock: vi.fn(),
}));

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: null,
}));

vi.mock('~/server/bitdex/client', async (importOriginal) => ({
  ...(await importOriginal<typeof BitdexClient>()),
  queryBitdex: queryBitdexMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: getFliptVariantMock,
  getFliptBoolean: vi.fn().mockResolvedValue(false),
}));

import { getImagesFromSearch } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

// Pairwise distinct, none of them a default. A fixture whose ids collide would
// let a mutant that reads the wrong field produce the right answer by accident.
const CURRENT_USER_ID = 42;
const OTHER_CREATOR_ID = 7;
const THIRD_PARTY_ID = 13;

const OTHER_CREATOR_USERNAME = 'some-other-creator';
const CALLER_USERNAME = 'the-caller-themselves';
const MISSING_USERNAME = 'no-such-handle';

/**
 * Both BitDex passes go through the same `queryBitdex`, so the fake has to tell
 * them apart from its arguments or it would answer the same thing to both and
 * every assertion below would be meaningless.
 *
 * The main pass filters availability with `Not(Eq(availability, Private))`; the
 * own-excluded pass asks for the opposite inside an `Or`. Keying on that `Or`
 * distinguishes them structurally rather than by position or call order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw BitDex filter clauses
type Clause = any;
function isOwnExcludedQuery(filters: unknown): boolean {
  if (!Array.isArray(filters)) return false;
  return filters.some(
    (clause: Clause) =>
      Array.isArray(clause?.Or) &&
      clause.Or.some(
        (member: Clause) =>
          Array.isArray(member?.Eq) &&
          member.Eq[0] === 'availability' &&
          member.Eq[1]?.String === 'Private'
      )
  );
}

const ownExcludedCalls = () => queryBitdexMock.mock.calls.filter((c) => isOwnExcludedQuery(c[1]));
const mainCalls = () => queryBitdexMock.mock.calls.filter((c) => !isOwnExcludedQuery(c[1]));

/** The other creator's ordinary published image — what the feed SHOULD contain. */
const otherCreatorPublicDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: OTHER_CREATOR_ID,
  type: 'image',
  availability: 'Public',
  postId: 55,
  postedToId: null,
  hasMeta: true,
  onSite: true,
  poi: false,
  minor: false,
  width: 100,
  height: 100,
  reactionCount: 3,
  commentCount: 2,
  collectedCount: 1,
  sortAt: 1_700_000_000,
  publishedAt: 1_700_000_000,
};

/**
 * The CALLER's own private image — exactly what the second pass exists to
 * re-add on the caller's own views, and exactly what must not appear on
 * someone else's.
 */
const callerOwnPrivateDoc = {
  ...otherCreatorPublicDoc,
  id: 777,
  userId: CURRENT_USER_ID,
  availability: 'Private',
  postId: 61,
  reactionCount: 9,
  commentCount: 8,
  collectedCount: 7,
};

/**
 * A private document belonging to NEITHER the caller nor the creator in view.
 * In production the own-excluded query pins `userId = currentUserId`, so BitDex
 * cannot return this; the fake returns it anyway to prove the merge's creator
 * scope is a live, reachable filter rather than a clause that never executes.
 */
const thirdPartyPrivateDoc = {
  ...otherCreatorPublicDoc,
  id: 909,
  userId: THIRD_PARTY_ID,
  availability: 'Private',
  postId: 73,
  reactionCount: 5,
  commentCount: 4,
  collectedCount: 6,
};

const EMPTY_PAGE = { documents: [], cursor: undefined };

/**
 * `cursor: undefined` terminates fetchBitdexPrimary's pass loop on the first
 * iteration. A fake that always returned a cursor would spin to MAX_PASSES.
 */
function page(documents: Record<string, unknown>[]) {
  return { documents, cursor: undefined };
}

/** Route each call to the pass it belongs to. */
function serve({
  main = EMPTY_PAGE,
  ownExcluded = EMPTY_PAGE,
}: {
  main?: { documents: Record<string, unknown>[]; cursor: undefined };
  ownExcluded?: { documents: Record<string, unknown>[]; cursor: undefined };
}) {
  queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
    isOwnExcludedQuery(filters) ? ownExcluded : main
  );
}

/**
 * Drive the resolution from DATA, not from a pre-set `userId`: the handle→id
 * lookup is the seam under test, so the test says which handles exist and lets
 * the code decide when to consult that.
 */
function usernamesResolveTo(table: Record<string, number>) {
  dbMock.dbRead.user.findUnique.mockImplementation(
    async ({ where }: { where: { username?: string } }) => {
      const id = where?.username != null ? table[where.username] : undefined;
      return id === undefined ? null : { id };
    }
  );
  dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
}

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
} as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
const authedInput = (overrides: Record<string, unknown> = {}): any => ({
  ...baseInput,
  currentUserId: CURRENT_USER_ID,
  ...overrides,
});

const ids = (data: { id: number }[]) => data.map((d) => d.id);

beforeEach(() => {
  vi.clearAllMocks();
  getFliptVariantMock.mockResolvedValue('primary');
  usernamesResolveTo({
    [OTHER_CREATOR_USERNAME]: OTHER_CREATOR_ID,
    [CALLER_USERNAME]: CURRENT_USER_ID,
  });
  serve({});
});

describe('#3929 — a username-addressed creator feed is scoped before the own-excluded decision', () => {
  // THE REGRESSION. Signed in, first page, another creator addressed by HANDLE.
  // Before the fix `skipOwnExcluded` read an unresolved `input.userId`, the
  // second pass ran, and the caller's own private image was served as the whole
  // of that creator's feed.
  it("authenticated + another creator by username + empty main pass → no own-excluded pass, and the caller's own private image is not served", async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ username: OTHER_CREATOR_USERNAME }));

    // Proving the pass never ran is what makes this a claim about the guard
    // rather than about a filter downstream of it.
    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([]);
    expect(result.source).toBe('meili');
  });

  // The same defect with the main pass NON-empty: before the fix the caller's
  // private image was interleaved into a real creator feed rather than being
  // the whole of it, which is the shape a reader would actually meet.
  it('authenticated + another creator by username + non-empty main pass → serves only that creator, no injected own content', async () => {
    serve({ main: page([otherCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ username: OTHER_CREATOR_USERNAME }));

    expect(result.source).toBe('bitdex');
    expect(ids(result.data)).toEqual([101]);
    expect(ownExcludedCalls()).toHaveLength(0);
  });

  // An unresolvable handle names no view at all, so there is nothing for the
  // own-excluded pass to be scoped to. Before the fix it was issued anyway and
  // — because the main pass declined while the second pass had already
  // answered — BitDex SERVED the caller their own private image under a
  // creator who does not exist, never reaching the Meili leg at all.
  //
  // The NotFound the Meili leg raises for a bad handle is not observable here:
  // `metricsSearchClient` is nulled so that leg returns an empty page instead
  // of searching. What is asserted is what this function decides — decline,
  // hand off, and issue no second pass.
  it('authenticated + a username that resolves to nothing → no own-excluded pass, nothing served by BitDex', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ username: MISSING_USERNAME }));

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(result.source).toBe('meili');
    expect(ids(result.data)).toEqual([]);
  });

  // The other direction: the fix must not over-block. A caller viewing their
  // OWN profile by handle still gets their excluded content back.
  it('authenticated + own profile by username → own-excluded pass runs and its content is served', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ username: CALLER_USERNAME }));

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(result.source).toBe('bitdex');
    expect(ids(result.data)).toEqual([777]);
  });
});

describe('#3929 — userId/username precedence and normalisation', () => {
  // INVARIANT GUARDS — these already held. `userId` wins over a disagreeing
  // `username` at every resolution site in image.service, and the new one has
  // to spell the precedence the same way or the two forms of the same request
  // would address different creators.
  it('userId and a disagreeing username → userId wins (another creator: no own-excluded pass)', async () => {
    serve({ main: page([otherCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(
      // CALLER_USERNAME resolves to the caller; userId names someone else.
      authedInput({ userId: OTHER_CREATOR_ID, username: CALLER_USERNAME })
    );

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([101]);
  });

  it('userId and a disagreeing username → userId wins (own feed: own-excluded pass runs)', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(
      // OTHER_CREATOR_USERNAME resolves to someone else; userId names the caller.
      authedInput({ userId: CURRENT_USER_ID, username: OTHER_CREATOR_USERNAME })
    );

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(ids(result.data)).toEqual([777]);
  });

  // INVARIANT GUARD. The handle is looked up verbatim — no lowercasing, no
  // trimming — so whatever the column's collation already decides about case
  // keeps deciding it, and the BitDex and Meili legs cannot disagree about
  // which account a handle names.
  it('the handle reaches the lookup byte-for-byte, uncased and untrimmed', async () => {
    const MIXED = '  SoMe-Other-Creator  ';
    usernamesResolveTo({ [MIXED]: OTHER_CREATOR_ID });
    serve({ main: page([otherCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    await getImagesFromSearch(authedInput({ username: MIXED }));

    expect(dbMock.dbRead.user.findUnique).toHaveBeenCalledWith({
      where: { username: MIXED },
      select: { id: true },
    });
  });
});

describe('#3929 — the merge constrains own-excluded docs to the creator in view', () => {
  // STRUCTURAL GUARD, not regression coverage: with the resolution fix in
  // place the upstream guard already refuses to issue the pass for another
  // creator, so no live caller can reach this filter. It exists so the
  // constraint holds where the documents are ADDED to the page, not only where
  // the decision to fetch them was made — the exact separation #3929 broke.
  //
  // Reached here by having the fake return a document the production query
  // could not: proving the clause EXECUTES, rather than that it compiles.
  it('drops a merged document whose creator is not the creator being viewed', async () => {
    serve({
      main: page([otherCreatorPublicDoc]),
      ownExcluded: page([callerOwnPrivateDoc, thirdPartyPrivateDoc]),
    });

    // Own feed by id: the pass IS issued, so the merge actually runs.
    const result = await getImagesFromSearch(authedInput({ userId: CURRENT_USER_ID }));

    expect(ownExcludedCalls()).toHaveLength(1);
    // 777 is the caller's own and the view is the caller's own feed → kept.
    // 909 belongs to a third party → dropped by the creator scope.
    expect(ids(result.data)).toEqual(expect.arrayContaining([777]));
    expect(ids(result.data)).not.toContain(909);
  });

  // Positive control for the guard above: with NO creator scope on the request
  // the same third-party document is not dropped, so the assertion above is
  // testing the filter and not a fake that never returned the document.
  it('positive control: with no creator scope on the request the same document survives the merge', async () => {
    serve({
      main: page([otherCreatorPublicDoc]),
      ownExcluded: page([callerOwnPrivateDoc, thirdPartyPrivateDoc]),
    });

    const result = await getImagesFromSearch(authedInput());

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(ids(result.data)).toEqual(expect.arrayContaining([777, 909]));
  });
});

// A fake that ignores its arguments, or a username table nothing consults,
// would make every assertion above vacuous.
describe('#3929 — fake fidelity', () => {
  it('the username table is consulted, and a different handle yields a different creator', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    // Resolves to the caller → pass issued.
    const own = await getImagesFromSearch(authedInput({ username: CALLER_USERNAME }));
    expect(ids(own.data)).toEqual([777]);

    vi.clearAllMocks();
    usernamesResolveTo({
      [OTHER_CREATOR_USERNAME]: OTHER_CREATOR_ID,
      [CALLER_USERNAME]: CURRENT_USER_ID,
    });
    getFliptVariantMock.mockResolvedValue('primary');
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    // Same fake, same documents, only the handle differs → pass withheld.
    const other = await getImagesFromSearch(authedInput({ username: OTHER_CREATOR_USERNAME }));
    expect(ids(other.data)).toEqual([]);
  });

  it('the main pass still runs for a username-addressed feed', async () => {
    serve({ main: page([otherCreatorPublicDoc]) });

    await getImagesFromSearch(authedInput({ username: OTHER_CREATOR_USERNAME }));

    expect(mainCalls().length).toBeGreaterThan(0);
  });
});
