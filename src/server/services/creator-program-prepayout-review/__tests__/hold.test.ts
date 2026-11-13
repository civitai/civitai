import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as NotificationService from '~/server/services/notification.service';
import { OnboardingSteps } from '~/server/common/enums';
import {
  assertNoPayoutHold,
  decidePayoutReview,
  getSettlementHolds,
  hasPayoutHold,
  openPayoutHold,
} from '../hold';
import { installPayoutReviewTable } from './payout-review-fake';

const { createNotification } = vi.hoisted(() => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const reviews = dbMock.dbWrite.creatorProgramPayoutReview;

const review = (over: Record<string, unknown> = {}) => ({
  id: 41,
  userId: 9,
  period: '2026-10',
  status: 'open',
  askRef: null,
  version: 3,
  decisions: [{ action: 'escalate', by: 'user:1' }],
  ...over,
});

const decide = (
  action: 'escalate' | 'clear' | 'withhold',
  over: Partial<{ userId: number; period: string; version: number; note: string }> = {}
) =>
  decidePayoutReview(
    { id: 41, userId: 9, period: '2026-10', action, version: 3, askRef: 'card-1', ...over },
    'user:5'
  );

beforeEach(() => {
  vi.clearAllMocks();
  reviews.updateMany.mockResolvedValue({ count: 1 });
});

describe('getSettlementHolds', () => {
  it('holds open, escalated and withheld creators, and adds cleared ones who are not banned', async () => {
    reviews.findMany.mockResolvedValue([
      { userId: 1, status: 'open', hold: true },
      { userId: 2, status: 'escalated', hold: true },
      { userId: 3, status: 'withheld', hold: true },
      { userId: 4, status: 'cleared', hold: false },
      { userId: 5, status: 'cleared', hold: false },
      { userId: 6, status: 'cleared', hold: false },
      // A cleared row does not lift an open one.
      { userId: 1, status: 'cleared', hold: false },
    ]);
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      { id: 4, onboarding: 0 },
      { id: 5, onboarding: OnboardingSteps.BannedCreatorProgram },
    ]);

    const holds = await getSettlementHolds('2026-10');

    expect(holds.heldUserIds).toEqual(new Set([1, 2, 3]));
    expect(holds.clearedUserIds).toEqual([4]);
    expect(dbMock.dbWrite.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [4, 5, 6] }, bannedAt: null } })
    );
  });
});

describe('getSettlementHolds: a withhold covers its own cycle', () => {
  it('holds on the latest withhold, and pays once a later review clears the creator', async () => {
    reviews.findMany.mockResolvedValue([
      // Withheld for October, no later review yet: held.
      { userId: 7, status: 'withheld', hold: true, period: '2026-10' },
      // Withheld for September, cleared for October: paid.
      { userId: 8, status: 'withheld', hold: true, period: '2026-09' },
      { userId: 8, status: 'cleared', hold: false, period: '2026-10' },
      // Cleared for September, withheld for October: held.
      { userId: 9, status: 'cleared', hold: false, period: '2026-09' },
      { userId: 9, status: 'withheld', hold: true, period: '2026-10' },
    ]);
    dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: 8, onboarding: 0 }]);

    const holds = await getSettlementHolds('2026-10');

    expect(holds.heldUserIds).toEqual(new Set([7, 9]));
    expect(holds.clearedUserIds).toEqual([8]);
  });
});

