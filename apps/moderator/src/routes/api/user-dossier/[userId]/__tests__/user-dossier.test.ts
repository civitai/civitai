import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dossier panel's endpoint is open to the user report queue, which is granted more widely than
 * User Lookup and `/abuse`. It must not hand that wider audience the addresses or the detector findings.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('$lib/server/dossier.service', () => ({
  getDossier: vi.fn(async () => ({
    userId: 5,
    abuse: { count: 1, truncated: false, latest: [] },
    linked: {
      days: 180,
      totals: { login: 1, reaction: 0 },
      matched: 1,
      truncated: false,
      addresses: [{ cluster: '1.2.3.4', source: 'login', accounts: 2 }],
      accounts: [
        {
          userId: 7,
          username: 'a',
          status: 'active',
          muted: false,
          strikes: 0,
          login: ['1.2.3.4'],
          reaction: [],
          narrowest: 2,
          last: '',
        },
      ],
    },
  })),
}));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({
  canAccess,
  canSeeAddresses: (locals: { user: unknown }) => canAccess(locals.user, '/retool/user-lookup'),
}));
const requireUserIdParam = vi.fn((_l: unknown, params: { userId: string }, _p: string[]) =>
  Number(params.userId)
);
vi.mock('$lib/server/api-guard', () => ({ requireUserIdParam }));

const { GET } = await import('../+server');
const call = async () =>
  (await GET({ params: { userId: '5' }, locals: { user: { id: 1 } } } as never)).json();

beforeEach(() => canAccess.mockImplementation(() => true));

describe('/api/user-dossier', () => {
  it('is open to User Lookup and the user report queue', async () => {
    await call();
    expect(requireUserIdParam).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      '/retool/user-lookup',
      '/reports/user',
    ]);
  });

  it('serves addresses and findings to a holder of both pages', async () => {
    const body = await call();
    expect(JSON.stringify(body)).toContain('1.2.3.4');
    expect(body.abuse).toMatchObject({ count: 1 });
  });

  it('withholds the addresses and the findings from a reports-only moderator', async () => {
    canAccess.mockImplementation((_u, path) => path === '/reports/user');
    const body = await call();
    expect(JSON.stringify(body)).not.toContain('1.2.3.4');
    expect(body.linked.accounts[0].login).toEqual(['address 1']);
    expect(body.abuse).toBeNull();
  });
});
