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
  reviews.updateMany.mockResolvedValue({ count: 1 });
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
    ['an open review on a re-run', 'open', ['counterparty'], ['counterparty']],
    [
      'a cleared review with no new signal',
      'cleared',
      ['counterparty', 'restricted'],
      ['restricted'],
    ],
    ['a withheld review', 'withheld', ['counterparty'], ['restricted']],
  ])(
    'refreshes evidence and leaves the decision alone for %s',
    async (_, status, seen, signals) => {
      reviews.findUnique.mockResolvedValue({ status, signals: seen });

      expect(await store.saveFlag(flag(signals))).toEqual({ created: false, reopened: false });
      const [{ where, data }] = reviews.updateMany.mock.calls[0];
      expect(where).toEqual({ period: '2026-10', userId: 9, status });
      expect(data).toMatchObject({ evidence: { note: 'today' }, evaluations: { increment: 1 } });
      for (const key of ['status', 'hold', 'decidedAt', 'decidedBy'])
        expect(data).not.toHaveProperty(key);
    }
  );

  it('reopens a cleared hold when a signal appears that was not there when it was cleared', async () => {
    reviews.findUnique.mockResolvedValue({ status: 'cleared', signals: ['counterparty'] });

    expect(await store.saveFlag(flag(['restricted']))).toEqual({ created: false, reopened: true });
    expect(reviews.updateMany).toHaveBeenCalledWith({
      where: { period: '2026-10', userId: 9, status: 'cleared' },
      data: expect.objectContaining({
        status: 'open',
        hold: true,
        decidedBy: null,
        signals: ['counterparty', 'restricted'],
      }),
    });
  });

  it('re-reads when a decision lands between its read and its write', async () => {
    // Read as open, cleared by a moderator before the write, so the new signal must reopen it.
    reviews.findUnique
      .mockResolvedValueOnce({ status: 'open', signals: ['counterparty'] })
      .mockResolvedValueOnce({ status: 'cleared', signals: ['counterparty'] });
    reviews.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await store.saveFlag(flag(['restricted']))).toEqual({ created: false, reopened: true });
  });

  it('gives up rather than looping when the row keeps changing', async () => {
    reviews.findUnique.mockResolvedValue({ status: 'open', signals: [] });
    reviews.updateMany.mockResolvedValue({ count: 0 });

    await expect(store.saveFlag(flag(['restricted']))).rejects.toThrow('kept changing');
    expect(reviews.updateMany).toHaveBeenCalledTimes(3);
  });
});
