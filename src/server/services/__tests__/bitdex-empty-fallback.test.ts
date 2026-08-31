import { beforeEach, describe, expect, it, vi } from 'vitest';

// A `null` return from the BitDex primary path is the signal to fall back to
// Meilisearch. That signal used to be suppressed for signed-in callers: the
// second ("own excluded") pass is only issued for an authenticated first-page
// request, and its mere EXISTENCE — not its result — was enough to skip the
// fallback. So when BitDex returned zero documents, anonymous visitors fell
// back and were served normally while signed-in users got an empty feed.
//
// These tests pin the fallback on the POST-MERGE result: fall back when the
// merged page is empty, keep serving when own-excluded content is the only
// content there is.
//
// Same minimal-seam mocking as bitdex-feed-source.test.ts: stub the
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

const CURRENT_USER_ID = 42;

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

const publicDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: 7,
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
  reactionCount: 0,
  commentCount: 0,
  collectedCount: 0,
  sortAt: 1_700_000_000,
  publishedAt: 1_700_000_000,
};

// The caller's OWN private image — exactly what the second pass exists to
// re-add. postId 55 is what the content-scope assertions key on.
const ownPrivateDoc = {
  ...publicDoc,
  id: 777,
  userId: CURRENT_USER_ID,
  availability: 'Private',
  postId: 55,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
const anonInput = (overrides: Record<string, unknown> = {}): any => ({
  ...baseInput,
  currentUserId: undefined,
  ...overrides,
});

describe('BitDex primary — empty result falls back to Meilisearch for every caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFliptVariantMock.mockResolvedValue('primary');
    serve({});
  });

  // INVARIANT GUARD — this is the arm that always worked. It is the control for
  // the regression below, not regression coverage itself.
  it('anonymous + zero BitDex documents → falls back to Meili', async () => {
    serve({ main: EMPTY_PAGE });

    const result = await getImagesFromSearch(anonInput());

    expect(result.source).toBe('meili');
    expect(result.data).toEqual([]);
  });

  // THE REGRESSION. Signed in, first page, own/global feed: the own-excluded
  // pass is issued, so before the fix its existence alone suppressed the
  // fallback and the caller was served an empty BitDex page.
  it('authenticated + zero BitDex documents + no own-excluded content → falls back to Meili', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: EMPTY_PAGE });

    const result = await getImagesFromSearch(authedInput());

    expect(result.source).toBe('meili');
    expect(result.data).toEqual([]);
  });

  // The case the naive fix (`if (!accumulated.length) return null` BEFORE the
  // merge) destroys: the main pass is empty but the caller does have their own
  // excluded content in scope, which is a legitimate non-empty page.
  it('authenticated + zero BitDex documents + own-excluded content in scope → serves it, no fallback', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) });

    const result = await getImagesFromSearch(authedInput());

    expect(result.source).toBe('bitdex');
    expect(result.data.map((d: { id: number }) => d.id)).toEqual([777]);
  });

  // INVARIANT GUARD — the ordinary serving path must be untouched.
  it('authenticated + BitDex returns documents → served by BitDex, no fallback', async () => {
    serve({ main: page([publicDoc]), ownExcluded: EMPTY_PAGE });

    const result = await getImagesFromSearch(authedInput());

    expect(result.source).toBe('bitdex');
    expect(result.data.map((d: { id: number }) => d.id)).toEqual([101]);
  });

  // Own-excluded content that does NOT survive the content-scope filters is not
  // content: the page is still empty and must still fall back. This is also the
  // negative arm of the content-scope positive control below.
  it('authenticated + own-excluded content filtered out by content scope → falls back to Meili', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) }); // doc has postId 55

    const result = await getImagesFromSearch(authedInput({ postId: 99 }));

    expect(result.source).toBe('meili');
    expect(result.data).toEqual([]);
  });

  // THE PAGINATED DECISION, REVERSED ON PURPOSE 2026-08-24 — read this before
  // "fixing" it back.
  //
  // This arm used to assert `source === 'meili'`, pinned by @ZacxDev on
  // 2026-08-14 (777845bab2) with the note "pinned so the decision is explicit".
  // That pin did its job: it is why this change is deliberate rather than
  // accidental. The decision was revisited by Justin on 2026-08-24 and changed,
  // and @ZacxDev was told before the diff landed.
  //
  // Why it changed: falling back handed the Meili path a `bdx:` cursor it cannot
  // parse. `getAllImagesIndex` splits cursors on `offset|entryTimestamp` behind
  // two `isNumber` guards, so a `bdx:` cursor degrades `offset` to 0 AND drops
  // the `entry` pin — the user's infinite scroll silently restarts at the top of
  // a feed reshuffled by anything published since. Falling back was never
  // landing them on "the same Meili page"; it was landing them on page 1.
  it('authenticated + paginated (bdx cursor) + zero documents, nothing failed → ends the feed', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) });

    const result = await getImagesFromSearch(
      authedInput({ cursor: 'bdx:{"sortAt":1700000000,"id":101}' })
    );

    // NOT 'meili'. Retrying cannot produce different content when nothing failed,
    // so the honest answer is that the feed is over.
    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
    // The own-excluded pass is first-page-only; proving it never ran is what
    // makes "the paginated arm is unchanged" a claim about the code and not
    // about the fake.
    expect(queryBitdexMock.mock.calls.filter((c) => isOwnExcludedQuery(c[1]))).toHaveLength(0);
  });

  // The other half of the split. An empty page whose query FAILED is not an empty
  // feed — nobody knows what was in the index — so it must not be reported as the
  // end of the feed, and must not fall back to Meili either.
  it('authenticated + paginated (bdx cursor) + a FAILED query → throws SERVICE_UNAVAILABLE', async () => {
    queryBitdexMock.mockImplementation(
      async (
        _index: string,
        _filters: unknown,
        _sort?: unknown,
        _limit?: number,
        _cursor?: unknown,
        _offset?: number,
        _includeDocs?: unknown,
        onFailure?: (reason: string) => void
      ) => {
        onFailure?.('http_error');
        return null;
      }
    );

    await expect(
      getImagesFromSearch(authedInput({ cursor: 'bdx:{"sortAt":1700000000,"id":101}' }))
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      // The message, not just the code: image.service.ts throws SERVICE_UNAVAILABLE
      // from five sites and the other four all say "overloaded". Matching the code
      // alone would let this pass on somebody else's throw.
      message: 'Image feed is temporarily unavailable — please retry.',
    });
  });

  // A MALFORMED `bdx:` cursor must be treated as cursored too. The decision turns
  // on what the caller sent, not on whether we could parse it: an unparseable
  // `bdx:` cursor is still meaningless to Meili, so routing it there degrades
  // offset to 0 exactly as a well-formed one would. Gating on the parsed value
  // instead of the prefix reopens the bug for this input, and nothing else in
  // this file would notice.
  it('authenticated + UNPARSEABLE bdx cursor + zero documents → ends the feed, does not fall back', async () => {
    // Both passes empty on purpose. An unparseable cursor still leaves
    // `skipOwnExcluded` false (that decision reads the PARSED cursor), so seeding
    // the own-excluded pass here would serve page-1 content and this test would
    // be asserting that behaviour rather than the fallback decision.
    serve({});

    const result = await getImagesFromSearch(authedInput({ cursor: 'bdx:{not valid json' }));

    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  // 🔴 TRUNCATION GUARD. An empty page whose cursor is STILL LIVE means the pass
  // budget ran out, not the index — `fetchBitdexPrimary`'s loop is bounded by
  // MAX_PASSES as well as by `!result.cursor`, and an ordinary filter can empty
  // every page it sees while more content sits behind the cursor. Ending the feed
  // there truncates it permanently, which is strictly worse than the page-1
  // restart this whole change exists to fix. Do not "simplify" the `liveCursor`
  // branch away: nothing else here would notice, and the metric would label the
  // truncated feed `cursored_end`, i.e. healthy.
  it('authenticated + paginated (bdx cursor) + empty page but a LIVE cursor → hands the cursor back, does not end the feed', async () => {
    // Every query succeeds and returns a FULL page with a cursor, but every
    // document belongs to another user and is Private, so postFilterBitdexDocs
    // removes all of them. The loop therefore exhausts MAX_PASSES with
    // `lastCursor` still live and `accumulated` empty.
    //
    // A page with ZERO documents would NOT reproduce this: the loop breaks on
    // `!result?.documents?.length` BEFORE assigning lastCursor, so that fake
    // tests a different path and this guard would pass for the wrong reason.
    // `Private` on ANOTHER user's doc, deliberately: postFilterBitdexDocs drops it
    // before `isPublicallyPublished` runs, so `publicationHolds` never moves and the
    // emptied-page allowance is never granted — every iteration charges the pass
    // budget. An UNPUBLISHED doc would also empty the page but would trip that
    // allowance, reaching this branch through a 1500ms wall-clock budget instead,
    // i.e. load-sensitive on CI. Do not swap the field.
    const othersPrivateDoc = { ...publicDoc, id: 900, userId: 7, availability: 'Private' };
    // Terminal after 5 pages. The service stops at MAX_PASSES (3), so the cap is
    // never reached and the assertions are unchanged — but a fake that paged
    // forever would turn a regression here into an unreportable hang instead of a
    // failure, which is what `no-unbounded-paging-fake` exists to prevent.
    let pagesServed = 0;
    queryBitdexMock.mockImplementation(async () => {
      pagesServed++;
      return {
        documents: [othersPrivateDoc],
        cursor: pagesServed >= 5 ? undefined : { sortAt: 1699999999, id: 99 },
      };
    });

    const result = await getImagesFromSearch(
      authedInput({ cursor: 'bdx:{"sortAt":1700000000,"id":101}' })
    );

    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
    // 🔴 Assert the cursor's IDENTITY, not merely that one came back. The fake's
    // cursor (1699999999/99) is deliberately different from the input cursor
    // (1700000000/101), so this dies to the plausible "simplification" of echoing
    // the INPUT cursor back — which `toBeDefined()` and `toContain('bdx:')` both
    // accept, and which ships an infinite client loop: same cursor in, empty page
    // and the same cursor out, forever. That is worse than the truncation this
    // branch fixes, because truncation at least terminates.
    //
    // It also pins that the skip path uses the SAME `bdx:${JSON.stringify(...)}`
    // encoding as the served path, which is a second copy of that wire format.
    expect(result.nextCursor).toBe('bdx:{"sortAt":1699999999,"id":99}');
    // The loop stopped on its own pass budget, well short of the fake's cap.
    expect(pagesServed).toBeLessThan(5);
  });

  // SCOPE CONTROL. The same failure on a FIRST page still falls back to Meili.
  //
  // The mutation this uniquely catches is HOISTING THE THROW OUT OF THE GATE:
  //     if (anyQueryFailed) throw new BitdexCursoredPageUnavailable();
  //     if (cursoredServe) return { data: [], nextCursor: liveCursor };
  // That 503s the whole feed whenever BitDex is briefly unhealthy, and this is the
  // only test in the file that dies to it. (Dropping the cursor condition instead
  // is already caught by the three first-page fallback tests above, so do not
  // justify this test by that mutation — it would read as redundant and get
  // deleted.)
  it('authenticated + FIRST page + a FAILED query → still falls back to Meili', async () => {
    // Counted, and asserted below. Asserting `source === 'meili'` alone would make
    // this a duplicate of the ordinary-empty-page test if `onFailure` ever stopped
    // being threaded through (an arg-order change in `queryBitdex`, or the
    // pre-filter dropping the param): the fake's `onFailure?.()` would silently
    // no-op, `anyQueryFailed` would stay false, and this test would keep passing
    // while no longer exercising a failure at all.
    let failuresSignalled = 0;
    queryBitdexMock.mockImplementation(
      async (
        _index: string,
        _filters: unknown,
        _sort?: unknown,
        _limit?: number,
        _cursor?: unknown,
        _offset?: number,
        _includeDocs?: unknown,
        onFailure?: (reason: string) => void
      ) => {
        failuresSignalled++;
        onFailure?.('http_error');
        return null;
      }
    );

    const result = await getImagesFromSearch(authedInput());

    expect(result.source).toBe('meili');
    expect(failuresSignalled).toBeGreaterThan(0);
  });
});

