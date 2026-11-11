import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockSaveFlag, mockQuery } = vi.hoisted(() => ({
  mockSaveFlag: vi.fn<(flag: { userId: number; signals: string[] }) => Promise<unknown>>(
    async () => ({ created: true, reopened: false })
  ),
  mockQuery: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockQuery } }));
vi.mock('~/server/services/creator-program-prepayout-review/store', () => ({
  createPayoutReviewStore: () => ({
    startRun: async () => 7,
    finishRun: async () => undefined,
    saveFlag: mockSaveFlag,
    getCarriedUserIds: async () => [],
  }),
}));
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { abuseReport: async () => undefined },
}));
vi.mock('~/server/services/chat.service', () => ({ upsertChat: vi.fn(), createMessage: vi.fn() }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({
    name,
    cron,
    run: () => ({ result: fn(), cancel: () => Promise.resolve() }),
    options: {},
  }),
}));

import { creatorProgramPrepayoutReview } from '~/server/jobs/creator-program-prepayout-review';

const { PREPAYOUT_LIMITS, COUNTERPARTY_REVIEW_MIN, COUNTERPARTY_REVIEW_WARNINGS } =
  REDIS_SYS_KEYS.CREATOR_PROGRAM;

// Synthetic values for this test only.
const limits = {
  counterparty: 1_000,
  singlePayerShare: 0.9,
  singlePayerAmount: 900,
  payoutJump: 50,
  batchPayer: 9_999_999,
  youngPayerDays: 10,
  payoutJumpPercentile: 0.5,
  historyPeriods: 2,
};

// 2 exchanges Buzz both ways with 900 over the limit; 3 exchanges 600 both ways with 901, under the
// limit; 5 is paid almost all of their earnings by 800.
const rows = {
  batch: [
    { userId: 2, payoutCents: 6_000 },
    { userId: 3, payoutCents: 7_000 },
    { userId: 5, payoutCents: 5_000 },
  ],
  totals: [
    { userId: 2, amount: 500_000 },
    { userId: 3, amount: 500_000 },
    { userId: 5, amount: 1_000 },
  ],
  pairs: [
    { userId: 2, payerId: 900, received: 3_000, sent: 2_500 },
    { userId: 3, payerId: 901, received: 600, sent: 600 },
    { userId: 5, payerId: 800, received: 950, sent: 0 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-11-01T06:00:00Z'), toFake: ['Date'] });
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('substring(externalTransactionId')) return [];
    if (sql.includes("toAccountType = 'cashPending'")) return rows.batch;
    if (sql.includes('LEFT JOIN')) return rows.pairs;
    return rows.totals;
  });
  redisMock.sysRedis.get.mockImplementation(async (key: string) =>
    key === PREPAYOUT_LIMITS
      ? JSON.stringify(limits)
      : key === COUNTERPARTY_REVIEW_MIN
      ? '500'
      : null
  );
  dbMock.dbRead.$queryRaw.mockResolvedValue(
    [1, 2, 3, 5, 800, 900, 901].map((id) => ({
      id,
      username: `u${id}`,
      createdAt: new Date('2024-01-01'),
      muted: false,
      banned: false,
      programBanned: false,
      pendingRestriction: false,
    }))
  );
  return () => vi.useRealTimers();
});

describe('creatorProgramPrepayoutReview', () => {
  // Creator 3 has an entry left over from when the counterparty review messaged creators, and
  // exchanges more than the counterparty review's minimum: that alone no longer holds a payout.
  it('holds nobody for an earlier counterparty-review entry; the other signals still fire', async () => {
    redisMock.sysRedis.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      fields.map((f) =>
        key === COUNTERPARTY_REVIEW_WARNINGS && f === '3'
          ? JSON.stringify({
              warnedAt: '2026-09-02T10:00:00.000Z',
              chatId: 5,
              counterparties: { '901': 600 },
            })
          : null
      )
    );

    await creatorProgramPrepayoutReview.run().result;

    expect(mockSaveFlag.mock.calls.map(([f]) => [f.userId, f.signals])).toEqual([
      [2, ['counterparty']],
      [5, ['single-payer']],
    ]);
  });
});
