import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(async () => undefined),
  isFlipt: vi.fn(async () => true),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
}));

import type * as NotificationService from '~/server/services/notification.service';
import type * as FliptClient from '~/server/flipt/client';
import { persistScoreBatch, settleTierGrants } from '~/server/jobs/update-user-score';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { creatorMilestoneNotifications } from '~/server/notifications/creator-milestone.notifications';

const updatedRow = { userId: 7, oldTotal: '400', newTotal: '600' };
const crossing = { userId: 7, milestoneKey: 'score:spark', name: 'Spark', threshold: 500 };
// After every registered launchedAt, so these cases depend on neither the clock nor the launch date.
const afterLaunch = new Date(
  Math.max(...Object.values(creatorMilestoneRegistry).map((entry) => entry.launchedAt.getTime()))
);

/** Answers each statement the batch runs by what it is, so a reordering cannot hand one another's rows. */
function batchCtx({
  grant = async () => [],
  owed = [{ id: 7, isModerator: false }],
  markSeen = async () => [],
}: {
  grant?: () => Promise<unknown[]>;
  owed?: { id: number; isModerator: boolean }[];
  markSeen?: () => Promise<unknown[]>;
} = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pg = {
    cancellableQuery: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const result = sql.includes('UPDATE "User"')
        ? async () => [updatedRow]
        : sql.includes('INSERT INTO "UserCreatorMilestone"')
        ? grant
        : sql.includes('UPDATE "UserCreatorMilestone"')
        ? markSeen
        : async () => owed;
      return { result, cancel: async () => undefined };
    }),
  };
  const ctx = {
    pg: pg as never,
    jobContext: { status: 'running', on: vi.fn(), checkIfCanceled: vi.fn() } as never,
    tierUnlocks: [],
    tierGrantErrors: [] as unknown[],
  };
  const grantCalls = () =>
    calls.filter((c) => c.sql.includes('INSERT INTO "UserCreatorMilestone"'));
  const markSeenCalls = () => calls.filter((c) => c.sql.includes('UPDATE "UserCreatorMilestone"'));
  return { ctx, grantCalls, markSeenCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFlipt.mockResolvedValue(true);
});

describe('persistScoreBatch', () => {
  it('hands the persisted old and new totals to the grant', async () => {
    const { ctx, grantCalls } = batchCtx();
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(grantCalls()).toHaveLength(1);
    expect(JSON.parse(grantCalls()[0].params?.[0] as string)).toEqual([
      { userId: 7, oldTotal: 400, newTotal: 600 },
    ]);
  });

  it('notifies a crossing as soon as its batch commits', async () => {
    const { ctx } = batchCtx({ grant: async () => [crossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'creator-score-tier-reached:7:score:spark', userId: 7 })
    );
    expect(ctx.tierGrantErrors).toEqual([]);
  });

  it('records a failed grant without failing the batch, whose scores are already written', async () => {
    const failure = new Error('relation "UserCreatorMilestone" does not exist');
    const { ctx } = batchCtx({
      grant: async () => {
        throw failure;
      },
    });
    await expect(
      persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch })
    ).resolves.toBeUndefined();
    expect(ctx.tierGrantErrors).toEqual([failure]);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});

