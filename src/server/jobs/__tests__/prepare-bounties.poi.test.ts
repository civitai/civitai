import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hand-listed like prepare-bounties.award-timestamp.test.ts: the job's graph builds buzz, email,
// search-index and ClickHouse clients at load.
const { executedStatements, mockCreateBuzzTransactionMany, mockSettle, mockSetLastRun, emails } =
  vi.hoisted(() => ({
    executedStatements: [] as string[],
    mockCreateBuzzTransactionMany: vi.fn(),
    mockSettle: vi.fn(async () => true),
    mockSetLastRun: vi.fn(),
    emails: {
      expired: vi.fn(() => Promise.resolve()),
      reminder: vi.fn(() => Promise.resolve()),
      refunded: vi.fn(() => Promise.resolve()),
      awarded: vi.fn(() => Promise.resolve()),
    },
  }));

vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [new Date(0), mockSetLastRun],
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
  retryUnsettledBountyPayouts: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ bountiesSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/email/templates', () => ({
  bountyExpiredEmail: { send: emails.expired },
  bountyExpiredReminderEmail: { send: emails.reminder },
  bountyRefundedEmail: { send: emails.refunded },
  bountyAutomaticallyAwardedEmail: { send: emails.awarded },
}));

import { bountyJobs } from '~/server/jobs/prepare-bounties';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbWrite = dbMock.dbWrite;
const runPrepareBounties = bountyJobs[0] as unknown as () => Promise<void>;

const OPEN_POI = { textScanFlags: { poi: { workflowId: 'wf', reason: 'r', textHash: 'h' } } };
const HIDDEN = { poi: true, availability: 'Private', meta: OPEN_POI };
const row = (id: number) => ({
  id,
  userId: 1,
  name: `Bounty ${id}`,
  user: { id: 1, email: 'owner@example.com', username: 'owner' },
  _count: { entries: 1 },
});

let locked: Record<number, Record<string, unknown>>;

function sweep(ids: number[], { expired = [] as number[], reminder = [] as number[] } = {}) {
  mockDbWrite.bounty.findMany
    .mockResolvedValueOnce(expired.map(row))
    .mockResolvedValueOnce(reminder.map(row))
    .mockResolvedValueOnce(ids.map(row))
    .mockResolvedValue([]);
}

beforeEach(() => {
  executedStatements.length = 0;
  vi.clearAllMocks();
  locked = {};
  loggingMock.logToAxiom.mockImplementation(() => ({ catch: vi.fn() }));
  mockDbWrite.$executeRawUnsafe.mockImplementation(async (sql: string) => {
    executedStatements.push(sql);
    return 1;
  });
  mockDbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('FOR UPDATE')) {
        const id = values[0] as number;
        return [
          {
            complete: false,
            refunded: false,
            poi: false,
            availability: 'Public',
            meta: null,
            ...locked[id],
          },
        ];
      }
      if (sql.includes('SELECT currency FROM "BountyBenefactor"')) return [{ currency: 'BUZZ' }];
      if (sql.includes('FROM "BountyEntry" be')) return [{ id: 99, userId: 7 }];
      return [{ userId: 1, unitAmount: 500, buzzTransactionId: null }];
    }
  );
});

describe('prepare-bounties — a bounty hidden by a text-scan poi flag', () => {
  it('is claimed as refunded under the lock and refunds only unawarded benefactors', async () => {
    locked[7] = HIDDEN;
    sweep([7]);

    await runPrepareBounties();

    expect(
      executedStatements.some((sql) => sql.includes('UPDATE "BountyBenefactor"')),
      `no benefactor award write expected; executed:\n${executedStatements.join('\n')}`
    ).toBe(false);
    expect(
      executedStatements.some((sql) =>
        /"complete" = true, "refunded" = true, "payoutRecordedAt" = NOW\(\) WHERE b.id = 7/.test(
          sql
        )
      ),
      `expected the refunded claim for bounty 7; executed:\n${executedStatements.join('\n')}`
    ).toBe(true);
    expect(mockSettle).toHaveBeenCalledWith(7, {
      firstAttempt: true,
      refundDescription: 'Reason: Bounty refund, bounty hidden pending review',
    });
    expect(mockCreateBuzzTransactionMany).not.toHaveBeenCalled();
    expect(emails.refunded).toHaveBeenCalledTimes(1);
    expect(emails.awarded).not.toHaveBeenCalled();
  });

  it('refunds nothing when another path already claimed it', async () => {
    locked[7] = { ...HIDDEN, complete: true };
    sweep([7]);

    await runPrepareBounties();

    expect(mockSettle).not.toHaveBeenCalled();
    expect(executedStatements).toEqual([]);
  });

  it.each([
    [
      'a granted appeal',
      {
        poi: false,
        availability: 'Public',
        meta: {
          textScanFlags: {
            poi: { ...OPEN_POI.textScanFlags.poi, appealGranted: { at: 'x', by: 1 } },
          },
        },
      },
    ],
    [
      'a moderator-set private bounty with no text-scan flag',
      { poi: true, availability: 'Private' },
    ],
  ])('pays out as before for %s', async (_label, state) => {
    locked[7] = state;
    sweep([7]);

    await runPrepareBounties();

    expect(
      executedStatements.some((sql) => sql.includes('UPDATE "BountyBenefactor"')),
      `expected the award; executed:\n${executedStatements.join('\n')}`
    ).toBe(true);
    expect(mockSettle).toHaveBeenCalledExactlyOnceWith(7, { firstAttempt: true });
  });

  it('sends no expiry or reminder email for a hidden bounty', async () => {
    mockDbWrite.bounty.findMany
      .mockResolvedValueOnce([{ ...row(7), ...HIDDEN }, row(8)])
      .mockResolvedValueOnce([{ ...row(7), ...HIDDEN }, row(8)])
      .mockResolvedValue([]);

    await runPrepareBounties();

    expect(emails.expired).toHaveBeenCalledTimes(1);
    expect(emails.expired).toHaveBeenCalledWith(
      expect.objectContaining({ bounty: expect.objectContaining({ id: 8 }) })
    );
    expect(emails.reminder).toHaveBeenCalledTimes(1);
    expect(emails.reminder).toHaveBeenCalledWith(
      expect.objectContaining({ bounty: expect.objectContaining({ id: 8 }) })
    );
  });
});

describe('prepare-bounties — one bounty failing', () => {
  it('logs the bounty, carries on with the next, and still records the run', async () => {
    sweep([7, 8]);
    const realTransaction = mockDbWrite.$transaction.getMockImplementation();
    mockDbWrite.$transaction.mockImplementationOnce(async () => {
      throw new Error('lock timeout');
    });
    if (realTransaction) mockDbWrite.$transaction.mockImplementation(realTransaction);

    await runPrepareBounties();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', data: expect.objectContaining({ bountyId: 7 }) }),
      'webhooks'
    );
    expect(mockSettle).toHaveBeenCalledExactlyOnceWith(8, { firstAttempt: true });
    expect(mockSetLastRun).toHaveBeenCalled();
  });
});
