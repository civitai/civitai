import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import type * as EmailClient from '~/server/email/client';
import type * as BankingChangeNoticeEmail from '~/server/email/templates/bankingChangeNotice.email';
import type * as CreatorMembershipService from '~/server/services/creator-membership.service';

const { chQuery, emailConfiguredMock, sendMock, validMembershipMock } = vi.hoisted(() => ({
  chQuery: vi.fn(),
  emailConfiguredMock: vi.fn(),
  sendMock: vi.fn(),
  validMembershipMock: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clickhouse: { $query: chQuery },
}));
vi.mock('~/server/services/creator-membership.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorMembershipService>()),
  getValidCreatorMembershipMap: validMembershipMock,
}));
vi.mock('~/server/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailClient>()),
  isEmailConfigured: emailConfiguredMock,
}));
vi.mock('~/server/email/templates/bankingChangeNotice.email', async (importOriginal) => ({
  ...(await importOriginal<typeof BankingChangeNoticeEmail>()),
  bankingChangeNoticeEmail: { send: sendMock },
}));

const { sendBankingChangeNotice, getBankingChangeNoticeAudience } = await import(
  '~/server/services/banking-change-notice.service'
);

type Row = {
  id: number;
  email: string | null;
  username: string | null;
  onboarding: number;
  bannedAt: Date | null;
  deletedAt: Date | null;
};
const user = (id: number, overrides: Partial<Row> = {}): Row => ({
  id,
  email: `u${id}@example.com`,
  username: `u${id}`,
  onboarding: OnboardingSteps.CreatorProgram,
  bannedAt: null,
  deletedAt: null,
  ...overrides,
});

let ledger: Map<string, string>;
let bankers: number[];
let flagged: number[];
let validMembers: Set<number>;
let rows: Row[];

beforeEach(() => {
  vi.clearAllMocks();
  ledger = new Map();
  bankers = [];
  flagged = [];
  validMembers = new Set();
  rows = [];
  sendMock.mockReset().mockResolvedValue(undefined);
  emailConfiguredMock.mockReset().mockReturnValue(true);

  chQuery.mockReset().mockImplementation(async () => bankers.map((userId) => ({ userId })));
  validMembershipMock
    .mockReset()
    .mockImplementation(
      async (ids: number[]) => new Map(ids.map((id) => [id, validMembers.has(id)]))
    );
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('').includes('"bannedAt"')) return flagged.map((id) => ({ id }));
      const candidates = values[0] as number[];
      return rows.filter((r) => candidates.includes(r.id));
    }
  );

  const sys = redisMock.sysRedis;
  sys.hmGet.mockImplementation(async (_key: string, fields: string[]) =>
    fields.map((f) => ledger.get(f) ?? null)
  );
  sys.hSetNX.mockImplementation(async (_key: string, field: string, value: string) => {
    if (ledger.has(field)) return false;
    ledger.set(field, value);
    return true;
  });
  sys.hDel.mockImplementation(async (_key: string, field: string) =>
    ledger.delete(field) ? 1 : 0
  );
  sys.expireAt.mockResolvedValue(true);
});

const sentTo = () => sendMock.mock.calls.map(([data]) => data.to).sort();

