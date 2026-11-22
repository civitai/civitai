import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';

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
import { thumbnailCache } from '~/server/redis/caches';

const OWNER = 3300;
const STRANGER = 4400;

const BLOCKED_FOR = /\(i\."blockedFor" IS NULL(?: OR i\."userId" = \$(\d+))?\)/g;

async function blockedForClauses(
  viewer: { id: number; isModerator?: boolean } | undefined,
  profileUserId?: number
) {
  await getAllImages({
    // The session views the feed grants a session or full-access key.
    asModerator: true,
    asOwner: true,
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

describe('getAllImages requiringMeta', () => {
  const LEVEL_GATE = '"nsfwLevel" != 0';
  const INGESTION_GATE = /"ingestion" = \$\d+::"ImageIngestionStatus"/;

  async function statement(requiringMeta: boolean, domain: 'red' | 'green' = 'red') {
    await getAllImages({
      asModerator: true,
      asOwner: true,
      limit: 20,
      period: 'AllTime',
      periodMode: 'published',
      sort: 'Newest',
      browsingLevel: 1,
      include: [],
      user: { id: OWNER, isModerator: false },
      userId: OWNER,
      requiringMeta,
      domain,
    } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
    return queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  }
  const blockedForAiNotVerified = (stmt: { text: string; values: unknown[] }) => {
    const match = stmt.text.match(/i\."blockedFor" = \$(\d+)/);
    return !!match && stmt.values[Number(match[1]) - 1] === 'AiNotVerified';
  };

  // A metadata-blocked image is stored Blocked at the Blocked level, so the feed's own level and
  // ingestion gates would answer this filter with nothing.
  it("lists the owner's images blocked for missing metadata, past the level and ingestion gates", async () => {
    const stmt = await statement(true);
    expect(blockedForAiNotVerified(stmt)).toBe(true);
    expect(stmt.text).not.toContain(LEVEL_GATE);
    expect(stmt.text).not.toMatch(INGESTION_GATE);
  });

  it('keeps both gates on a capped domain, where an unrated image may not be listed', async () => {
    const stmt = await statement(true, 'green');
    expect(blockedForAiNotVerified(stmt)).toBe(true);
    expect(stmt.text).toContain(LEVEL_GATE);
    expect(stmt.text).toMatch(INGESTION_GATE);
  });

  it('keeps both gates without the filter', async () => {
    const stmt = await statement(false);
    expect(blockedForAiNotVerified(stmt)).toBe(false);
    expect(stmt.text).toContain(LEVEL_GATE);
    expect(stmt.text).toMatch(INGESTION_GATE);
  });
});

describe('getAllImages thumbnails', () => {
  const VIDEO = 9100;
  const run = async (user: { id: number } | undefined, asOwner: boolean) => {
    queryWithTimeoutMock.mockResolvedValue({
      rows: [
        {
          id: VIDEO,
          userId: OWNER,
          type: 'video',
          nsfwLevel: 1,
          url: 'video-url',
          postId: 1,
          publishedAt: new Date('2026-01-01T00:00:00Z'),
          sortAt: new Date('2026-01-01T00:00:00Z'),
          cursorId: VIDEO,
          ingestion: 'Scanned',
          metadata: {},
        },
      ],
    });
    const fetch = vi.spyOn(thumbnailCache, 'fetch').mockResolvedValue({
      [VIDEO]: { id: 1, url: 'thumb-url', width: 1, height: 1, nsfwLevel: 16, blockMarked: true },
    } as never);
    try {
      const { items } = await getAllImages({
        asModerator: true,
        asOwner,
        limit: 20,
        period: 'AllTime',
        periodMode: 'published',
        sort: 'Newest',
        browsingLevel: 31,
        include: [],
        user: user ? { isModerator: false, ...user } : undefined,
      } as unknown as Parameters<typeof getAllImages>[0]);
      const item = items.find((i) => i.id === VIDEO);
      return { url: item?.thumbnailUrl, level: item?.nsfwLevel };
    } finally {
      fetch.mockRestore();
    }
  };

  it('case 1', async () => {
    expect(await run(undefined, true)).toEqual({ url: undefined, level: 16 });
  });

  it('case 2', async () => {
    expect(await run({ id: OWNER }, true)).toEqual({ url: 'thumb-url', level: 16 });
  });

  it('case 3', async () => {
    expect(await run({ id: OWNER }, false)).toEqual({ url: undefined, level: 16 });
  });
});
