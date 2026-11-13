import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The user report queue's shared-IP list. Its own endpoint so the Reports grant opens the linked
 * accounts and nothing else User Lookup's signals carry — and the addresses only to a caller who could
 * read them in User Lookup anyway.
 */

const getSharedIpAccounts = vi.fn(async () => ({
  accounts: [
    {
      userId: 2,
      username: 'b',
      bannedAt: null,
      muted: false,
      strikes: 0,
      ip: '1.2.3.4',
      type: 'register',
      last: '',
    },
  ],
  truncated: false,
}));
vi.mock('$lib/server/user-signals.service', () => ({
  getSharedIpAccounts,
  softly: (_label: string, run: () => Promise<unknown>) => run(),
}));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));
const requireUserIdParam = vi.fn((_locals: unknown, params: { userId: string }, _paths: string[]) =>
  Number(params.userId)
);
vi.mock('$lib/server/api-guard', () => ({ requireUserIdParam }));

const { GET } = await import('../+server');
const call = async () =>
  (await GET({ params: { userId: '5' }, locals: { user: { id: 1 } } } as never)).json();

beforeEach(() => vi.clearAllMocks());

describe('/api/shared-ip-accounts', () => {
  it('is open to User Lookup and the user report queue', async () => {
    await call();
    expect(requireUserIdParam).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      '/retool/user-lookup',
      '/reports/user',
    ]);
  });

  it('returns the addresses to a User Lookup holder', async () => {
    const body = await call();
    expect(body.accounts[0].ip).toBe('1.2.3.4');
  });

  it('hides the addresses from a caller who reached it through the report queue', async () => {
    canAccess.mockImplementation((_user, path) => path !== '/retool/user-lookup');
    const body = await call();
    expect(body.accounts[0]).toMatchObject({ userId: 2, ip: null });
    canAccess.mockImplementation(() => true);
  });
});
