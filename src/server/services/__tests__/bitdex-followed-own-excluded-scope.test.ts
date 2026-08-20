import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4123 — own-excluded images appearing in the FOLLOWING feed.
//
// Same class as #3929 (`username`), and deliberately NOT fixed by #4122: that
// change resolves a single `username` into a single `userId` before
// `fetchBitdexPrimary` decides whether to run the "own excluded" second pass.
// A Following feed has no `userId` at all — its creator scope is a SET, resolved
// later and locally inside `getImagesFromBitdexPreFilter`. So the `userId`-shaped
// guard reads `undefined`, does not fire, the second pass runs, and the caller's
// own private/blocked/nsfw0 content is merged into a feed that is supposed to
// show the people they follow.
//
// Both halves of #4122 are structurally unable to reach this shape: its guard
// takes one id, and the merge's content-scope filter scopes to one creator.
//
// Not a cross-user exposure — every document involved belongs to the caller. The
// defect is feed integrity. Reach is WIDER than #3929's, because Following is a
// primary browsing surface rather than a `username`-addressed request.
//
// Same minimal-seam mocking as bitdex-username-own-excluded-scope.test.ts.

import type * as BitdexClient from '~/server/bitdex/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as Caches from '~/server/redis/caches';
import type * as NewCreators from '~/server/services/new-creators.service';

const { queryBitdexMock, getFliptVariantMock, getUserFollowsMock, getNewCreatorUserIdsMock } =
  vi.hoisted(() => ({
    queryBitdexMock: vi.fn(),
    getFliptVariantMock: vi.fn(),
    getUserFollowsMock: vi.fn(),
    getNewCreatorUserIdsMock: vi.fn(),
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

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  getUserFollows: getUserFollowsMock,
}));

vi.mock('~/server/services/new-creators.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewCreators>()),
  getNewCreatorUserIds: getNewCreatorUserIdsMock,
}));

import { getImagesFromSearch } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

// Pairwise distinct, and none equal to a threshold, a default, or an array
// length used anywhere below — a fixture whose ids collide would let a mutant
// that reads the wrong field produce the right answer by accident.
const CURRENT_USER_ID = 42;
const FOLLOWED_CREATOR_ID = 7;
const NEW_CREATOR_ID = 23;
const THIRD_PARTY_ID = 13;

/**
 * Both BitDex passes go through the same `queryBitdex`, so the fake tells them
 * apart from their arguments — structurally, via the `Or` that only the
 * own-excluded pass builds, not by call order or position.
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

/** A followed creator's ordinary published image — what the feed SHOULD contain. */
const followedCreatorPublicDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: FOLLOWED_CREATOR_ID,
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
 * The CALLER's own private image — exactly what the second pass exists to re-add
 * on the caller's own views, and exactly what must not appear in a feed scoped
 * to other people.
 */
const callerOwnPrivateDoc = {
  ...followedCreatorPublicDoc,
  id: 777,
  userId: CURRENT_USER_ID,
  availability: 'Private',
  postId: 61,
  reactionCount: 9,
  commentCount: 8,
  collectedCount: 7,
};

/** A new-and-upcoming creator's published image. */
const newCreatorPublicDoc = {
  ...followedCreatorPublicDoc,
  id: 303,
  userId: NEW_CREATOR_ID,
  postId: 88,
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
 * 🔴 Sets BOTH sources of the followed set, because there are two and they are
 * not the same code path: `fetchBitdexPrimary` reads the cached
 * `getUserFollows`, while `getImagesFromBitdexPreFilter` issues its own raw
 * `dbRead.userEngagement.findMany` on every pass. A fixture that set only one
 * would leave whichever half it missed answering `undefined`/`[]`, and a test
 * could then pass for a reason unrelated to the guard under test.
 */
function callerFollows(targetUserIds: number[]) {
  getUserFollowsMock.mockResolvedValue(targetUserIds);
  dbMock.dbRead.userEngagement.findMany.mockResolvedValue(
    targetUserIds.map((targetUserId) => ({ targetUserId }))
  );
}

function newCreatorsAre(userIds: number[]) {
  getNewCreatorUserIdsMock.mockResolvedValue(userIds);
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
  callerFollows([FOLLOWED_CREATOR_ID]);
  newCreatorsAre([NEW_CREATOR_ID]);
  dbMock.dbRead.user.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
  serve({});
});

