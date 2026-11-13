import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';

// Any non-null blockedFor hides an image from the DB feed for everyone but the image's owner,
// matching the Meilisearch feeds. The owner arm must bind the VIEWER, never the profile being
// browsed, or a creator's blocked images would show to every visitor of their profile.
//
// Mock recipe follows image-feed-minor-owner.test.ts.

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

const OWNER = 3300;
const STRANGER = 4400;

const BLOCKED_FOR = /\(i\."blockedFor" IS NULL(?: OR i\."userId" = \$(\d+))?\)/g;

async function blockedForClauses(
  viewer: { id: number; isModerator?: boolean } | undefined,
  profileUserId?: number
) {
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel: 31,
    include: [],
    user: viewer ? { isModerator: false, ...viewer } : undefined,
    userId: profileUserId,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  const stmt = queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  return [...stmt.text.matchAll(BLOCKED_FOR)].map((m) => ({
    clause: m[0],
    exemptedId: m[1] ? stmt.values[Number(m[1]) - 1] : null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe('getAllImages blockedFor exclusion', () => {
  it('hides every blocked image from a signed-out viewer, even on a profile', async () => {
    expect(await blockedForClauses(undefined, OWNER)).toEqual([
      { clause: '(i."blockedFor" IS NULL)', exemptedId: null },
    ]);
  });

  it("exempts only the signed-in viewer's own images", async () => {
    const clauses = await blockedForClauses({ id: OWNER });
    expect(clauses).toHaveLength(1);
    expect(clauses[0].exemptedId).toBe(OWNER);
  });

  it("exempts the viewer, not the profile owner, on someone else's profile", async () => {
    const clauses = await blockedForClauses({ id: STRANGER }, OWNER);
    expect(clauses).toHaveLength(1);
    expect(clauses[0].exemptedId).toBe(STRANGER);
  });

  it('applies no blockedFor exclusion for a moderator', async () => {
    expect(await blockedForClauses({ id: STRANGER, isModerator: true })).toEqual([]);
  });
});
