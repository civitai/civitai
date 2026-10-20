import { Prisma } from '@prisma/client';
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

const row = (status: string, signals: string[], version = 2) => ({
  status,
  signals,
  version,
  decisions: [{ action: 'clear', by: 'user:5' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  reviews.updateMany.mockResolvedValue({ count: 1 });
});

describe('getCarriedUserIds', () => {
  it('returns creators whose latest earlier review was withheld', async () => {
    reviews.findMany.mockResolvedValue([
      { userId: 7, status: 'withheld' },
      { userId: 8, status: 'cleared' },
    ]);

    expect(await store.getCarriedUserIds('2026-11')).toEqual([7]);
    expect(reviews.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { period: { lt: '2026-11' } },
        orderBy: [{ userId: 'asc' }, { period: 'desc' }],
        distinct: ['userId'],
      })
    );
  });
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
    ['an open review on a re-run', row('open', ['counterparty']), ['counterparty']],
    [
      'a cleared review with no new signal',
      row('cleared', ['counterparty', 'restricted']),
      ['restricted'],
    ],
    ['a withheld review', row('withheld', ['counterparty']), ['restricted']],
  ])(
    'refreshes evidence, bumps the version and leaves the decision alone for %s',
    async (_, existing, signals) => {
      reviews.findUnique.mockResolvedValue(existing);

      expect(await store.saveFlag(flag(signals))).toEqual({ created: false, reopened: false });
      const [{ where, data }] = reviews.updateMany.mock.calls[0];
      expect(where).toEqual({ period: '2026-10', userId: 9, version: 2 });
      expect(data).toMatchObject({
        evidence: { note: 'today' },
        evaluations: { increment: 1 },
        version: { increment: 1 },
      });
      for (const key of ['status', 'hold', 'decidedAt', 'decidedBy', 'decisions'])
        expect(data).not.toHaveProperty(key);
    }
  );

  it('reopens a cleared hold on a new signal and records the reopen in the history', async () => {
    reviews.findUnique.mockResolvedValue(row('cleared', ['counterparty']));

    expect(await store.saveFlag(flag(['restricted']))).toEqual({ created: false, reopened: true });
    const [{ data }] = reviews.updateMany.mock.calls[0];
    expect(data).toMatchObject({
      status: 'open',
      hold: true,
      signals: ['counterparty', 'restricted'],
    });
    expect(data.decisions).toEqual([
      { action: 'clear', by: 'user:5' },
      expect.objectContaining({ action: 'reopened', from: 'cleared', to: 'open', version: 2 }),
    ]);
  });

  it('re-reads when a decision lands between its read and its write', async () => {
    reviews.findUnique
      .mockResolvedValueOnce(row('open', ['counterparty'], 2))
      .mockResolvedValueOnce(row('cleared', ['counterparty'], 3));
    reviews.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await store.saveFlag(flag(['restricted']))).toEqual({ created: false, reopened: true });
  });

  it('updates the row an overlapping run created first', async () => {
    reviews.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row('open', ['counterparty']));
    reviews.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    expect(await store.saveFlag(flag(['counterparty']))).toEqual({
      created: false,
      reopened: false,
    });
    expect(reviews.updateMany).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than looping when the row keeps changing', async () => {
    reviews.findUnique.mockResolvedValue(row('open', []));
    reviews.updateMany.mockResolvedValue({ count: 0 });

    await expect(store.saveFlag(flag(['restricted']))).rejects.toThrow('kept changing');
    expect(reviews.updateMany).toHaveBeenCalledTimes(3);
  });
});
