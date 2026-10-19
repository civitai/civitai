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
const getSharedSocialRows = vi.fn(async () => ({ rows: [] as unknown[], truncated: false }));
vi.mock('../user-signals.service', () => ({ getSharedIpRows, getSharedSocialRows }));
vi.mock('../users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users.service')>()),
  usersByIds: async (ids: number[]) =>
    new Map(
      ids.map((id) => [id, { username: `u${id}`, bannedAt: null, muted: false, deletedAt: null }])
    ),
}));
const strikeCountsByUserIds = vi.fn(async (): Promise<Map<number, number>> => new Map());
vi.mock('../moderation-memory.service', () => ({ strikeCountsByUserIds }));

const SUBJECT = 100;
const { getAccountLinks } = await import('../linked-accounts.service');
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

  it.each(['0', '-5', '1.5', 'ten', '1e3', '0x10', '99999999'])(
    'treats %s as not configured',
    (bad) => {
      expect(
        parseLinkConfig({
          LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: bad,
          LINKED_ACCOUNTS_LOGIN_SAMPLE: '50',
          LINKED_ACCOUNTS_BUZZ_LOOKBACK_DAYS: bad,
        })
      ).toEqual({ nearLogin: null, buzz: null });
    }
  );

  it('needs both login settings for the login signal', () => {
    expect(parseLinkConfig({ LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: '60' }).nearLogin).toBeNull();
    expect(
      parseLinkConfig({
        LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: '60',
        LINKED_ACCOUNTS_LOGIN_SAMPLE: '50',
      }).nearLogin
    ).toEqual({ windowSeconds: 60, loginSample: 50 });
  });
});

describe('getAccountLinks', () => {
  it('reports unconfigured signals as off and never queries them', async () => {
    const result = await getAccountLinks(SUBJECT, { nearLogin: null, buzz: null });
    expect(result.status).toEqual({ regIp: 'ok', nearLogin: 'off', buzz: 'off', social: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('merges one account found by two signals into one row, ranked above a single-signal one', async () => {
    ownLogins.mockResolvedValue([{ ip: '1.1.1.1', ts: 5000 }]);
    neighbours.mockResolvedValue([
      { userId: 8, ips: ['1.1.1.1'], addresses: 1, closestSeconds: 10, logins: 1 },
      { userId: 7, ips: ['1.1.1.1'], addresses: 1, closestSeconds: 30, logins: 2 },
    ]);
    counterparties.mockResolvedValue([
      { other: 7, rank: 2, outCount: 3, inCount: 4, outAmount: 30, inAmount: 40 },
    ]);

    const { accounts } = await getAccountLinks(SUBJECT, ON);

    expect(accounts.map((a) => a.userId)).toEqual([7, 8]);
    expect(accounts[0]).toMatchObject({
      status: 'active',
      nearLogin: { closestSeconds: 30, logins: 2 },
      buzz: { rank: 2, inCount: 4, outCount: 3 },
    });
  });

  it('keeps an address that is not a valid IP out of the neighbour query', async () => {
    ownLogins.mockResolvedValue([
      { ip: "1.1.1.1') OR 1=1 --", ts: 1000 },
      { ip: '2.2.2.2', ts: 2000 },
    ]);

    await getAccountLinks(SUBJECT, ON);
    const neighbourSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("'2.2.2.2'"));
    expect(neighbourSql).toBeDefined();
    expect(neighbourSql).not.toContain('OR 1=1');
  });

  it('never matches on the catch-all IPv6 bucket every mapped address falls into', async () => {
    ownLogins.mockResolvedValue([{ ip: '::ffff:7f00:1', ts: 1000 }]);

    const { status } = await getAccountLinks(SUBJECT, ON);
    expect(status.nearLogin).toBe('ok');
    expect(query.mock.calls.some(([sql]) => sql.includes("'::/64'"))).toBe(false);
  });

  it('still returns the other signals when one fails', async () => {
    counterparties.mockRejectedValue(new Error('clickhouse down'));
    getSharedIpRows.mockResolvedValue({
      rows: [{ userId: 5, ip: '3.3.3.3', type: 'Registration', last: '' }],
      truncated: false,
    });

    const result = await getAccountLinks(SUBJECT, ON);
    expect(result.status.buzz).toBe('failed');
    expect(result.accounts.map((a) => a.userId)).toEqual([5]);
  });

  it('keeps the list when strike counts fail, reporting them as unknown rather than zero', async () => {
    strikeCountsByUserIds.mockRejectedValue(new Error('moderator db down'));
    getSharedIpRows.mockResolvedValue({
      rows: [{ userId: 5, ip: '3.3.3.3', type: 'Registration', last: '' }],
      truncated: false,
    });

    const { accounts } = await getAccountLinks(SUBJECT, ON);
    expect(accounts).toMatchObject([{ userId: 5, strikes: null }]);
  });
});