describe('persistScoreBatch while Creator Journey is flagged', () => {
  it('grants and notifies nothing for a user the flag is off for', async () => {
    mocks.isFlipt.mockResolvedValue(false);
    const { ctx, grantCalls } = batchCtx({ grant: async () => [crossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(mocks.isFlipt).toHaveBeenCalledWith('creator-journey', '7', {
      userId: '7',
      isModerator: 'false',
    });
    expect(grantCalls()).toEqual([]);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('grants a moderator without asking Flipt', async () => {
    mocks.isFlipt.mockResolvedValue(false);
    const { ctx, grantCalls } = batchCtx({
      grant: async () => [crossing],
      owed: [{ id: 7, isModerator: true }],
    });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(mocks.isFlipt).not.toHaveBeenCalled();
    expect(grantCalls()).toHaveLength(1);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it('with grants open to everyone, still notifies only flagged users', async () => {
    mocks.isFlipt.mockResolvedValue(false);
    const { ctx, grantCalls } = batchCtx({ grant: async () => [crossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], {
      grantsRequireFlag: false,
      now: afterLaunch,
    });
    expect(grantCalls()).toHaveLength(1);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('asks Flipt nothing about a user who is owed no tier', async () => {
    const { ctx, grantCalls } = batchCtx({ owed: [] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(mocks.isFlipt).not.toHaveBeenCalled();
    expect(grantCalls()).toEqual([]);
  });
});

describe('persistScoreBatch before a definition launches', () => {
  const unregistered = { ...crossing, milestoneKey: 'score:unregistered' };

  it('marks silenced crossings seen and announces only launched ones', async () => {
    const { ctx, markSeenCalls } = batchCtx({ grant: async () => [crossing, unregistered] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(markSeenCalls()).toHaveLength(1);
    expect(JSON.parse(markSeenCalls()[0].params?.[0] as string)).toEqual([
      { userId: 7, milestoneKey: 'score:unregistered' },
    ]);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'creator-score-tier-reached:7:score:spark' })
    );
  });

  it('still announces launched crossings when marking the rest seen fails', async () => {
    const failure = new Error('deadlock detected');
    const { ctx } = batchCtx({
      grant: async () => [crossing, unregistered],
      markSeen: async () => {
        throw failure;
      },
    });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(ctx.tierGrantErrors).toEqual([failure]);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('persistScoreBatch alerts staff to a new Legend', () => {
  const legendCrossing = {
    userId: 7,
    milestoneKey: 'score:legend',
    name: 'Legend',
    threshold: 1_000_000,
  };
  const staffAlerts = () =>
    (mocks.createNotification.mock.calls as unknown as [{ type: string }][])
      .map(([n]) => n)
      .filter((n) => n.type === 'creator-legend-reached-staff');

  beforeEach(() => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: { legendAlertUserIds: [1, 2] } });
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 7, username: 'newlegend' }]);
  });

  it('notifies the configured staff with who crossed', async () => {
    const { ctx } = batchCtx({ grant: async () => [legendCrossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(staffAlerts()).toEqual([
      expect.objectContaining({
        key: 'creator-legend-reached-staff:7',
        userIds: [1, 2],
        details: { userId: 7, username: 'newlegend' },
      }),
    ]);
  });

  // Staff want every new Legend; the user-facing announcement schedule is a different decision.
  it('still alerts when the crossing is silenced for the user', async () => {
    const { ctx } = batchCtx({ grant: async () => [legendCrossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: new Date(0) });
    expect(staffAlerts()).toHaveLength(1);
  });

  // A silent grant (a tier already passed, the launch backfill) is a Founding Legend, not a new one.
  it('does not alert on a silent grant', async () => {
    const { ctx } = batchCtx({ grant: async () => [{ ...legendCrossing, silent: true }] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(staffAlerts()).toEqual([]);
  });

  it('does not alert on a lower tier', async () => {
    const { ctx } = batchCtx({ grant: async () => [crossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(staffAlerts()).toEqual([]);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  // The grants are committed by the time the alert runs, so its failure must not fail the batch.
  it('keeps the batch whole when the alert cannot read its config', async () => {
    dbMock.dbRead.keyValue.findUnique.mockRejectedValue(new Error('replica unreachable'));
    const { ctx } = batchCtx({ grant: async () => [legendCrossing] });
    await expect(
      persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch })
    ).resolves.toBeUndefined();
    expect(ctx.tierGrantErrors).toEqual([]);
  });

  it('renders a message that names the Legend and links to their profile', () => {
    const prepare = creatorMilestoneNotifications['creator-legend-reached-staff'].prepareMessage;
    expect(prepare({ details: { userId: 7, username: 'newlegend' } } as never)).toEqual({
      message: 'newlegend just became a Legend. Send them a note?',
      url: '/user/newlegend',
    });
  });

  it('renders nothing for an alert without a username', () => {
    const prepare = creatorMilestoneNotifications['creator-legend-reached-staff'].prepareMessage;
    expect(prepare({ details: { userId: 7, username: null } } as never)).toBeUndefined();
  });

  it('skips a Legend with no username, whose profile cannot be linked', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 7, username: null }]);
    const { ctx } = batchCtx({ grant: async () => [legendCrossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(staffAlerts()).toEqual([]);
  });

  it('sends nothing when no recipient is configured', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
    const { ctx } = batchCtx({ grant: async () => [legendCrossing] });
    await persistScoreBatch(ctx, [['7', { models: 600 }]], { now: afterLaunch });
    expect(staffAlerts()).toEqual([]);
  });
});

describe('settleTierGrants', () => {
  it('fails the run and freezes the tierGrants checkpoint when any grant failed', async () => {
    const failures: { category: string; error: unknown }[] = [];
    const advance = vi.fn(async () => undefined);
    const error = new Error('boom');
    await settleTierGrants([error], failures, advance);
    expect(failures).toEqual([{ category: 'tierGrants', error }]);
    expect(advance).not.toHaveBeenCalled();
  });

  it('advances the tierGrants checkpoint when every grant succeeded', async () => {
    const failures: { category: string; error: unknown }[] = [];
    const advance = vi.fn(async () => undefined);
    await settleTierGrants([], failures, advance);
    expect(failures).toEqual([]);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
