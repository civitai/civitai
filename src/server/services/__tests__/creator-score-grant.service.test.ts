import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `grantCreatorScore` / `revokeCreatorScoreGrant`: a moderator awards or withdraws Creator Score.
 *
 * Every refusal is paired with the control that succeeds one step inside the bound, so a refusal
 * cannot pass because nothing ever writes. The grant row, its ModActivity row and the score rewrite
 * go through the SAME transaction client; the SQL of the score rewrite is exercised for real in
 * `creator-score-grant.behavior.test.ts`.
 */

const { trackModActivity, grantScoreTierCrossings, getCreatorScoreUnlocks } = vi.hoisted(() => ({
  trackModActivity: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  grantScoreTierCrossings: vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined),
  getCreatorScoreUnlocks: vi.fn<() => Promise<unknown[]>>(async () => []),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  grantScoreTierCrossings,
}));
vi.mock('~/server/services/creator-score-unlocks.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorScoreUnlocks>()),
  getCreatorScoreUnlocks,
}));

import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as CreatorScoreUnlocks from '~/server/services/creator-score-unlocks.service';
import {
  CREATOR_SCORE_GRANT_LIMITS,
  grantCreatorScore,
  revokeCreatorScoreGrant,
} from '~/server/services/creator-score-grant.service';

const MODERATOR = 990000007;
const TARGET = 8675309;
const NOW = new Date('2026-10-13T12:00:00.000Z');

type Fn = ReturnType<typeof vi.fn>;
type Tx = {
  $executeRaw: Fn;
  $queryRawUnsafe: Fn;
  creatorScoreGrant: { count: Fn; create: Fn; updateMany: Fn; findFirst: Fn };
};
let tx: Tx;
let order: string[];

const valid = () => ({
  userId: TARGET,
  amount: 250,
  reason: 'Contest judge',
  moderatorId: MODERATOR,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  order = [];
  tx = {
    $executeRaw: vi.fn(async () => {
      order.push('lock');
      return [];
    }),
    // Answers the row lock and the two statements of the score sync by what they are. The sum
    // comes back as a BigInt, as a driver may return an integer.
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FOR NO KEY UPDATE')) {
        order.push('rowLock');
        return [{ id: TARGET }];
      }
      if (sql.includes('SUM(amount)')) {
        order.push('sum');
        return [{ staffAwarded: BigInt(250) }];
      }
      order.push('score');
      return [{ userId: TARGET, oldTotal: '1000', newTotal: '1250' }];
    }),
    creatorScoreGrant: {
      count: vi.fn(async () => {
        order.push('count');
        return 0;
      }),
      create: vi.fn(async ({ data }: { data: { amount: number } }) => {
        order.push('create');
        return { id: 7, amount: data.amount, createdAt: NOW };
      }),
      updateMany: vi.fn(async () => {
        order.push('revoke');
        return { count: 1 };
      }),
      findFirst: vi.fn(async () => null),
    },
  };
  trackModActivity.mockReset();
  trackModActivity.mockImplementation(async () => {
    order.push('activity');
    return undefined;
  });
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) =>
    (fn as (t: Tx) => unknown)(tx)
  );
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET, deletedAt: null });
  grantScoreTierCrossings.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('grant bounds', () => {
  it('the limits are the agreed ones', () => {
    expect(CREATOR_SCORE_GRANT_LIMITS).toEqual({
      maxAmount: 10_000,
      largeMaxAmount: 1_000_000,
      dailyPerModerator: 20,
      maxReasonLength: 500,
    });
  });

  it.each([0, -1, 10_001, 100_000, 2.5])('refuses %s points and writes nothing', async (amount) => {
    await expect(grantCreatorScore({ ...valid(), amount })).rejects.toThrow(/amount/i);
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
  });

  it.each([1, 10_000])('control: %s points is granted', async (amount) => {
    await grantCreatorScore({ ...valid(), amount });
    expect(tx.creatorScoreGrant.create).toHaveBeenCalledTimes(1);
    expect(tx.creatorScoreGrant.create.mock.calls[0][0].data.amount).toBe(amount);
  });

  it.each([0, 1_000_001, 2.5])(
    'refuses %s points even with allowLarge, and writes nothing',
    async (amount) => {
      await expect(grantCreatorScore({ ...valid(), amount, allowLarge: true })).rejects.toThrow(
        /amount/i
      );
      expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
    }
  );

  it.each([10_001, 100_000, 1_000_000])(
    'control: %s points is granted with allowLarge',
    async (amount) => {
      await grantCreatorScore({ ...valid(), amount, allowLarge: true });
      expect(tx.creatorScoreGrant.create).toHaveBeenCalledTimes(1);
      expect(tx.creatorScoreGrant.create.mock.calls[0][0].data.amount).toBe(amount);
    }
  );

  it('a large grant counts toward the daily cap like any other', async () => {
    tx.creatorScoreGrant.count.mockResolvedValue(20);
    await expect(
      grantCreatorScore({ ...valid(), amount: 100_000, allowLarge: true })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(501)],
  ])('refuses a %s reason', async (_label, reason) => {
    await expect(grantCreatorScore({ ...valid(), reason })).rejects.toThrow(/reason/i);
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['deleted', { id: TARGET, deletedAt: new Date('2026-01-01') }],
  ])('refuses a %s target account', async (_label, row) => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(row);
    await expect(grantCreatorScore(valid())).rejects.toThrow(/user/i);
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
  });

  it('refuses a moderator granting to their own account', async () => {
    await expect(grantCreatorScore({ ...valid(), userId: MODERATOR })).rejects.toThrow(
      /own account/
    );
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
  });
});

