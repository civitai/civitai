import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';

// A collection review reads its submissions as the reviewer: the normal read's filters, plus the
// collection's unrated REVIEW and REJECTED images. Mock recipe follows image-feed-blocked-for.test.ts.

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

const REVIEWER = 10;
const COLLECTION = 7;

async function statementFor(
  viewer: { id: number; isModerator?: boolean },
  extra: { pending?: boolean; reviewCollectionId?: number }
) {
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'stats',
    sort: 'Newest',
    browsingLevel: 31,
    include: [],
    ids: [5],
    user: { isModerator: false, ...viewer },
    ...extra,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  return queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
}

const REVIEW_ARM = /rci\."collectionId" = \$(\d+)/;

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe("a collection review's image read", () => {
  it("adds the collection's unrated submissions, bound to that collection", async () => {
    const stmt = await statementFor(
      { id: REVIEWER },
      { pending: true, reviewCollectionId: COLLECTION }
    );
    const match = stmt.text.match(REVIEW_ARM);
    expect(match, 'no review arm in the read').not.toBeNull();
    expect(stmt.values[Number(match![1]) - 1]).toBe(COLLECTION);
  });

  it("keeps the normal read's filters alongside it", async () => {
    const { text } = await statementFor(
      { id: REVIEWER },
      { pending: true, reviewCollectionId: COLLECTION }
    );
    expect(text).toMatch(/i\."needsReview" IS NULL OR i\."userId" = \$\d+/);
    expect(text).toMatch(/i\."blockedFor" IS NULL OR i\."userId" = \$\d+/);
    expect(text).toMatch(/i\."ingestion" != 'Blocked'/);
  });

  it('adds nothing for a read that names no collection under review', async () => {
    const { text } = await statementFor({ id: REVIEWER }, { pending: true });
    expect(text).not.toMatch(REVIEW_ARM);
  });
});