describe('getBankingChangeNoticeAudience', () => {
  it('takes recent bankers plus valid members, and drops banned, deleted and program-banned accounts', async () => {
    bankers = [1, 2, 3, 4];
    flagged = [5, 6];
    validMembers = new Set([5]);
    rows = [
      user(1),
      user(2, { bannedAt: new Date() }),
      user(3, { deletedAt: new Date() }),
      user(4, { onboarding: OnboardingSteps.BannedCreatorProgram }),
      user(5),
      user(6),
      user(7),
    ];

    const audience = await getBankingChangeNoticeAudience();

    expect(audience.recipients.map((r) => r.id).sort()).toEqual([1, 5]);
    expect(audience).toMatchObject({ bankers: 1, members: 1 });
    expect(validMembershipMock).toHaveBeenCalledWith([5, 6]);
  });

  it('asks ClickHouse for creator-program bank transfers in the last 12 months, and Postgres for the program flag', async () => {
    await getBankingChangeNoticeAudience();

    expect(chQuery.mock.calls[0][0].join('?').replace(/\s+/g, ' ').trim()).toBe(
      "SELECT DISTINCT fromAccountId AS userId FROM buzzTransactions WHERE type = 'bank' AND toAccountType IN ('creatorProgramBank', 'creatorProgramBankGreen') AND date >= now() - INTERVAL 12 MONTH"
    );

    const [flagStrings, flag] = dbMock.dbRead.$queryRaw.mock.calls[0];
    expect(flagStrings.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM "User" WHERE onboarding & ? != 0'
    );
    expect(flag).toBe(OnboardingSteps.CreatorProgram);
  });

  it('loads user rows only for the candidate ids', async () => {
    bankers = [1];
    rows = [user(1)];
    await getBankingChangeNoticeAudience();

    const [rowStrings, ids] = dbMock.dbRead.$queryRaw.mock.calls[1];
    expect(rowStrings.join('?').replace(/\s+/g, ' ')).toMatch(
      /FROM "User" WHERE id = ANY\(\?\)\s*$/
    );
    expect(ids).toEqual([1]);
  });
});

describe('sendBankingChangeNotice', () => {
  beforeEach(() => {
    bankers = [1, 2, 3];
    rows = [user(1), user(2), user(3), user(4, { email: null })];
    flagged = [4];
    validMembers = new Set([4]);
  });

  it('a dry run sends nothing and records nothing', async () => {
    const result = await sendBankingChangeNotice({ dryRun: true, count: 50, batchSize: 10 });

    expect(result).toMatchObject({ dryRun: true, eligible: 4, noEmail: 1, wouldSend: 3 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
    expect(ledger.size).toBe(0);
  });

  it('refuses to send, and records nobody, when email is not configured', async () => {
    emailConfiguredMock.mockReturnValue(false);

    await expect(
      sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 10 })
    ).rejects.toThrow('Email is not configured');
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger.size).toBe(0);
  });

  it('sends each recipient once, and a second run sends nobody', async () => {
    const first = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 2 });
    expect(first).toMatchObject({ sent: 3, failed: 0, remaining: 0 });
    expect(sentTo()).toEqual(['u1@example.com', 'u2@example.com', 'u3@example.com']);
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledWith(
      'notices:banking-change-sent',
      new Date('2027-03-01T00:00:00Z')
    );

    sendMock.mockClear();
    const second = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 2 });
    expect(second).toMatchObject({ sent: 0, alreadySent: 3 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips a user another run claimed after this run read the ledger', async () => {
    redisMock.sysRedis.hmGet.mockImplementation(async (_key: string, fields: string[]) =>
      fields.map(() => null)
    );
    ledger.set('2', 'claimed elsewhere');

    const result = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 10 });

    expect(result).toMatchObject({ sent: 2, skipped: 1 });
    expect(sentTo()).toEqual(['u1@example.com', 'u3@example.com']);
  });

  it('sends at most `count`, and the next run picks up the rest', async () => {
    const first = await sendBankingChangeNotice({ dryRun: false, count: 2, batchSize: 10 });
    expect(first).toMatchObject({ sent: 2, remaining: 1 });

    sendMock.mockClear();
    const second = await sendBankingChangeNotice({ dryRun: false, count: 2, batchSize: 10 });
    expect(second).toMatchObject({ sent: 1, remaining: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('releases a failed send so the next run retries it', async () => {
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('rejected');
    });

    const first = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 10 });
    expect(first).toMatchObject({ sent: 2, failed: 1, failedUserIds: [2] });
    expect(ledger.has('2')).toBe(false);

    sendMock.mockReset().mockResolvedValue(undefined);
    const second = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 10 });
    expect(second).toMatchObject({ sent: 1 });
    expect(sentTo()).toEqual(['u2@example.com']);
  });

  it('reports a failed send whose release also failed as stuck, and finishes the run', async () => {
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('rejected');
    });
    redisMock.sysRedis.hDel.mockRejectedValue(new Error('redis down'));

    const result = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 10 });

    expect(result).toMatchObject({ sent: 2, failedUserIds: [2], stuckUserIds: [2] });
  });
});
