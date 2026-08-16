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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(async () => undefined),
  safeError: (e: unknown) => e,
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
vi.mock('~/server/redis/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential key proxy
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {
      get: vi.fn().mockResolvedValue('[]'),
      set: vi.fn().mockResolvedValue(undefined),
      packed: { get: vi.fn(), set: vi.fn() },
    },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

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

  // INVARIANT GUARD + the paginated decision: a subsequent page never issues the
  // own-excluded pass, so an empty page already returned the fallback signal
  // before this change and still does. Pinned so the decision is explicit.
  it('authenticated + paginated (bdx cursor) + zero documents → falls back to Meili, no own-excluded pass', async () => {
    serve({ main: EMPTY_PAGE, ownExcluded: page([ownPrivateDoc]) });

    const result = await getImagesFromSearch(
      authedInput({ cursor: 'bdx:{"sortAt":1700000000,"id":101}' })
    );

    expect(result.source).toBe('meili');
    expect(result.data).toEqual([]);
    // The own-excluded pass is first-page-only; proving it never ran is what
    // makes "the paginated arm is unchanged" a claim about the code and not
    // about the fake.
    expect(queryBitdexMock.mock.calls.filter((c) => isOwnExcludedQuery(c[1]))).toHaveLength(0);
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
