import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClickhouseQuery, mockCreateBuzzMany, counterStub } = vi.hoisted(() => ({
  mockClickhouseQuery: vi.fn(),
  mockCreateBuzzMany: vi.fn().mockResolvedValue(undefined),
  counterStub: {
    increment: vi.fn(),
    decrement: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn(),
    getCountBatch: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn(),
    key: 'stub',
  },
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockClickhouseQuery } }));
vi.mock('~/server/games/new-order/utils', () => ({
  allJudgmentsCounter: counterStub,
  blessedBuzzCounter: counterStub,
  correctJudgmentsCounter: counterStub,
  expCounter: counterStub,
  fervorCounter: counterStub,
  pendingBuzzCounter: counterStub,
  recentlyGrantedBuzzCounter: counterStub,
  getActiveSlot: vi.fn(),
  setActiveSlot: vi.fn(),
  getVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
  poolCounters: {},
}));
vi.mock('~/server/services/games/new-order.service', () => ({
  smitePlayer: vi.fn(),
  calculateFervor: vi.fn(),
  cleanseSmite: vi.fn(),
  processFinalRatings: vi.fn(),
  clearRatedImages: vi.fn(),
}));
vi.mock('~/server/services/moderator-app.service', () => ({ moderatorApp: {} }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzMany,
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: vi.fn() }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/env/server', () => ({ env: {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { runGrantBlessedBuzz } from '~/server/jobs/new-order-jobs';

const judgment = (userId: number) => ({ userId, balance: 10, totalExp: 100 });
const player = (userId: number, extra: Record<string, unknown> = {}) => ({
  userId,
  payoutBlockedAt: null,
  payoutReleaseFrom: null,
  startAt: new Date(0),
  user: { bannedAt: null },
  ...extra,
});

type FindManyArgs = { where: { payoutReleaseFrom?: unknown } };
const stubPlayers = (main: unknown[], released: unknown[] = []) =>
  dbMock.dbRead.newOrderPlayer.findMany.mockImplementation(((args: FindManyArgs) =>
    Promise.resolve(args.where.payoutReleaseFrom ? released : main)) as never);

const grantedUserIds = () =>
  mockCreateBuzzMany.mock.calls.flatMap(([txs]) =>
    (txs as Array<{ toAccountId: number }>).map((t) => t.toAccountId)
  );

describe('runGrantBlessedBuzz payee filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClickhouseQuery.mockResolvedValue([judgment(1), judgment(2), judgment(3), judgment(4)]);
  });

  it('pays unblocked players only and leaves blocked and banned ones untouched', async () => {
    stubPlayers([
      player(1),
      player(2, { payoutBlockedAt: new Date() }),
      player(3, { user: { bannedAt: new Date() } }),
      player(4),
    ]);

    await runGrantBlessedBuzz();

    expect(grantedUserIds().sort()).toEqual([1, 4]);
    const decremented = counterStub.decrement.mock.calls.map(([a]) => a.id).sort();
    expect(decremented).toEqual([1, 4]);
    const resetIds = counterStub.reset.mock.calls.map(([a]) => a.id);
    expect(resetIds).not.toContain(2);
    expect(resetIds).not.toContain(3);
  });

  it('grants nothing when every candidate is blocked', async () => {
    stubPlayers([player(1, { payoutBlockedAt: new Date() })]);
    mockClickhouseQuery.mockResolvedValue([judgment(1)]);

    await runGrantBlessedBuzz();

    expect(mockCreateBuzzMany).not.toHaveBeenCalled();
  });
});

describe('runGrantBlessedBuzz release catch-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pays held days once per day for released players and clears the marker', async () => {
    const releaseFrom = new Date('2026-10-10T00:00:00.000Z');
    mockClickhouseQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { userId: 7, dayMs: Date.parse('2026-10-10T00:00:00.000Z'), balance: 5, totalExp: 50 },
      { userId: 7, dayMs: Date.parse('2026-10-11T00:00:00.000Z'), balance: 6, totalExp: 60 },
    ]);
    stubPlayers([], [player(7, { payoutReleaseFrom: releaseFrom })]);

    await runGrantBlessedBuzz();

    const txs = mockCreateBuzzMany.mock.calls.flatMap(([t]) => t as Array<Record<string, unknown>>);
    expect(txs.map((t) => t.externalTransactionId)).toEqual([
      'new-order-7-2026-10-10T00:00:00.000Z',
      'new-order-7-2026-10-11T00:00:00.000Z',
    ]);
    expect(dbMock.dbWrite.newOrderPlayer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payoutReleaseFrom: null } })
    );
  });

  it('a released player reset mid-hold is paid only judgments at or after startAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 12));
    const local = (d: number, h = 0) => new Date(2026, 9, d, h);
    const startAt = local(11, 12);
    const ratings = [
      { createdAt: local(9, 10), exp: 900 },
      { createdAt: local(11, 6), exp: 1100 },
      { createdAt: local(11, 18), exp: 1300 },
      { createdAt: local(12, 9), exp: 1700 },
    ];
    // Honours the catch-up query's time bounds and any per-user lower bound.
    mockClickhouseQuery.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.reduce(
          (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''),
          ''
        );
        if (!sql.includes('dayMs')) return Promise.resolve([]);
        const [from, to] = values.filter((v): v is Date => v instanceof Date);
        const minByUser = new Map(
          [
            ...sql.matchAll(
              /userId = (\d+) AND createdAt >= parseDateTimeBestEffort\('([^']+)'\)/g
            ),
          ].map(([, id, iso]) => [Number(id), new Date(iso)])
        );
        const min = minByUser.get(7);
        const byDay = new Map<number, number>();
        for (const r of ratings) {
          if (r.createdAt < from || r.createdAt >= to || (min && r.createdAt < min)) continue;
          const dayMs = new Date(r.createdAt).setHours(0, 0, 0, 0);
          byDay.set(dayMs, (byDay.get(dayMs) ?? 0) + r.exp);
        }
        return Promise.resolve(
          [...byDay].map(([dayMs, totalExp]) => ({ userId: 7, dayMs, totalExp, balance: totalExp }))
        );
      }
    );
    stubPlayers([], [player(7, { payoutReleaseFrom: local(8), startAt })]);

    try {
      await runGrantBlessedBuzz();
    } finally {
      vi.useRealTimers();
    }

    const txs = mockCreateBuzzMany.mock.calls.flatMap(([t]) => t as Array<{ amount: number }>);
    expect(txs.map((t) => t.amount)).toEqual([1300, 1700]);
  });

  it('does not pay a released player who has since been blocked again or banned', async () => {
    mockClickhouseQuery.mockResolvedValue([]);
    stubPlayers(
      [],
      [
        player(7, { payoutReleaseFrom: new Date(), payoutBlockedAt: new Date() }),
        player(8, { payoutReleaseFrom: new Date(), user: { bannedAt: new Date() } }),
      ]
    );

    await runGrantBlessedBuzz();

    expect(mockCreateBuzzMany).not.toHaveBeenCalled();
  });
});
