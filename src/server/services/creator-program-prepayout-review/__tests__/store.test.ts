import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { createPayoutReviewStore } from '../store';

const reviews = dbMock.dbWrite.creatorProgramPayoutReview;
const store = createPayoutReviewStore(dbMock.dbWrite as never);

const flag = (signals: string[]) => ({
  period: '2026-10',
  userId: 9,
  signals: signals as never,
  payoutCents: 5_000,
  evidence: { note: 'today' },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveFlag', () => {
  it('files a new row on the first flag', async () => {
    reviews.findUnique.mockResolvedValue(null);

    expect(await store.saveFlag(flag(['counterparty']))).toEqual({
      created: true,
      reopened: false,
    });
    expect(reviews.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ period: '2026-10', userId: 9, signals: ['counterparty'] }),
    });
  });

  it.each([
    [
      'an open review on a re-run',
      { status: 'open', signals: ['counterparty'], releasedAt: null },
      ['counterparty'],
    ],
    [
      'a cleared review with no new signal',
      { status: 'cleared', signals: ['counterparty', 'restricted'], releasedAt: null },
      ['restricted'],
    ],
    [
      'a released review, even with a new signal',
      { status: 'cleared', signals: ['counterparty'], releasedAt: new Date() },
      ['restricted'],
    ],
    [
      'a withheld review',
      { status: 'withheld', signals: ['counterparty'], releasedAt: null },
      ['restricted'],
    ],
  ])('refreshes evidence and leaves the decision alone for %s', async (_, existing, signals) => {
    reviews.findUnique.mockResolvedValue(existing);

    expect(await store.saveFlag(flag(signals))).toEqual({ created: false, reopened: false });
    const [{ data }] = reviews.update.mock.calls[0];
    expect(data).toMatchObject({ evidence: { note: 'today' }, evaluations: { increment: 1 } });
    for (const key of ['status', 'hold', 'decidedAt', 'decidedBy'])
      expect(data).not.toHaveProperty(key);
  });

  it('reopens a cleared hold when a signal appears that was not there when it was cleared', async () => {
    reviews.findUnique.mockResolvedValue({
      status: 'cleared',
      signals: ['counterparty'],
      releasedAt: null,
    });

    expect(await store.saveFlag(flag(['restricted']))).toEqual({ created: false, reopened: true });
    expect(reviews.update).toHaveBeenCalledWith({
      where: { period_userId: { period: '2026-10', userId: 9 } },
      data: expect.objectContaining({
        status: 'open',
        hold: true,
        signals: ['counterparty', 'restricted'],
      }),
    });
  });
});
