import { describe, it, expect, vi, beforeEach } from 'vitest';

// `publishedOnly` was honoured by the DB feed path and silently ignored by both
// Meilisearch filter builders, so a caller that cannot use an unpublished row
// still got the moderator's own-content carve-out
// (`publishedAtUnix <= now OR userId = me`). The remix-gallery submit picker is
// one such caller: it offered a moderator their own drafts, and the submit
// mutation refuses a draft, so every one of them was an invitation to a refusal.
//
// Asserted on the filter string handed to Meili rather than on returned rows,
// because that string IS the fix — the rows would come from a fake and could
// not tell a working filter from an absent one.
//
// Mock preamble mirrors search-error-log-pii.test.ts: the smallest set of stubs
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

const MODERATOR = 4321;

const baseInput = {
  // Deliberately no `userId`: that is a feed-by-creator search filter and emits
  // its own `userId = …` clause. Leaving it out makes any `userId` in the filter
  // unambiguously the own-content carve-out this test is about.
  currentUserId: MODERATOR,
  isModerator: true,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: [] as string[],
  headers: { src: 'test' },
};

// Both builders carry their own copy of the branch, and a fix applied to one
// leaves the other serving drafts on whichever path the flag routes to.
describe.each([
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
])('%s publication filter', (_name, fn) => {
  type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];

  // Only the publication clause. The filter carries a SECOND own-content
  // carve-out — own `nsfwLevel = 0` rows, which is about rating and not about
  // publication — and asserting against the whole string made this test fail on
  // that one instead, which would have read as the fix not working.
  const publicationClauseFor = async (input: Record<string, unknown>) => {
    await expect(fn(input as unknown as SearchArg)).rejects.toThrow('stop here');
    // Not just "called": an own-content pass runs in parallel, whose
    // whole job is to re-admit the caller's own excluded rows. If that shape ever
    // reaches a Meili builder, `calls[0]` becomes whichever fired first and both
    // cases below would move for the wrong reason.
    expect(fetchDocumentsAbortableMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
    const filter = String((request as { filter: string }).filter);
    const clause = filter.match(/\(publishedAtUnix <= \d+[^)]*\)/);
    // The clause is unconditional on this path, so its absence means the filter
    // moved and this test is now asserting about nothing.
    expect(clause, `no publication clause in: ${filter}`).not.toBeNull();
    return clause![0];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Thrown so the test stops at the seam it is about. The filter is built
    // before the call, so it is fully formed on the recorded arguments.
    fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));
  });

  it('drops the moderator own-content carve-out when the caller asked for published only', async () => {
    const clause = await publicationClauseFor({ ...baseInput, publishedOnly: true });

    expect(clause).not.toContain(`userId = ${MODERATOR}`);
  });

  it('still carves out own content for a moderator who did not ask', async () => {
    // The control. Without it the test above passes against a build that never
    // emits the carve-out at all — which would be a different bug (a moderator
    // losing sight of their own scheduled posts across every feed), not a fix.
    const clause = await publicationClauseFor(baseInput);

    expect(clause).toContain(`userId = ${MODERATOR}`);
  });
});
