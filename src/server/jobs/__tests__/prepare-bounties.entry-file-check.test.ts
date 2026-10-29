import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FileCheck from '~/server/services/bounty-entry-file-check.service';

const { executedStatements, mockSettle, mockCheckOn } = vi.hoisted(() => ({
  executedStatements: [] as string[],
  mockSettle: vi.fn(async () => true),
  mockCheckOn: vi.fn(async () => true),
}));

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
vi.mock('~/server/services/bounty.service', () => ({
  settleBountyPayout: mockSettle,
  retryUnsettledBountyPayouts: vi.fn(),
  deleteSettledKeptBounties: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ bountiesSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/email/templates', () => {
  const template = { send: vi.fn(() => Promise.resolve()) };
  return {
    bountyAutomaticallyAwardedEmail: template,
    bountyExpiredEmail: template,
    bountyExpiredReminderEmail: template,
    bountyRefundedEmail: template,
  };
});
vi.mock('~/server/services/bounty-entry-file-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileCheck>()),
  isBountyEntryFileCheckOn: mockCheckOn,
}));

import { bountyJobs } from '~/server/jobs/prepare-bounties';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/** The expiry auto-award never picks an entry whose files are another user's model. */

const BOUNTY_ID = 4321;
const BLOCKED_ENTRY = 98;
const CLEAN_ENTRY = 99;
const CHECKED = { hashCheckedAt: '2026-10-20T00:00:00Z' };

loggingMock.logToAxiom.mockImplementation(() => ({ catch: vi.fn() }));
dbMock.dbWrite.$executeRawUnsafe.mockImplementation(async (sql: string) => {
  executedStatements.push(sql);
  return 1;
});

const runPrepareBounties = () =>
  (bountyJobs as unknown as { name: string; run: () => Promise<void> }[])
    .find((j) => j.name === 'prepare-bounties')!
    .run();

function expiredLoraBounty(entryFiles: { entryId: number; metadata: object }[]) {
  dbMock.dbWrite.bounty.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { id: BOUNTY_ID, userId: 1, name: 'b', user: { id: 1, email: 'owner@example.com' } },
    ])
    .mockResolvedValue([]);
  dbMock.dbWrite.bounty.findUnique.mockResolvedValue({ type: 'LoraCreation' });
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('FOR UPDATE')) return [{ complete: false, refunded: false }];
    if (sql.includes('SELECT currency FROM "BountyBenefactor"')) return [{ currency: 'BUZZ' }];
    if (sql.includes('JOIN "File" f')) return entryFiles;
    if (sql.includes('FROM "BountyEntry" be')) return [{ id: CLEAN_ENTRY, userId: 7 }];
    return [];
  });
}

/** The entry ids the winner query was told to leave out. */
const excludedFromWinner = () => {
  const call = dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]) => {
    const sql = (strings as TemplateStringsArray).join('');
    return sql.includes('FROM "BountyEntry" be') && !sql.includes('JOIN "File" f');
  });
  return call?.slice(1).find(Array.isArray);
};

beforeEach(() => {
  executedStatements.length = 0;
  vi.clearAllMocks();
  mockCheckOn.mockResolvedValue(true);
});

describe('prepare-bounties auto-award, entry file check', () => {
  it("leaves out an entry whose file is another user's model", async () => {
    expiredLoraBounty([
      { entryId: BLOCKED_ENTRY, metadata: { ...CHECKED, blockedReason: 'other-users-model' } },
      { entryId: CLEAN_ENTRY, metadata: CHECKED },
    ]);

    await runPrepareBounties();

    expect(excludedFromWinner()).toEqual([BLOCKED_ENTRY]);
    expect(mockSettle).toHaveBeenCalled();
  });

  it('waits, awarding nothing, while any entry file is unchecked', async () => {
    expiredLoraBounty([
      { entryId: CLEAN_ENTRY, metadata: CHECKED },
      { entryId: BLOCKED_ENTRY, metadata: {} },
    ]);

    await runPrepareBounties();

    expect(excludedFromWinner()).toBeUndefined();
    expect(executedStatements).toEqual([]);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('control: with the check off, no entry is left out and nothing waits', async () => {
    mockCheckOn.mockResolvedValue(false);
    expiredLoraBounty([{ entryId: BLOCKED_ENTRY, metadata: {} }]);

    await runPrepareBounties();

    expect(excludedFromWinner()).toEqual([]);
    expect(mockSettle).toHaveBeenCalled();
  });
});
