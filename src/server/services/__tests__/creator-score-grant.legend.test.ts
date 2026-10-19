import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A large grant that carries a creator over Legend must announce it exactly as the nightly job does:
 * the tier notification to the creator and the staff alert. Runs the real post-commit path
 * (`grantScoreTierCrossings`, the audience check, the announce schedule, `alertNewLegends`) and fakes
 * only the database and the notification write. Which tiers a transition reaches is the milestone
 * SQL's job, exercised in `creator-milestone-grant.behavior.test.ts`; the fake here answers it by
 * threshold.
 */

const LEGEND_THRESHOLD = 10_000_000;
const MODERATOR = 990000007;
const TARGET = 8675309;
const BEFORE = 9_914_899;

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  isFlipt: vi.fn(async () => true),
  trackModActivity: vi.fn(async () => undefined),
  pg: { cancellableQuery: vi.fn() },
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
}));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbWrite: mocks.pg,
}));
vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: mocks.trackModActivity,
}));
vi.mock('~/server/services/creator-score-unlocks.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorScoreUnlocks>()),
  getCreatorScoreUnlocks: async () => [],
}));

import type * as NotificationService from '~/server/services/notification.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as PgDb from '~/server/db/pgDb';
import type * as CreatorScoreUnlocks from '~/server/services/creator-score-unlocks.service';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import { grantCreatorScore } from '~/server/services/creator-score-grant.service';

const afterLaunch = new Date(
  Math.max(...Object.values(creatorMilestoneRegistry).map((entry) => entry.launchedAt.getTime()))
);

let milestoneInserts: unknown[][];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(afterLaunch);
  vi.clearAllMocks();
  milestoneInserts = [];

  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET, deletedAt: null });
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) =>
    (fn as (t: unknown) => unknown)({
      $executeRaw: async () => [],
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FOR NO KEY UPDATE')) return [{ id: TARGET }];
        if (sql.includes('SUM(amount)')) return [{ staffAwarded: BigInt(100_000) }];
        return [{ userId: TARGET, oldTotal: String(BEFORE), newTotal: String(BEFORE + 100_000) }];
      },
      creatorScoreGrant: {
        count: async () => 0,
        create: async ({ data }: { data: { amount: number } }) => ({
          id: 7,
          amount: data.amount,
          createdAt: new Date(),
        }),
      },
    })
  );
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: { legendAlertUserIds: [1, 2] } });
  dbMock.dbRead.user.findMany.mockResolvedValue([{ id: TARGET, username: 'newlegend' }]);

  mocks.pg.cancellableQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes('INSERT INTO "UserCreatorMilestone"')) {
      milestoneInserts.push(params ?? []);
      const transitions = JSON.parse(params?.[0] as string) as {
        userId: number;
        oldTotal: number;
        newTotal: number;
      }[];
      rows = transitions
        .filter((t) => t.newTotal >= LEGEND_THRESHOLD)
        .map((t) => ({
          userId: t.userId,
          milestoneKey: 'score:legend',
          name: 'Legend',
          threshold: LEGEND_THRESHOLD,
          silent: t.oldTotal >= LEGEND_THRESHOLD,
        }));
    } else if (sql.includes('FROM "User" u')) {
      rows = [{ id: TARGET, isModerator: false }];
    }
    return { result: async () => rows, cancel: async () => undefined };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const notificationsOfType = (type: string) =>
  (mocks.createNotification.mock.calls as unknown as [{ type: string }][])
    .map(([n]) => n)
    .filter((n) => n.type === type);

describe('a 100,000 grant across Legend', () => {
  const grant = (allowLarge: boolean) =>
    grantCreatorScore({
      userId: TARGET,
      amount: 100_000,
      reason: 'Contest judge',
      moderatorId: MODERATOR,
      allowLarge,
    });

  it('tells the creator and alerts staff, as a nightly crossing does', async () => {
    await expect(grant(true)).resolves.toMatchObject({ total: BEFORE + 100_000 });

    expect(milestoneInserts).toHaveLength(1);
    expect(JSON.parse(milestoneInserts[0][0] as string)).toEqual([
      { userId: TARGET, oldTotal: BEFORE, newTotal: BEFORE + 100_000 },
    ]);
    expect(notificationsOfType('creator-score-tier-reached')).toEqual([
      expect.objectContaining({
        key: `creator-score-tier-reached:${TARGET}:score:legend`,
        userId: TARGET,
      }),
    ]);
    expect(notificationsOfType('creator-legend-reached-staff')).toEqual([
      expect.objectContaining({
        key: `creator-legend-reached-staff:${TARGET}`,
        userIds: [1, 2],
        details: { userId: TARGET, username: 'newlegend' },
      }),
    ]);
  });

  it('control: without allowLarge it is refused and nothing is granted or announced', async () => {
    await expect(grant(false)).rejects.toThrow(/amount/i);
    expect(milestoneInserts).toEqual([]);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});
