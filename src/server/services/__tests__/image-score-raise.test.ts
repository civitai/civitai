import { describe, expect, it } from 'vitest';
import { imageScoresAsOf, planImageScoreRaise } from '~/server/services/image-score-raise.service';

const M = { reactions: 10, comments: 20 };

const pool = (answer: (sql: string) => unknown[]) =>
  ({
    cancellableQuery: async (sql: string) => ({
      result: async () => answer(sql),
      cancel: async () => undefined,
    }),
  } as never);

// Owner 7 has images 100 and 101, owner 8 has image 200.
//   7: (5 + 3) x 10 + 2 x 20 = 120 from source, less one own reaction = 110, less the next cron's +10
//      (another user's like on 100; 7's own like on 101 is left out, as the cron leaves it out) = 100.
//   8: 4 x 10 = 40, less the next cron's -10 + 20 = 30.
describe('imageScoresAsOf', () => {
  it('is the from-source score less own engagement and the next cron window', async () => {
    const queries: string[] = [];
    const ch = {
      $query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('entityMetricDailyAgg_v2'))
          return [
            { imageId: 100, reactions: 5, comments: 2 },
            { imageId: 101, reactions: 3, comments: 0 },
            { imageId: 200, reactions: 4, comments: 0 },
          ];
        return [
          { imageId: 100, userId: 50, dReactions: 1, dComments: 0 },
          { imageId: 101, userId: 7, dReactions: 1, dComments: 0 },
          { imageId: 200, userId: 51, dReactions: -1, dComments: 1 },
        ];
      },
    } as never;
    const scores = await imageScoresAsOf({
      ownerIds: [7, 8],
      since: new Date('2026-10-24T23:56:09.000Z'),
      now: new Date('2026-10-25T12:00:00.000Z'),
      multipliers: M,
      excluded: new Set(),
      pg: pool(() => [
        { id: 100, userId: 7 },
        { id: 101, userId: 7 },
        { id: 200, userId: 8 },
      ]),
      pgLong: pool((sql) => (sql.includes('"ImageReaction"') ? [{ userId: 7, count: 1 }] : [])),
      ch,
    });
    expect(scores).toEqual(
      new Map([
        [7, 100],
        [8, 30],
      ])
    );
    expect(queries.find((q) => q.includes('entityMetricEvents_month'))).toContain(
      'fromUnixTimestamp64Milli(1792886169000)'
    );
  });
});

describe('planImageScoreRaise', () => {
  it('raises only what goes up, and reports equal and lower scores without writing them', () => {
    const plan = planImageScoreRaise(
      new Map<number, number | null>([
        [1, 100],
        [2, 500],
        [3, 70],
        [4, null],
        [5, 100],
      ]),
      new Map([
        [1, 400],
        [2, 300],
        [3, 70],
        [4, 20],
        [5, 400],
      ]),
      new Set([5])
    );
    expect(plan.map((p) => [p.ownerId, p.action])).toEqual([
      [1, 'raise'],
      [2, 'down'],
      [3, 'equal'],
      [4, 'raise'],
      [5, 'excluded'],
    ]);
  });
});