describe('#4123 — a set-shaped creator scope is resolved before the own-excluded decision', () => {
  // THE REGRESSION. Signed in, first page, Following feed, caller does not
  // follow themselves. Before the fix `skipOwnExcluded` inspected only
  // `input.userId` — absent here — so the second pass ran and the caller's own
  // private image was served as the whole of their Following feed.
  it("authenticated + followed feed + empty main pass → no own-excluded pass, and the caller's own private image is not served", async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ followed: true }));

    // Proving the pass never RAN is what makes this a claim about the guard
    // rather than about some filter downstream of it.
    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([]);
    expect(result.source).toBe('meili');
  });

  // The same defect with a NON-empty main pass: before the fix the caller's own
  // private image was interleaved into a real Following feed rather than being
  // the whole of it, which is the shape a reader would actually meet.
  it('authenticated + followed feed + non-empty main pass → serves only followed creators, no injected own content', async () => {
    serve({
      main: page([followedCreatorPublicDoc]),
      ownExcluded: page([callerOwnPrivateDoc]),
    });

    const result = await getImagesFromSearch(authedInput({ followed: true }));

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([followedCreatorPublicDoc.id]);
    expect(ids(result.data)).not.toContain(callerOwnPrivateDoc.id);
    expect(result.source).toBe('bitdex');
  });

  // `newCreators` was called out in #4123 as "looks identical by inspection,
  // NOT probed". This is the probe: it is the same set-shaped scope, resolved in
  // the same place, and it must behave the same way.
  it('authenticated + newCreators feed + the caller is not a new creator → no own-excluded pass', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ newCreators: true }));

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([]);
  });

  it('authenticated + newCreators feed + non-empty main pass → serves only new creators', async () => {
    serve({ main: page([newCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ newCreators: true }));

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).toEqual([newCreatorPublicDoc.id]);
  });

  // 🔴 THE OTHER DIRECTION. An assertion that only checks ABSENCE is walked by a
  // mutant that deletes the pass outright; these two require it to still RUN
  // where it legitimately belongs, so a blanket "never run the second pass on a
  // scoped feed" fix fails here.
  //
  // Self-follow is the reachable case: `toggleFollowUser` creates
  // `{ userId, targetUserId }` with no `userId !== targetUserId` guard, so a
  // caller CAN be inside their own followed set. That is why the fix tests set
  // MEMBERSHIP rather than assuming a Following feed never contains the caller.
  it('positive control: the caller follows THEMSELVES → the own-excluded pass runs and its content is served', async () => {
    callerFollows([FOLLOWED_CREATOR_ID, CURRENT_USER_ID]);
    serve({
      main: page([followedCreatorPublicDoc]),
      ownExcluded: page([callerOwnPrivateDoc]),
    });

    const result = await getImagesFromSearch(authedInput({ followed: true }));

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(ids(result.data)).toContain(callerOwnPrivateDoc.id);
  });

  it('positive control: the caller IS a new creator → the own-excluded pass runs', async () => {
    newCreatorsAre([NEW_CREATOR_ID, CURRENT_USER_ID]);
    serve({ main: page([newCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ newCreators: true }));

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(ids(result.data)).toContain(callerOwnPrivateDoc.id);
  });

  // The guard must be SCOPED, not blanket. With no creator scope at all the
  // second pass is the whole point of the feature and must still run — this is
  // what fails if someone "fixes" #4123 by disabling the pass more broadly.
  it('positive control: an unscoped feed still runs the own-excluded pass', async () => {
    serve({ main: page([followedCreatorPublicDoc]), ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput());

    expect(ownExcludedCalls()).toHaveLength(1);
    expect(ids(result.data)).toContain(callerOwnPrivateDoc.id);
  });

  // The main pass must be unaffected — a fix that suppressed the whole BitDex
  // leg on a Following feed would satisfy every absence assertion above.
  it('the main pass still runs for a followed feed', async () => {
    serve({ main: page([followedCreatorPublicDoc]) });

    await getImagesFromSearch(authedInput({ followed: true }));

    expect(mainCalls().length).toBeGreaterThan(0);
  });

  // Following-with-zero-follows is one of the pre-filter's five early `return
  // null` doors. It must not become a route by which the own pass serves the
  // caller their own content — and, per #3930's counter, it is also the shape
  // that records `fallback_empty` while a call did go out.
  it('followed feed with ZERO follows → BitDex declines and serves nothing of the caller’s own', async () => {
    callerFollows([]);
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput({ followed: true }));

    expect(ids(result.data)).not.toContain(callerOwnPrivateDoc.id);
    expect(result.source).toBe('meili');
  });

  // An anonymous caller has no own content to re-add; the pass must never run.
  // Cheap, and it pins the disjunct #4122 did not touch.
  it('anonymous + followed feed → no own-excluded pass', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    await getImagesFromSearch({ ...baseInput, followed: true });

    expect(ownExcludedCalls()).toHaveLength(0);
  });

  // 🔴 THE COUPLING IS THE CORRECTNESS ARGUMENT, SO PIN THE ARGUMENTS TOO.
  //
  // The guard is only right if it reads the SAME creator scope the pre-filter
  // filters by. Asserting that the helpers were CALLED does not establish that —
  // the arguments select which set comes back. Three mutants survived the first
  // battery precisely here: dropping `domain`, swapping `entity` to `'models'`,
  // and resolving follows for `input.userId` instead of `input.currentUserId`.
  // Each produces a well-formed set from the WRONG source and re-admits #4123.
  //
  // ⚠️ `domain` must be NON-UNDEFINED in this fixture. `toHaveBeenCalledWith` uses
  // deep equality, under which `{ entity, domain: undefined }` and `{ entity }`
  // compare EQUAL — so a fixture leaving `domain` unset could never catch the
  // dropped-`domain` mutant. `'red'` is chosen because it maps to a different
  // board (`images-new-red`) than the default, which is exactly the desync.
  it('reads the new-creator board with the request’s OWN entity and domain', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    await getImagesFromSearch(authedInput({ newCreators: true, domain: 'red' }));

    // 🔴 EVERY call, not `toHaveBeenCalledWith`. That matcher passes if ANY call
    // matched, and the pre-filter makes its own correct call to this same helper
    // — so it is satisfied by the pre-filter no matter what the guard passed.
    // Measured: with `toHaveBeenCalledWith`, mutants that drop `domain` or swap
    // `entity` to 'models' BOTH survived a fully green suite.
    expect(getNewCreatorUserIdsMock.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of getNewCreatorUserIdsMock.mock.calls) {
      expect(args).toEqual({ entity: 'images', domain: 'red' });
    }
  });

  // Resolves follows for the CALLER, never for the creator being viewed. Both
  // fields are set and they disagree, so a mutant reading the wrong one returns a
  // different set rather than the same one by luck.
  it('resolves the followed set for the CALLER, not for the userId being viewed', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    await getImagesFromSearch(
      authedInput({ followed: true, userId: FOLLOWED_CREATOR_ID })
    );

    expect(getUserFollowsMock).toHaveBeenCalledWith(CURRENT_USER_ID);
    expect(getUserFollowsMock).not.toHaveBeenCalledWith(FOLLOWED_CREATOR_ID);
  });

  // 🔴 `some` vs `every`, pinned by a request carrying TWO simultaneous non-null
  // scopes that DISAGREE — the only shape that can tell them apart. Every other
  // case here supplies one scope plus nulls, where `every` fails on the nulls
  // rather than on the intersection semantics, so it would die for the wrong
  // reason. Here the caller IS the userId in view (scope contains them) but does
  // NOT self-follow (scope excludes them). The pre-filter ANDs both filters, so
  // exclusion by either one excludes the caller from the feed: `some` is correct
  // and must skip the pass; `every` would run it.
  it('two disagreeing scopes: exclusion by EITHER one skips the own-excluded pass', async () => {
    callerFollows([FOLLOWED_CREATOR_ID]); // caller not in their own followed set
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    const result = await getImagesFromSearch(
      authedInput({ followed: true, userId: CURRENT_USER_ID })
    );

    expect(ownExcludedCalls()).toHaveLength(0);
    expect(ids(result.data)).not.toContain(callerOwnPrivateDoc.id);
  });

  // The cheap disjuncts must SHORT-CIRCUIT the scope resolution, not merely
  // out-vote it: without the hoist these shapes pay a lookup whose result is then
  // discarded, and every behavioural test still passes — so this asserts the CALL,
  // not the outcome.
  //
  // ⚠️ The expected count is ONE, not zero, and that is not a fudge: the request
  // falls through to the Meili leg, which resolves the same scope for its own
  // filtering. The BitDex guard's call would be a SECOND one. Verified by
  // mutation: removing the hoist takes this count 1 -> 2.
  //
  // 🔴 A SIBLING ASSERTION FOR THE `bdx:`-CURSOR SHAPE WAS WRITTEN AND THEN
  // DELETED, because the mutation showed it could not fail: with the hoist removed
  // it still read 1. The likeliest cause is that its hand-written `bdx:` cursor
  // fixture did not decode, so `bitdexCursor` was falsy and the request never had
  // the property the test was named for. Rather than ship an assertion that passes
  // in both arms, the `bitdexCursor` half of the short-circuit is left argued from
  // the code (it is the same `skipOwnExcludedCheaply` expression this case pins
  // via `!input.currentUserId`) and is NOT claimed as tested.
  it('an anonymous newCreators feed adds no creator-scope lookup of its own', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([callerOwnPrivateDoc]) });

    await getImagesFromSearch({ ...baseInput, newCreators: true });

    expect(getNewCreatorUserIdsMock).toHaveBeenCalledTimes(1);
  });

  // A third creator's private document is not reachable in production (the own
  // pass pins `userId = currentUserId`), but the fake returns it to prove the
  // decision is about SCOPE MEMBERSHIP and not about "is this document mine".
  it('a followed feed does not serve a private document belonging to someone else', async () => {
    serve({
      main: page([followedCreatorPublicDoc]),
      ownExcluded: page([{ ...callerOwnPrivateDoc, id: 909, userId: THIRD_PARTY_ID }]),
    });

    const result = await getImagesFromSearch(authedInput({ followed: true }));

    expect(ids(result.data)).not.toContain(909);
  });
});
