import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rows = Record<string, unknown>[];
const ownLogins = vi.fn(async (): Promise<Rows> => []);
const neighbours = vi.fn(async (): Promise<Rows> => []);
const counterparties = vi.fn(async (): Promise<Rows> => []);
const query = vi.fn(async (sql: string): Promise<Rows> => {
  if (sql.includes('buzzTransactions')) return counterparties();
  if (sql.includes(`targetUserId = ${SUBJECT}`)) return ownLogins();
  return neighbours();
});
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: query }) }));

const createdAt = vi.fn(
  async (): Promise<unknown> => ({ createdAt: new Date('2026-10-01T00:00:00Z') })
);
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: () => ({ select: () => ({ where: () => ({ executeTakeFirst: createdAt }) }) }),
  },
}));

const getSharedIpRows = vi.fn(async () => ({ rows: [] as unknown[], truncated: false }));
const getSharedSocialAccounts = vi.fn(async () => ({
  accounts: [] as unknown[],
  truncated: false,
}));
vi.mock('../user-signals.service', () => ({ getSharedIpRows, getSharedSocialAccounts }));
vi.mock('../users.service', () => ({
  usersByIds: async (ids: number[]) =>
    new Map(ids.map((id) => [id, { username: `u${id}`, bannedAt: null, muted: false }])),
}));
const strikeCountsByUserIds = vi.fn(async (): Promise<Map<number, number>> => new Map());
vi.mock('../moderation-memory.service', () => ({ strikeCountsByUserIds }));

const SUBJECT = 100;
const { getLinkedAccounts } = await import('../linked-accounts.service');
const { parseLinkConfig } = await import('../linked-accounts-config');

const ON = { nearLogin: { windowSeconds: 1000, loginSample: 50 }, buzz: { lookbackDays: 30 } };

beforeEach(() => {
  vi.clearAllMocks();
  ownLogins.mockResolvedValue([]);
  neighbours.mockResolvedValue([]);
  counterparties.mockResolvedValue([]);
  getSharedIpRows.mockResolvedValue({ rows: [], truncated: false });
  strikeCountsByUserIds.mockResolvedValue(new Map());
});

describe('parseLinkConfig', () => {
  it('turns every threshold signal off when nothing is configured', () => {
    expect(parseLinkConfig({})).toEqual({ nearLogin: null, buzz: null });
  });

  it.each(['0', '-5', '1.5', 'ten', '99999999'])('treats %s as not configured', (bad) => {
    expect(
      parseLinkConfig({
        LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: bad,
        LINKED_ACCOUNTS_LOGIN_SAMPLE: '50',
        LINKED_ACCOUNTS_BUZZ_LOOKBACK_DAYS: bad,
      })
    ).toEqual({ nearLogin: null, buzz: null });
  });

  it('needs both login settings for the login signal', () => {
    const only = parseLinkConfig({ LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: '60' });
    expect(only.nearLogin).toBeNull();
    expect(
      parseLinkConfig({
        LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: '60',
        LINKED_ACCOUNTS_LOGIN_SAMPLE: '50',
      }).nearLogin
    ).toEqual({ windowSeconds: 60, loginSample: 50 });
  });
});

describe('getLinkedAccounts', () => {
  it('reports unconfigured signals as off and never queries them', async () => {
    const result = await getLinkedAccounts(SUBJECT, { nearLogin: null, buzz: null });
    expect(result.status).toEqual({ regIp: 'ok', nearLogin: 'off', buzz: 'off', social: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('merges one account found by two signals into one row, ranked above a single-signal one', async () => {
    ownLogins.mockResolvedValue([{ ip: '1.1.1.1', ts: '5000' }]);
    neighbours.mockResolvedValue([
      { userId: '7', ip: '1.1.1.1', ts: '5030' },
      { userId: '8', ip: '1.1.1.1', ts: '5010' },
    ]);
    counterparties.mockResolvedValue([
      { other: '9', outCount: '0', inCount: '20', outAmount: '0', inAmount: '9000' },
      { other: '7', outCount: '3', inCount: '4', outAmount: '30', inAmount: '40' },
    ]);

    const { accounts } = await getLinkedAccounts(SUBJECT, ON);

    expect(accounts.map((a) => a.userId)).toEqual([7, 8]);
    expect(accounts[0]).toMatchObject({
      nearLogin: { closestSeconds: 30, logins: 1 },
      buzz: { rank: 2, inCount: 4, outCount: 3 },
    });
  });

  it('measures the gap against logins on the SAME address only', async () => {
    ownLogins.mockResolvedValue([
      { ip: '1.1.1.1', ts: '1000' },
      { ip: '2.2.2.2', ts: '2000' },
    ]);
    neighbours.mockResolvedValue([{ userId: '7', ip: '2.2.2.2', ts: '1010' }]);

    const { accounts } = await getLinkedAccounts(SUBJECT, ON);
    expect(accounts[0].nearLogin?.closestSeconds).toBe(990);
  });

  it('keeps an address that fails the IP pattern out of the neighbour query', async () => {
    ownLogins.mockResolvedValue([
      { ip: "1.1.1.1') OR 1=1 --", ts: '1000' },
      { ip: '2.2.2.2', ts: '2000' },
    ]);

    await getLinkedAccounts(SUBJECT, ON);
    const neighbourSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('2.2.2.2'));
    expect(neighbourSql).toBeDefined();
    expect(neighbourSql).not.toContain('OR 1=1');
  });

  it('still returns the other signals when one fails', async () => {
    counterparties.mockRejectedValue(new Error('clickhouse down'));
    getSharedIpRows.mockResolvedValue({
      rows: [{ userId: 5, ip: '3.3.3.3', type: 'Registration', last: '' }],
      truncated: false,
    });

    const result = await getLinkedAccounts(SUBJECT, ON);
    expect(result.status.buzz).toBe('failed');
    expect(result.accounts.map((a) => a.userId)).toEqual([5]);
  });

  it('keeps the list when strike counts fail, reporting them as unknown rather than zero', async () => {
    strikeCountsByUserIds.mockRejectedValue(new Error('moderator db down'));
    getSharedIpRows.mockResolvedValue({
      rows: [{ userId: 5, ip: '3.3.3.3', type: 'Registration', last: '' }],
      truncated: false,
    });

    const { accounts } = await getLinkedAccounts(SUBJECT, ON);
    expect(accounts).toMatchObject([{ userId: 5, strikes: null }]);
  });
});
