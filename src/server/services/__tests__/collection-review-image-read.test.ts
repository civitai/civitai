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
  extra: { pending?: boolean; reviewCollectionId?: number; userId?: number }
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
    expect(text).toMatch(/p\."availability" != \$\d+/);
  });

  it('opens unrated images only inside the rating check, not past the other filters', async () => {
    const { text } = await statementFor(
      { id: REVIEWER },
      { pending: true, reviewCollectionId: COLLECTION }
    );
    // The arm is the last OR inside the clause that starts with the rating check, so every other
    // AND-ed filter still applies to the images it lets through.
    const start = text.indexOf('((i."nsfwLevel" & $');
    expect(start, 'no rating clause in the read').toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    const arm = text.indexOf('rci."collectionId"', start);
    expect(arm, 'no review arm after the rating check').toBeGreaterThan(start);
    expect(arm, 'the review arm sits outside the rating clause').toBeLessThan(end);
  });

  it('adds nothing for a read that names no collection under review', async () => {
    const { text } = await statementFor({ id: REVIEWER }, { pending: true });
    expect(text).not.toMatch(REVIEW_ARM);
  });

  // A choice, not an accident: a judge sees a submission that is acceptable only in a collection,
  // so they can reject it. Once ACCEPTED, a collection items read loads it by id with no collection,
  // and that read leaves it out; a read of the collection's own image feed keeps it.
  it('keeps collection-only acceptable images in the review read, and out of a read by id with no collection', async () => {
    const review = await statementFor(
      { id: REVIEWER },
      { pending: true, reviewCollectionId: COLLECTION }
    );
    expect(review.text).not.toMatch(/i\."acceptableMinor" = FALSE/);
    vi.clearAllMocks();
    queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
    const accepted = await statementFor({ id: REVIEWER }, { pending: false });
    expect(accepted.text).toMatch(/i\."acceptableMinor" = FALSE/);
  });

  it("checks the collection's ownership and MANAGE against the viewer, not a profile being browsed", async () => {
    const PROFILE = 999;
    const ownerIds = async (viewer: number) => {
      vi.clearAllMocks();
      queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
      const { text, values } = await statementFor(
        { id: viewer },
        { pending: true, reviewCollectionId: COLLECTION, userId: PROFILE }
      );
      const bound = (re: RegExp) => {
        const m = text.match(re);
        expect(m, `no ${re} in the review arm`).not.toBeNull();
        return values[Number(m![1]) - 1];
      };
      return [bound(/rc\."userId" = \$(\d+)/), bound(/rcc\."userId" = \$(\d+)/)];
    };
    expect(await ownerIds(REVIEWER)).toEqual([REVIEWER, REVIEWER]);
    expect(await ownerIds(REVIEWER + 1)).toEqual([REVIEWER + 1, REVIEWER + 1]);
  });
});