describe('decidePayoutReview', () => {
  it('clearing lifts the hold, conditional on the row and version it read', async () => {
    reviews.findUnique.mockResolvedValue(review());

    expect(await decide('clear', { note: 'looked fine' })).toEqual({
      id: 41,
      status: 'cleared',
      version: 4,
    });
    expect(reviews.updateMany).toHaveBeenCalledWith({
      where: { id: 41, userId: 9, period: '2026-10', version: 3 },
      data: expect.objectContaining({
        status: 'cleared',
        hold: false,
        decidedBy: 'user:5',
        decisionNote: 'looked fine',
        version: { increment: 1 },
      }),
    });
  });

  it('appends to the decision history rather than replacing it', async () => {
    reviews.findUnique.mockResolvedValue(review());

    await decide('withhold');

    const [{ data }] = reviews.updateMany.mock.calls[0];
    expect(data.decisions).toEqual([
      { action: 'escalate', by: 'user:1' },
      expect.objectContaining({
        by: 'user:5',
        action: 'withhold',
        from: 'open',
        to: 'withheld',
        version: 3,
        note: null,
        askRef: 'card-1',
      }),
    ]);
    // An omitted note does not leave the previous decider's note under the new decider.
    expect(data.decisionNote).toBeNull();
  });

  it.each([
    ['withheld', 'clear', 'cleared'],
    ['cleared', 'withhold', 'withheld'],
    ['cleared', 'escalate', 'escalated'],
  ] as const)('a %s review can be moved with %s', async (status, action, to) => {
    reviews.findUnique.mockResolvedValue(review({ status }));

    expect(await decide(action)).toMatchObject({ status: to });
  });

  it.each([
    ['escalate', 'withheld'],
    ['clear', 'cleared'],
  ] as const)('refuses to %s a %s review', async (action, status) => {
    reviews.findUnique.mockResolvedValue(review({ status }));

    await expect(decide(action)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(reviews.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a stale decision, e.g. a replayed clear after a later withhold', async () => {
    // The clear was prepared at version 3; a withhold has since moved the row to version 4.
    reviews.findUnique.mockResolvedValue(review({ status: 'withheld', version: 4 }));

    await expect(decide('clear')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(reviews.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['another creator', { userId: 10 }],
    ['another period', { period: '2026-09' }],
  ])('refuses a decision naming %s', async (_, over) => {
    reviews.findUnique.mockResolvedValue(review());

    await expect(decide('clear', over)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reviews.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost race instead of claiming the decision applied', async () => {
    reviews.findUnique.mockResolvedValue(review());
    reviews.updateMany.mockResolvedValue({ count: 0 });

    await expect(decide('clear')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('openPayoutHold', () => {
  let table: ReturnType<typeof installPayoutReviewTable>;
  const now = new Date('2026-11-20T10:00:00Z');
  const open = () =>
    openPayoutHold(
      { userId: 9, ground: 'chargeback', reason: 'disputed sales', askRef: 'card-9' },
      'user:5',
      now
    );

  beforeEach(() => {
    table = installPayoutReviewTable();
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: 9 });
  });
  afterEach(() => table.uninstall());

  it('holds a creator the detector never flagged, recording ground, reason and who', async () => {
    const hold = await open();

    expect(hold).toMatchObject({ period: '2026-10', status: 'open' });
    expect(await hasPayoutHold(9)).toBe(true);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        type: 'creators-program-cash-out-on-hold',
        key: `creators-program-cash-out-on-hold:${hold.id}:${hold.version}`,
      })
    );
    expect(table.rows[0].decisions).toEqual([
      expect.objectContaining({
        action: 'opened',
        ground: 'chargeback',
        note: 'disputed sales',
        by: 'user:5',
        askRef: 'card-9',
      }),
    ]);
  });

  it('refuses a second hold while one stands', async () => {
    await open();
    await expect(open()).rejects.toThrow('already has a payout hold');
  });

  it('reopens a review cleared earlier in the same period', async () => {
    table.rows.push(
      review({ period: '2026-10', status: 'cleared', hold: false, signals: ['x'], version: 4 })
    );

    const hold = await open();

    expect(hold).toMatchObject({ id: 41, version: 5 });
    expect(table.rows[0]).toMatchObject({
      status: 'open',
      hold: true,
      signals: ['x', 'manual:chargeback'],
    });
    expect(await hasPayoutHold(9)).toBe(true);
  });

  it('refuses when the cleared review changes between read and write', async () => {
    table.rows.push(
      review({ period: '2026-10', status: 'cleared', hold: false, signals: [], version: 4 })
    );
    const write = reviews.updateMany.getMockImplementation()!;
    reviews.updateMany.mockImplementationOnce(async (args: unknown) => {
      table.rows[0].status = 'escalated';
      return write(args);
    });

    await expect(open()).rejects.toThrow('changed while opening a hold');
    expect(table.rows[0].status).toBe('escalated');
  });

  it('sends a withhold superseded by a later clear back to review instead of retrying', async () => {
    table.rows.push(
      review({ period: '2026-10', status: 'withheld', hold: false, signals: [] }),
      review({ id: 42, period: '2026-11', status: 'cleared', hold: false, signals: [] })
    );
    expect(await hasPayoutHold(9)).toBe(false);

    await expect(open()).rejects.toThrow('is withheld; decide it in payout review');
    expect(table.rows[0]).toMatchObject({ status: 'withheld', version: 3 });
  });

  it('files a period-scoped row once and reports a concurrent filing as a conflict', async () => {
    reviews.findUnique.mockResolvedValueOnce(null);
    table.rows.push(review({ period: '2026-10', status: 'cleared', hold: false, signals: [] }));

    await expect(open()).rejects.toThrow('was filed meanwhile');
  });

  it('refuses an unknown user', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    await expect(open()).rejects.toThrow('No user 9');
  });
});

describe('hasPayoutHold', () => {
  let table: ReturnType<typeof installPayoutReviewTable>;
  beforeEach(() => {
    table = installPayoutReviewTable();
  });
  afterEach(() => table.uninstall());

  it.each([
    ['an escalated review', [{ period: '2026-10', status: 'escalated', hold: true }], true],
    [
      'a withhold that is the latest review',
      [{ period: '2026-10', status: 'withheld', hold: true }],
      true,
    ],
    [
      'a withhold a later review cleared',
      [
        { period: '2026-09', status: 'withheld', hold: true },
        { period: '2026-10', status: 'cleared', hold: false },
      ],
      false,
    ],
    ["another user's hold", [{ period: '2026-10', status: 'open', hold: true, userId: 10 }], false],
  ])('%s → %s', async (_label, rows, held) => {
    for (const [i, r] of rows.entries()) table.rows.push(review({ id: 100 + i, userId: 9, ...r }));
    expect(await hasPayoutHold(9)).toBe(held);
  });
});

describe('assertNoPayoutHold when the hold cannot be read', () => {
  const unchecked = () =>
    loggingMock.logToAxiom.mock.calls.filter(
      ([e]) => (e as { name?: string }).name === 'creator-program-payout-hold-unchecked'
    );
  beforeEach(() => loggingMock.logToAxiom.mockClear());
  afterEach(() => reviews.findMany.mockReset().mockResolvedValue([]));

  it('refuses the cash-out and alerts when the review table is missing', async () => {
    reviews.findMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing table', {
        code: 'P2021',
        clientVersion: 'test',
      })
    );

    await expect(assertNoPayoutHold(9)).rejects.toThrow('temporarily unavailable');
    expect(unchecked()).toHaveLength(1);
  });

  it('rethrows any other database error unchanged', async () => {
    reviews.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(assertNoPayoutHold(9)).rejects.toThrow('connection reset');
    expect(unchecked()).toHaveLength(0);
  });

  it('lets a creator with no review through', async () => {
    await expect(assertNoPayoutHold(9)).resolves.toBeUndefined();
  });
});
