import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';
import type * as CollectionReviewSql from '~/server/services/collection-review.sql';

// A collection review reads its submissions as the reviewer: the normal read's filters, plus the
// collection's unrated REVIEW and REJECTED images. Mock recipe follows image-feed-blocked-for.test.ts.

const { queryWithTimeoutMock, pendingViewerMock, actualSql } = vi.hoisted(() => ({
  queryWithTimeoutMock: vi.fn(),
  pendingViewerMock: vi.fn(),
  actualSql: {} as { pendingViewerImageSql?: typeof CollectionReviewSql.pendingViewerImageSql },
}));

vi.mock('~/server/services/collection-review.sql', async (importOriginal) => {
  const actual = await importOriginal<typeof CollectionReviewSql>();
  actualSql.pendingViewerImageSql = actual.pendingViewerImageSql;
  return { ...actual, pendingViewerImageSql: pendingViewerMock };
});

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

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserCollectionPermissionsById: vi.fn().mockResolvedValue({ read: true }),
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

// The rating clause's arm, not the acceptableMinor exception that also names the collection.
const REVIEW_ARM =
  /i\."nsfwLevel" = 0 AND \([\s\S]*?"ingestion" = \$\d+::"ImageIngestionStatus"[\s\S]*?\) AND EXISTS \(\s*SELECT 1 FROM "CollectionItem" rci[\s\S]*?rci\."collectionId" = \$(\d+)/;

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
  pendingViewerMock.mockImplementation(actualSql.pendingViewerImageSql!);
});

// What the filter keeps and drops is run against rows in pending-viewer-image.sql.behavior.test.ts;
// these check only that the read applies it, with the viewer and the collection under review.
const withMarker = () =>
  pendingViewerMock.mockImplementation(
    ({ userId }: { userId: number }) => Prisma.sql`pending_viewer_marker(${userId})`
  );
const markerViewer = (stmt: { text: string; values: unknown[] }) => {
  const m = stmt.text.match(/pending_viewer_marker\(\$(\d+)\)/);
  return m ? stmt.values[Number(m[1]) - 1] : undefined;
};

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
  // so they can reject it. Once ACCEPTED, it is the owner's and moderators' only, in a read by id
  // and in the collection's own image feed alike.
  it('keeps collection-only acceptable images in the review read, and out of a read by id with no collection', async () => {
    await statementFor({ id: REVIEWER }, { pending: true, reviewCollectionId: COLLECTION });
    expect(pendingViewerMock).toHaveBeenCalledWith({
      userId: REVIEWER,
      browsingLevel: 31,
      reviewCollectionId: COLLECTION,
    });
    vi.clearAllMocks();
    queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
    const accepted = await statementFor({ id: REVIEWER }, { pending: false });
    expect(accepted.text).toMatch(/i\."acceptableMinor" = FALSE/);
  });

  it("applies the pending filter to a non-moderator's pending read, bound to the viewer", async () => {
    withMarker();
    const stmt = await statementFor({ id: REVIEWER }, { pending: true });
    expect(markerViewer(stmt)).toBe(REVIEWER);
    expect(pendingViewerMock).toHaveBeenCalledTimes(1);
    expect(pendingViewerMock).toHaveBeenCalledWith({
      userId: REVIEWER,
      browsingLevel: 31,
      reviewCollectionId: undefined,
    });
  });

  it("gives a moderator's pending read the level check but not the per-image conditions", async () => {
    withMarker();
    const stmt = await statementFor({ id: REVIEWER, isModerator: true }, { pending: true });
    expect(markerViewer(stmt)).toBeUndefined();
    expect(pendingViewerMock).not.toHaveBeenCalled();
    // A moderator's pending read still checks the level.
    expect(stmt.text).toMatch(/\(\(i\."nsfwLevel" & \$\d+\) != 0 OR i\."nsfwLevel" = 0\)/);
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

describe("a collection's image feed", () => {
  const FLAGGED = /i\."acceptableMinor" = FALSE(?: OR i\."userId" = \$(\d+))?/g;

  async function flaggedClauses(viewer?: { id: number; isModerator?: boolean }) {
    vi.clearAllMocks();
    queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
    await getAllImages({
      limit: 20,
      period: 'AllTime',
      periodMode: 'stats',
      sort: 'Newest',
      browsingLevel: 31,
      include: [],
      collectionId: COLLECTION,
      user: viewer ? { isModerator: false, ...viewer } : undefined,
    } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
    expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
    const { text, values } = queryWithTimeoutMock.mock.calls[0][2] as {
      text: string;
      values: unknown[];
    };
    return [...text.matchAll(FLAGGED)].map((m) => (m[1] ? values[Number(m[1]) - 1] : null));
  }

  // Any signed-in non-moderator, a manager of the collection included: the clause ignores
  // collection permissions, so only the image's owner passes it.
  it("shows another user's flagged image only to its owner", async () => {
    expect(await flaggedClauses({ id: REVIEWER })).toEqual([REVIEWER]);
  });

  it('shows it to no signed-out viewer', async () => {
    expect(await flaggedClauses()).toEqual([null]);
  });

  it('leaves it to moderators', async () => {
    expect(await flaggedClauses({ id: REVIEWER, isModerator: true })).toEqual([]);
  });
});
