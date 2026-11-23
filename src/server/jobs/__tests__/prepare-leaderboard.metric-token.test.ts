import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => ({ read: [] as string[] }));

vi.mock('~/server/db/pgDb', () => {
  const cancellableQuery = (bucket?: string[]) => async (text: string) => {
    bucket?.push(text);
    return { result: async () => [], cancel: async () => undefined };
  };
  return {
    pgDbRead: {
      query: async () => ({ rows: [{ date: new Date() }] }),
      cancellableQuery: cancellableQuery(),
    },
    pgDbReadLong: {
      query: async () => ({ rows: [{ date: new Date() }] }),
      cancellableQuery: cancellableQuery(sql.read),
    },
    pgDbWrite: {
      query: async () => ({ rows: [{ date: new Date() }] }),
      cancellableQuery: cancellableQuery(),
    },
  };
});

import { populateLeaderboard } from '~/server/jobs/prepare-leaderboard';
import { METRIC_EXCLUDED_USERS_TOKEN } from '~/server/jobs/leaderboard-board-query';

beforeEach(() => {
  sql.read.length = 0;
});

describe('populateLeaderboard', () => {
  it("fills a board query's metric-excluded token with the excluded user ids", async () => {
    await populateLeaderboard(
      {
        jobContext: { on: vi.fn() } as never,
        id: 'writer-active',
        query: `WITH scores AS (SELECT 1 AS "userId", 1 AS score, '{}'::jsonb AS metrics
          WHERE 1 <> ALL(${METRIC_EXCLUDED_USERS_TOKEN}))`,
        includesCTE: true,
        addDays: 0,
        excludedUserIds: [7, 8],
      },
      async () => [0, 1]
    );
    const scored = sql.read.find((text) => text.includes('WITH scores AS'));
    expect(scored).toBeDefined();
    expect(scored).not.toContain(METRIC_EXCLUDED_USERS_TOKEN);
    expect(scored).toContain("'{7,8}'::int[]");
  });
});
