import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import type * as BankingChangeNoticeEmail from '~/server/email/templates/bankingChangeNotice.email';
import type * as CreatorMembershipService from '~/server/services/creator-membership.service';

const { chQuery, sendMock, validMembershipMock } = vi.hoisted(() => ({
  chQuery: vi.fn(),
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
  ledger = new Map();
  bankers = [];
  flagged = [];
  validMembers = new Set();
  rows = [];
  sendMock.mockReset().mockResolvedValue(undefined);

  chQuery.mockReset().mockImplementation(async () => bankers.map((userId) => ({ userId })));
  validMembershipMock
    .mockReset()
    .mockImplementation(
      async (ids: number[]) => new Map(ids.map((id) => [id, validMembers.has(id)]))
    );
  dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    if (strings.join('').includes('"bannedAt"')) return rows;
    return flagged.map((id) => ({ id }));
  });

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
    ];

    const audience = await getBankingChangeNoticeAudience();

    expect(audience.recipients.map((r) => r.id).sort()).toEqual([1, 5]);
    expect(audience).toMatchObject({ bankers: 1, members: 1 });
    expect(validMembershipMock).toHaveBeenCalledWith([5, 6]);
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

  it('sends each recipient once, and a second run sends nobody', async () => {
    const first = await sendBankingChangeNotice({ dryRun: false, count: 50, batchSize: 2 });
    expect(first).toMatchObject({ sent: 3, failed: 0, remaining: 0 });
    expect(sentTo()).toEqual(['u1@example.com', 'u2@example.com', 'u3@example.com']);

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
});
