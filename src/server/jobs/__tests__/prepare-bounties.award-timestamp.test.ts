import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, executedStatements, mockCreateBuzzTransactionMany, mockQueueUpdate } =
  vi.hoisted(() => {
    const executedStatements: string[] = [];
    return {
      executedStatements,
      mockCreateBuzzTransactionMany: vi.fn(),
      mockQueueUpdate: vi.fn(),
      mockDbWrite: {
        bounty: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(async (sql: string) => {
          executedStatements.push(sql);
          return 1;
        }),
        $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
      },
    };
  });

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [new Date(0), vi.fn()],
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: vi.fn() }) }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    bounty = vi.fn(() => Promise.resolve());
    bountyEntry = vi.fn(() => Promise.resolve());
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getMultiAccountTransactionsByPrefix: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/bounty.service', () => ({ isBountyTransactionPrefix: () => false }));
vi.mock('~/server/search-index', () => ({
  bountiesSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/server/email/templates', () => {
  const template = { send: vi.fn(() => Promise.resolve()) };
  return {
    bountyAutomaticallyAwardedEmail: template,
    bountyExpiredEmail: template,
    bountyExpiredReminderEmail: template,
    bountyRefundedEmail: template,
  };
});

import { bountyJobs } from '~/server/jobs/prepare-bounties';

const BOUNTY_ID = 4321;
const WINNER_ENTRY_ID = 99;

// `createJob` is mocked to return the bare handler, so the exported job IS the function.
const runPrepareBounties = bountyJobs[0] as unknown as () => Promise<void>;

describe('prepare-bounties auto-award', () => {
  beforeEach(() => {
    executedStatements.length = 0;
    vi.clearAllMocks();

    // Only the third findMany (the award/refund sweep) should yield a bounty; the two
    // earlier ones drive expiry emails and are irrelevant here.
    mockDbWrite.bounty.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: BOUNTY_ID,
          userId: 1,
          name: 'Test bounty',
          user: { id: 1, email: 'owner@example.com' },
        },
      ])
      .mockResolvedValue([]);

    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('SELECT currency FROM "BountyBenefactor"')) return [{ currency: 'BUZZ' }];
      if (sql.includes('FROM "BountyEntry" be'))
        return [{ id: WINNER_ENTRY_ID, userId: 7, awardedUnitAmount: 0 }];
      // Unawarded benefactors funding the win.
      return [{ userId: 1, unitAmount: 500, buzzTransactionId: null }];
    });
  });

  it('stamps awardedAt alongside awardedToId so the bounty-awarded notification can fire', async () => {
    await runPrepareBounties();

    const benefactorUpdate = executedStatements.find((sql) =>
      sql.includes('UPDATE "BountyBenefactor"')
    );

    expect(benefactorUpdate).toBeDefined();
    expect(benefactorUpdate).toContain(`"awardedToId" = ${WINNER_ENTRY_ID}`);
    // notifications/bounty.notifications.ts filters on `bb."awardedAt" > lastSent`, so an
    // award that leaves awardedAt NULL is never announced to the winning entrant.
    expect(benefactorUpdate).toMatch(/"awardedAt"\s*=\s*NOW\(\)/i);
  });

  it('still completes the bounty and pays the winner', async () => {
    await runPrepareBounties();

    expect(executedStatements.some((sql) => sql.includes('UPDATE "Bounty"'))).toBe(true);
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({ toAccountId: 7, amount: 500 }),
    ]);
  });
});
