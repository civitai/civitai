import { describe, it, expect, vi, beforeEach } from 'vitest';

// The `scheduled` owner carve-out in both Meilisearch filter builders was a bare
// `userId = me` with no publish predicate, so turning Scheduled on returned every
// unpublished row the caller owns — drafts, bounty entry uploads, orphans — and not
// just the scheduled ones (ClickUp 868kt9y1w). A user with 0 scheduled images got 6
// extra images, all in draft posts.
//
// Asserted on the filter string handed to Meili rather than on returned rows, for the
// same reason as image-search-published-only.test.ts: the string IS the fix, and rows
// from a fake cannot tell a working filter from an absent one.
//
// Mock preamble mirrors image-search-published-only.test.ts — the smallest set of stubs
// that lets image.service import without booting real infra.

import type * as MeilisearchClient from '~/server/meilisearch/client';

const { fetchDocumentsAbortableMock } = vi.hoisted(() => ({
  fetchDocumentsAbortableMock: vi.fn(),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});

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
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { getImagesFromSearchPreFilter, getImagesFromSearchPostFilter } from '../image.service';

const OWNER = 8675309;

const baseInput = {
  currentUserId: OWNER,
  isModerator: false,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: [] as string[],
  headers: { src: 'test' },
};

type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];

// Matches the publication clause whether or not the carve-out is nested, so the
// broken shape `(publishedAtUnix <= N OR userId = N)` is captured and reported
// rather than falling out as "no match" — an unreadable failure on revert.
const PUBLICATION_CLAUSE = /\(publishedAtUnix <= \d+(?: OR (?:\([^)]*\)|[^)]*))?\)/;

const publicationClauseFor = async (
  fn: typeof getImagesFromSearchPreFilter | typeof getImagesFromSearchPostFilter,
  input: Record<string, unknown>
) => {
  await expect(fn(input as unknown as SearchArg)).rejects.toThrow('stop here');
  // Not just "called": the BitDex path runs a parallel own-content pass, and if that
  // shape ever reaches a Meili builder `calls[0]` becomes whichever fired first.
  expect(fetchDocumentsAbortableMock).toHaveBeenCalledTimes(1);
  const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
  const filter = String((request as { filter: string }).filter);
  const clause = filter.match(PUBLICATION_CLAUSE);
  // Unconditional on every branch under test, so its absence means the filter moved
  // and this test is now asserting about nothing.
  expect(clause, `no publication clause in: ${filter}`).not.toBeNull();
  return clause![0];
};

// The snapped timestamp is read back off the clause rather than pinned with fake
// timers: the builders snap `Date.now()` to the minute themselves, and a test that
// recomputes it races the minute boundary.
const snappedNowIn = (clause: string) => {
  const match = clause.match(/publishedAtUnix <= (\d+)/);
  expect(match, `no snapped timestamp in: ${clause}`).not.toBeNull();
  return match![1];
};

beforeEach(() => {
  vi.clearAllMocks();
  // Thrown so the test stops at the seam it is about. The filter is fully formed on
  // the recorded arguments by then.
  fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));
});

// Three branches, three copies of this carve-out before the fix. Each is exercised
// separately because a fix applied to one leaves the others serving drafts on
// whichever path the caller reaches.
describe.each([
  [
    'getImagesFromSearchPreFilter, general feed',
    getImagesFromSearchPreFilter,
    {} as Record<string, unknown>,
  ],
  [
    'getImagesFromSearchPostFilter, general feed',
    getImagesFromSearchPostFilter,
    {} as Record<string, unknown>,
  ],
  [
    // `userId === currentUserId` is the own-profile branch, which exists only in the
    // post-filter builder and is the surface the bug was reported on.
    'getImagesFromSearchPostFilter, own profile',
    getImagesFromSearchPostFilter,
    { userId: OWNER } as Record<string, unknown>,
  ],
])('%s scheduled owner carve-out', (_name, fn, extraInput) => {
  it('carves out only own content whose publish date is still in the future', async () => {
    const clause = await publicationClauseFor(fn, {
      ...baseInput,
      ...extraInput,
      scheduled: true,
    });
    const snappedNow = snappedNowIn(clause);

    expect(clause).toBe(
      `(publishedAtUnix <= ${snappedNow} OR (userId = ${OWNER} AND publishedAtUnix > ${snappedNow}))`
    );
  });

  it('does not carve out own content at all without the scheduled opt-in', async () => {
    // The control. Without it the assertion above passes against a build that emits
    // no carve-out on any input, which would be a different bug — an owner losing
    // sight of their own scheduled posts entirely — rather than this fix.
    const clause = await publicationClauseFor(fn, { ...baseInput, ...extraInput });
    const snappedNow = snappedNowIn(clause);

    expect(clause).toBe(`(publishedAtUnix <= ${snappedNow})`);
  });
});
