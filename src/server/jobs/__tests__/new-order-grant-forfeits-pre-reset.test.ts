import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NewOrderUtils from '~/server/games/new-order/utils';
import type * as BuzzService from '~/server/services/buzz.service';

const mocks = vi.hoisted(() => ({
  createBuzzTransactionMany: vi.fn(),
  query: vi.fn(),
  counters: {
    blessed: { decrement: vi.fn(), reset: vi.fn(), getAll: vi.fn() },
    pending: { reset: vi.fn() },
    recentlyGranted: { reset: vi.fn() },
  },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: mocks.query },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderUtils>()),
  blessedBuzzCounter: mocks.counters.blessed,
  pendingBuzzCounter: mocks.counters.pending,
  recentlyGrantedBuzzCounter: mocks.counters.recentlyGranted,
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: mocks.createBuzzTransactionMany,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { newOrderConfig } from '~/server/common/constants';
import { newOrderJobs } from '~/server/jobs/new-order-jobs';

type Rating = { userId: number; createdAt: Date; exp: number };
type Player = { userId: number; startAt: Date; rankType: string };

const grantJob = newOrderJobs.find((j) => j.name === 'new-order-grant-bless-buzz')!;

// 3 days before the (fake) run time, matching the job's own window.
const NOW = new Date('2026-11-15T12:00:00Z');
const day = dayjs(NOW).subtract(3, 'day');
const dayStart = day.startOf('day');
const at = (hours: number) => dayStart.add(hours, 'hour').toDate();
const before = dayStart.subtract(10, 'day').toDate();
const after = day.endOf('day').add(1, 'hour').toDate();

let ratings: Rating[] = [];
let players: Player[] = [];

// Answers the two grant queries by honouring their predicates; any other SQL throws so a
// reworded query cannot silently pass.
function fakeClickhouse(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''),
    ''
  );
  if (
    !sql.includes('FROM knights_new_order_image_rating FINAL') ||
    !sql.includes('GROUP BY userId')
  )
    throw new Error(`unexpected SQL: ${sql}`);
  const [from, to] = values.filter((v): v is Date => v instanceof Date);
  const ratio = values.find((v): v is number => typeof v === 'number')!;
  if (!from || !to || !ratio) throw new Error(`unparseable bounds: ${sql}`);

  const perUser = new Map<number, Date>();
  const conditions = [
    ...sql.matchAll(/userId = (\d+) AND createdAt >= parseDateTimeBestEffort\('([^']+)'\)/g),
  ];
  const restricted = sql.includes('parseDateTimeBestEffort');
  if (restricted && !conditions.length) throw new Error(`unparseable restriction: ${sql}`);
  for (const [, id, iso] of conditions) perUser.set(Number(id), new Date(iso));

  const totals = new Map<number, number>();
  for (const r of ratings) {
    if (r.createdAt < from || r.createdAt > to) continue;
    if (restricted) {
      const min = perUser.get(r.userId);
      if (!min || r.createdAt < min) continue;
    }
    totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.exp);
  }
  return Promise.resolve(
    [...totals].map(([userId, totalExp]) => ({
      userId,
      totalExp,
      balance: Math.floor(totalExp * ratio),
    }))
  );
}

const paid = () =>
  new Map(
    mocks.createBuzzTransactionMany.mock.calls
      .flatMap(([txs]) => txs as { toAccountId: number; amount: number }[])
      .map((t) => [t.toAccountId, t.amount])
  );
const decrements = () =>
  new Map(
    mocks.counters.blessed.decrement.mock.calls.map(([arg]) => [
      (arg as { id: number }).id,
      (arg as { value: number }).value,
    ])
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ratings = [];
  players = [];
  mocks.query.mockImplementation(fakeClickhouse);
  mocks.createBuzzTransactionMany.mockResolvedValue(undefined);
  mocks.counters.blessed.getAll.mockResolvedValue([]);
  dbMock.dbRead.newOrderPlayer.findMany.mockImplementation(
    ({ where }: { where: { userId?: { in: number[] }; rankType: { not: string } } }) =>
      // The released-payout catch-up queries without a userId filter and has no players here.
      Promise.resolve(
        where.userId
          ? players
              .filter(
                (p) => where.userId!.in.includes(p.userId) && p.rankType !== where.rankType.not
              )
              .map((p) => ({ ...p, payoutBlockedAt: null, user: { bannedAt: null } }))
          : []
      )
  );
});

