import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';

const { queryWithTimeoutMock } = vi.hoisted(() => ({ queryWithTimeoutMock: vi.fn() }));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: queryWithTimeoutMock };
});
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return { ...actual, metricsSearchClient: {}, getMetricsSearchClient: () => ({}) };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import { getAllImages } from '../image.service';
import { feedHydrateQuery } from '../feed-primary.service';

const squash = (sql: string) => sql.replace(/\s+/g, ' ');
const MARCH_2025 = { start: new Date(Date.UTC(2025, 2, 1)), end: new Date(Date.UTC(2025, 3, 1)) };
const creatorFeed = {
  userId: 7,
  jumpTo: '2025-03',
  limit: 20,
  period: 'AllTime',
  periodMode: 'published',
  browsingLevel: 1,
  include: [],
  user: { id: 1, isModerator: false },
};

async function issued(input: Record<string, unknown>) {
  await getAllImages(input as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  const query = queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  return { text: squash(query.text), values: query.values };
}

// The id the subquery resolves bounds the page; the createdAt it compares is the month edge.
const JUMP =
  /i\."id" (<=|>=) \( SELECT j\.id FROM "Image" j WHERE j\."userId" = \$(\d+) AND j\."createdAt" (<|>=) \$(\d+) ORDER BY j\."createdAt" (DESC|ASC) LIMIT 1 \)/;
const jumpIn = ({ text, values }: { text: string; values: unknown[] }) => {
  const m = JUMP.exec(text);
  if (!m) return undefined;
  return {
    id: m[1],
    userId: values[Number(m[2]) - 1],
    createdAt: m[3],
    edge: values[Number(m[4]) - 1],
    order: m[5],
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe('getAllImages jump to month', () => {
  it('starts Newest at the creator image just before the month ends', async () => {
    expect(jumpIn(await issued({ ...creatorFeed, sort: 'Newest' }))).toEqual({
      id: '<=',
      userId: 7,
      createdAt: '<',
      edge: MARCH_2025.end,
      order: 'DESC',
    });
  });

  it('starts Oldest at the creator image the month opens with', async () => {
    expect(jumpIn(await issued({ ...creatorFeed, sort: 'Oldest' }))).toEqual({
      id: '>=',
      userId: 7,
      createdAt: '>=',
      edge: MARCH_2025.start,
      order: 'ASC',
    });
  });

  it('ignores the jump for a sort with no place in time, or with no creator', async () => {
    expect(jumpIn(await issued({ ...creatorFeed, sort: 'Most Reactions' }))).toBeUndefined();
    vi.clearAllMocks();
    queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
    expect(
      jumpIn(await issued({ ...creatorFeed, sort: 'Newest', userId: undefined }))
    ).toBeUndefined();
  });

  // The feed bounds the month on sortAt. An Oldest page holds images created before the month
  // and published in it, which a createdAt bound in the hydrate would drop from the page.
  it('is not re-applied when hydrating a page the feed already placed', async () => {
    const hydrate = feedHydrateQuery({ ...creatorFeed, sort: 'Oldest' }, [11, 12]);
    expect(jumpIn(await issued(hydrate))).toBeUndefined();
  });
});