describe('daily cap per moderator', () => {
  it('refuses the 21st grant in 24 hours, as a rate limit (429)', async () => {
    tx.creatorScoreGrant.count.mockResolvedValue(20);
    await expect(grantCreatorScore(valid())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringMatching(/20/),
    });
    expect(tx.creatorScoreGrant.create).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('control: the 20th grant goes through', async () => {
    tx.creatorScoreGrant.count.mockResolvedValue(19);
    await grantCreatorScore(valid());
    expect(tx.creatorScoreGrant.create).toHaveBeenCalledTimes(1);
  });

  it("counts THIS moderator's grants over the last 24 hours", async () => {
    await grantCreatorScore(valid());
    expect(tx.creatorScoreGrant.count).toHaveBeenCalledWith({
      where: {
        grantedById: MODERATOR,
        createdAt: { gt: new Date('2026-10-12T12:00:00.000Z') },
      },
    });
  });

  it('counts under a per-moderator advisory lock with both keys cast to int', async () => {
    await grantCreatorScore(valid());
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join('?')).toBe('SELECT pg_advisory_xact_lock(?::int, ?::int)');
    expect(values).toEqual([0x43530001, MODERATOR]);
    expect(order.slice(0, 3)).toEqual(['lock', 'rowLock', 'count']);
  });
});

describe('what a grant writes', () => {
  it('writes the grant, its audit row and the new score in one transaction, in that order', async () => {
    const result = await grantCreatorScore(valid());

    // The target's row lock comes before the insert: the insert's foreign key takes KEY SHARE on
    // that row, and locking it afterwards would deadlock two moderators granting to one account.
    expect(order).toEqual(['lock', 'rowLock', 'count', 'create', 'activity', 'sum', 'score']);
    expect(tx.$queryRawUnsafe.mock.calls[0]).toEqual([
      'SELECT id FROM "User" WHERE id = $1 FOR NO KEY UPDATE',
      TARGET,
    ]);
    expect(tx.$queryRawUnsafe.mock.calls[1][1]).toBe(TARGET);
    expect(tx.$queryRawUnsafe.mock.calls[2][0]).toContain(
      `[{"id":${TARGET},"scores":{"staffAwarded":250}}]`
    );
    expect(tx.creatorScoreGrant.create).toHaveBeenCalledWith({
      data: { userId: TARGET, amount: 250, reason: 'Contest judge', grantedById: MODERATOR },
      select: { id: true, amount: true, createdAt: true },
    });
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'user', entityId: TARGET, activity: 'grantCreatorScore:7:250' },
      tx
    );
    expect(result).toEqual({ id: 7, amount: 250, createdAt: NOW, total: 1250 });
  });

  it('stores the trimmed reason', async () => {
    await grantCreatorScore({ ...valid(), reason: '  Contest judge  ' });
    expect(tx.creatorScoreGrant.create.mock.calls[0][0].data.reason).toBe('Contest judge');
  });

  it('hands the old and new totals to the tier grant after the commit', async () => {
    await grantCreatorScore(valid());
    expect(grantScoreTierCrossings).toHaveBeenCalledTimes(1);
    expect(grantScoreTierCrossings.mock.calls[0][1]).toEqual([
      { userId: TARGET, oldTotal: 1000, newTotal: 1250 },
    ]);
  });

  it('a failed tier grant does not fail a grant that already committed', async () => {
    grantScoreTierCrossings.mockRejectedValueOnce(new Error('milestones down'));
    await expect(grantCreatorScore(valid())).resolves.toMatchObject({ id: 7, total: 1250 });
  });
});

describe('revoke', () => {
  const revokeInput = () => ({
    grantId: 7,
    userId: TARGET,
    reason: '  Wrong account  ',
    moderatorId: MODERATOR,
  });

  it('stamps the grant, scoped to the account and still active, then rescores', async () => {
    const result = await revokeCreatorScoreGrant(revokeInput());

    expect(tx.creatorScoreGrant.updateMany).toHaveBeenCalledWith({
      where: { id: 7, userId: TARGET, revokedAt: null },
      data: { revokedAt: NOW, revokedById: MODERATOR, revokeReason: 'Wrong account' },
    });
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'user', entityId: TARGET, activity: 'revokeCreatorScore:7' },
      tx
    );
    expect(order).toEqual(['rowLock', 'revoke', 'activity', 'sum', 'score']);
    expect(tx.$queryRawUnsafe.mock.calls[0][1]).toBe(TARGET);
    expect(result).toEqual({ id: 7, revokedAt: NOW, total: 1250 });
  });

  it('refuses a grant that is not on this account (404) and rescores nothing', async () => {
    tx.creatorScoreGrant.updateMany.mockResolvedValue({ count: 0 });
    tx.creatorScoreGrant.findFirst.mockResolvedValue(null);
    await expect(revokeCreatorScoreGrant(revokeInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(trackModActivity).not.toHaveBeenCalled();
    expect(order).toEqual(['rowLock']);
  });

  it('refuses an already-revoked grant (409) and rescores nothing', async () => {
    tx.creatorScoreGrant.updateMany.mockResolvedValue({ count: 0 });
    tx.creatorScoreGrant.findFirst.mockResolvedValue({ revokedAt: NOW });
    await expect(revokeCreatorScoreGrant(revokeInput())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('refuses a blank reason and writes nothing', async () => {
    await expect(revokeCreatorScoreGrant({ ...revokeInput(), reason: ' ' })).rejects.toThrow(
      /reason/i
    );
    expect(tx.creatorScoreGrant.updateMany).not.toHaveBeenCalled();
  });
});