describe('new-order-grant-bless-buzz and career resets', () => {
  it('pays a player whose career started before the day in full', async () => {
    players = [{ userId: 1, startAt: before, rankType: 'Knight' }];
    ratings = [{ userId: 1, createdAt: at(5), exp: 1000 }];

    await grantJob.run({}).result;

    expect(paid().get(1)).toBe(Math.floor(1000 * newOrderConfig.blessedBuzzConversionRatio));
    expect(decrements().get(1)).toBe(1000);
  });

  it('forfeits a day cast before a later reset, even though the player is a Knight again', async () => {
    players = [{ userId: 2, startAt: after, rankType: 'Knight' }];
    ratings = [{ userId: 2, createdAt: at(5), exp: 1000 }];

    await grantJob.run({}).result;

    expect(paid().has(2)).toBe(false);
    expect(decrements().has(2)).toBe(false);
    expect(mocks.counters.pending.reset).toHaveBeenCalledWith({ id: 2 });
  });

  it('pays only judgments at or after a reset that fell inside the day', async () => {
    players = [{ userId: 3, startAt: at(12), rankType: 'Templar' }];
    ratings = [
      { userId: 3, createdAt: at(6), exp: 5000 },
      { userId: 3, createdAt: at(12), exp: 1000 },
      { userId: 3, createdAt: at(18), exp: 2000 },
    ];

    await grantJob.run({}).result;

    expect(decrements().get(3)).toBe(3000);
    expect(paid().get(3)).toBe(Math.floor(3000 * newOrderConfig.blessedBuzzConversionRatio));
  });

  it('pays nothing when a mid-day reset has no judgments at or after startAt', async () => {
    players = [{ userId: 5, startAt: at(12), rankType: 'Knight' }];
    ratings = [
      { userId: 5, createdAt: at(3), exp: 4000 },
      { userId: 5, createdAt: at(11), exp: 4000 },
    ];

    await grantJob.run({}).result;

    expect(paid().has(5)).toBe(false);
    expect(decrements().has(5)).toBe(false);
  });

  it('keeps each player in a mixed batch on their own amount', async () => {
    const ratio = newOrderConfig.blessedBuzzConversionRatio;
    players = [
      { userId: 1, startAt: before, rankType: 'Knight' },
      { userId: 2, startAt: after, rankType: 'Knight' },
      { userId: 3, startAt: at(12), rankType: 'Templar' },
    ];
    ratings = [
      { userId: 1, createdAt: at(5), exp: 1100 },
      { userId: 2, createdAt: at(5), exp: 2300 },
      { userId: 3, createdAt: at(6), exp: 5000 },
      { userId: 3, createdAt: at(13), exp: 1700 },
    ];

    await grantJob.run({}).result;

    expect(paid()).toEqual(
      new Map([
        [1, Math.floor(1100 * ratio)],
        [3, Math.floor(1700 * ratio)],
      ])
    );
    expect(decrements()).toEqual(
      new Map([
        [1, 1100],
        [3, 1700],
      ])
    );
    expect(mocks.counters.pending.reset).toHaveBeenCalledWith({ id: 2 });
  });

  it('still excludes Acolytes', async () => {
    players = [{ userId: 4, startAt: before, rankType: 'Acolyte' }];
    ratings = [{ userId: 4, createdAt: at(5), exp: 1000 }];

    await grantJob.run({}).result;

    expect(paid().has(4)).toBe(false);
    expect(decrements().has(4)).toBe(false);
  });
});
