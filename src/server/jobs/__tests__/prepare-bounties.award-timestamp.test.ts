import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  executedStatements,
  mockCreateBuzzTransactionMany,
  mockQueueUpdate,
  mockSettle,
  mockRetry,
} = vi.hoisted(() => {
  const executedStatements: string[] = [];
  return {
    executedStatements,
    mockCreateBuzzTransactionMany: vi.fn(),
    mockQueueUpdate: vi.fn(),
    mockSettle: vi.fn(async () => true),
    mockRetry: vi.fn(async () => ({ settled: 0 })),
  };
});

// The real job shape, `{ name, cron, run }`, with `run` calling the handler directly.
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => unknown) => ({
    name,
    cron,
    run: () => fn({}),
  }),
  getJobDate: async () => [new Date(0), vi.fn()],
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => vi.fn() }));
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
vi.mock('~/server/services/bounty.service', () => ({
  settleBountyPayout: mockSettle,
  retryUnsettledBountyPayouts: mockRetry,
}));
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
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation(() => ({ catch: vi.fn() }));
dbMock.dbWrite.$executeRawUnsafe.mockImplementation(async (sql: string) => {
  executedStatements.push(sql);
  return 1;
});
const lockedBounty = { complete: false, refunded: false };

const BOUNTY_ID = 4321;
const WINNER_ENTRY_ID = 99;
const OWNER_ID = 1;

const jobNamed = (name: string) => {
  const job = (bountyJobs as unknown as { name: string; cron: string; run: () => unknown }[]).find(
    (j) => j.name === name
  );
  if (!job) throw new Error(`no bounty job named ${name}`);
  return job;
};
const runPrepareBounties = () => jobNamed('prepare-bounties').run() as Promise<void>;

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
          userId: OWNER_ID,
          name: 'Test bounty',
          user: { id: OWNER_ID, email: 'owner@example.com' },
        },
      ])
      .mockResolvedValue([]);

    lockedBounty.complete = false;
    lockedBounty.refunded = false;
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('FOR UPDATE')) return [{ ...lockedBounty }];
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

  it('records the award on the bounty and settles its payout', async () => {
    await runPrepareBounties();

    expect(
      executedStatements.some((sql) =>
        /"complete" = true, "payoutRecordedAt" = NOW\(\), "payoutWinnerUserId" = 7\s+WHERE b.id = 4321/.test(
          sql
        )
      )
    ).toBe(true);
    expect(mockSettle).toHaveBeenCalledExactlyOnceWith(BOUNTY_ID, { firstAttempt: true });
  });

  it('never picks an entry whose author is gone as the winner', async () => {
    await runPrepareBounties();
    const winnerQuery = mockDbWrite.$queryRaw.mock.calls
      .map((c: unknown[]) => (c[0] as readonly string[]).join('?'))
      .find((sql: string) => sql.includes('FROM "BountyEntry" be'));
    expect(winnerQuery).toContain('AND be."userId" IS NOT NULL');
  });

  it("never picks the owner's entry or one funded by its own author's unawarded pledge", async () => {
    await runPrepareBounties();

    const winnerCall = mockDbWrite.$queryRaw.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('FROM "BountyEntry" be')
    );
    expect(winnerCall).toBeDefined();
    const [strings, ...values] = winnerCall as [TemplateStringsArray, ...unknown[]];

    expect(strings.join('?').replace(/\s+/g, ' ')).toContain(
      'WHERE be."bountyId" = ? AND be."userId" IS NOT NULL ' +
        'AND NOT EXISTS ( SELECT 1 FROM "BountyBenefactor" own ' +
        'WHERE own."bountyId" = ? AND own."userId" = be."userId" ' +
        'AND own.currency = ?::"Currency" AND own."awardedToId" IS NULL ) ' +
        'AND be."userId" IS DISTINCT FROM ? GROUP BY'
    );
    expect(values).toEqual(['BUZZ', BOUNTY_ID, BOUNTY_ID, 'BUZZ', OWNER_ID]);
  });

  it('refunds supporters when the winner query returns no entry', async () => {
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('FOR UPDATE')) return [{ ...lockedBounty }];
      if (sql.includes('SELECT currency FROM "BountyBenefactor"')) return [{ currency: 'BUZZ' }];
      return [];
    });
    await runPrepareBounties();
    expect(
      executedStatements.some((sql) => sql.includes('"refunded" = true, "payoutRecordedAt"'))
    ).toBe(true);
    expect(executedStatements.some((sql) => sql.includes('UPDATE "BountyBenefactor"'))).toBe(false);
    expect(mockSettle).toHaveBeenCalledWith(
      BOUNTY_ID,
      expect.objectContaining({ firstAttempt: true })
    );
  });

  it('logs an award whose payout did not settle, for the retry job to pay', async () => {
    mockSettle.mockResolvedValueOnce(false);
    await runPrepareBounties();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bountyId: BOUNTY_ID }) }),
      'webhooks'
    );
  });

  it('writes the award under the payout lock, before any Buzz moves', async () => {
    const order: string[] = [];
    mockDbWrite.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const result = await cb(mockDbWrite);
      order.push('commit');
      return result;
    });
    mockSettle.mockImplementationOnce(async () => {
      order.push('award');
      return true;
    });

    await runPrepareBounties();

    const lockCall = mockDbWrite.$queryRaw.mock.calls.findIndex((c: unknown[]) =>
      (c[0] as readonly string[]).join('').includes('FOR UPDATE')
    );
    expect(lockCall).toBe(0);
    expect(order).toEqual(['commit', 'award']);
  });

  it('skips a bounty another path already claimed, moving no Buzz', async () => {
    lockedBounty.complete = true;
    await runPrepareBounties();
    expect(executedStatements).toEqual([]);
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

describe('bounty-payout-retry', () => {
  it('is an hourly bounty job that retries unsettled payouts', async () => {
    const job = jobNamed('bounty-payout-retry');
    expect(job.cron).toBe('41 * * * *');
    await job.run();
    expect(mockRetry).toHaveBeenCalledOnce();
  });
});