// A fake that ignores its arguments would make every assertion above vacuous.
describe('fake fidelity — the BitDex fake honours its inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFliptVariantMock.mockResolvedValue('primary');
    serve({});
  });

  it('routes the two passes apart: exactly one main query and one own-excluded query', async () => {
    serve({ main: page([publicDoc]), ownExcluded: page([ownPrivateDoc]) });

    await getImagesFromSearch(authedInput());

    expect(queryBitdexMock).toHaveBeenCalledTimes(2);

    const ownCalls = queryBitdexMock.mock.calls.filter((c) => isOwnExcludedQuery(c[1]));
    const mainCalls = queryBitdexMock.mock.calls.filter((c) => !isOwnExcludedQuery(c[1]));
    expect(ownCalls).toHaveLength(1);
    expect(mainCalls).toHaveLength(1);

    // Own-excluded pass: unscoped, fixed page size, no cursor and no offset.
    expect(ownCalls[0][3]).toBe(500);
    expect(ownCalls[0][4]).toBeUndefined();
    expect(ownCalls[0][5]).toBeUndefined();
    // Main pass: the caller's own limit.
    expect(mainCalls[0][3]).toBe(10);
  });

  it('issues no own-excluded query at all for an anonymous caller', async () => {
    serve({ main: page([publicDoc]) });

    await getImagesFromSearch(anonInput());

    expect(queryBitdexMock).toHaveBeenCalledTimes(1);
    expect(isOwnExcludedQuery(queryBitdexMock.mock.calls[0][1])).toBe(false);
  });

  it('the fake can return both empty and non-empty on the same pass', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) });
    const withContent = await getImagesFromSearch(authedInput());
    expect(withContent.data.map((d: { id: number }) => d.id)).toEqual([777]);

    serve({ main: EMPTY_PAGE, ownExcluded: EMPTY_PAGE });
    const withoutContent = await getImagesFromSearch(authedInput());
    expect(withoutContent.data).toEqual([]);
  });

  // Positive control for the content-scope filters: the SAME own-excluded doc
  // is kept under a matching scope and dropped under a non-matching one, so the
  // "filtered out" test above is testing the filter and not an empty fake.
  it('content-scope filters actually filter: same doc kept on a matching postId, dropped on another', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) }); // doc has postId 55

    const matching = await getImagesFromSearch(authedInput({ postId: 55 }));
    expect(matching.source).toBe('bitdex');
    expect(matching.data.map((d: { id: number }) => d.id)).toEqual([777]);

    const notMatching = await getImagesFromSearch(authedInput({ postId: 99 }));
    expect(notMatching.data.map((d: { id: number }) => d.id)).toEqual([]);
  });
});
