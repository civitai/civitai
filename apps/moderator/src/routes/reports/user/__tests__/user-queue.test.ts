import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What this route decides that the queue services do not: which account opens, what a `?report=`
 * link — the `/reports/[slug]` contract this route took over for users — asks of the queue, and that
 * the queue (the layout) reads nothing that changes when the moderator moves between accounts or tabs.
 */

const getReports = vi.fn();
const getReportedAccountDetails = vi.fn(async (id: number) => ({ id }));
const getSuspectImages = vi.fn(async () => null);

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/access', () => ({ canAccess: vi.fn(() => true) }));
vi.mock('$lib/server/report-actions', () => ({ reportModerationActions: () => ({}) }));
vi.mock('$lib/server/account-actions', () => ({ accountEnforcementActions: {} }));
vi.mock('$lib/server/user-actions.service', () => ({ getTimedMute: vi.fn(async () => null) }));
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  getReportStatusCounts: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/users.service', () => ({
  MAX_INT4: 2_147_483_647,
  usersByIds: vi.fn(async () => new Map()),
}));
vi.mock('$lib/server/report-triage.service', () => ({ getSuspectImages }));
vi.mock('$lib/server/account-history', () => ({ loadAccountHistory: vi.fn() }));
vi.mock('$lib/server/user-lookup.service', () => ({ getReportedAccountDetails }));
vi.mock('$lib/server/reported-account.service', () => ({ getReportedAccountModels: vi.fn() }));

const { load: layoutLoad } = await import('../+layout.server');
const { load: indexLoad } = await import('../+page.server');
const { load: accountLoad } = await import('../[userId]/[[tab=suspectTab]]/+page.server');
const { load: retoolRedirect } = await import('../../../retool/user-reports/+page.server');

const page = (items: { id: number; entityId: number | null }[]) => ({
  items,
  totalItems: items.length,
  page: 1,
  limit: 50,
});
const locals = { user: { id: 1, username: 'mod' }, grants: {} };
const url = (path: string) => new URL(`https://mod.example${path}`);

type Layout = { singleReport: number | null; hidingAutomated: boolean; queue: unknown[] };
type Account = { account: { suspectId: number; tab: string } | null };

const runLayout = (query: string) =>
  layoutLoad({ url: url(`/reports/user${query}`), locals } as never) as Promise<Layout>;
const runIndex = async (query: string) => {
  const parent = await runLayout(query);
  return indexLoad({
    url: url(`/reports/user${query}`),
    locals,
    parent: async () => parent,
  } as never) as Promise<Account>;
};
const runAccount = (params: { userId: string; tab?: string }, query = '') =>
  accountLoad({
    url: url(`/reports/user/${params.userId}${query}`),
    params,
    locals,
  } as never) as Promise<Account>;

beforeEach(() => {
  vi.clearAllMocks();
  getReports.mockResolvedValue(page([]));
});

describe('which account opens', () => {
  it('the bare queue: its first reported account, on details', async () => {
    getReports.mockResolvedValue(
      page([
        { id: 10, entityId: null },
        { id: 11, entityId: 77 },
      ])
    );
    const data = await runIndex('?status=Pending');
    expect(data.account).toMatchObject({ suspectId: 77, tab: 'details' });
    expect(getReportedAccountDetails).toHaveBeenCalledWith(77);
  });

  it('the bare queue, empty: none', async () => {
    const data = await runIndex('?status=Pending');
    expect(data.account).toBeNull();
    expect(getReportedAccountDetails).not.toHaveBeenCalled();
  });

  it('the path names one, and its tab', async () => {
    const data = await runAccount({ userId: '5', tab: 'images' });
    expect(data.account).toMatchObject({ suspectId: 5, tab: 'images' });
    expect(getSuspectImages).toHaveBeenCalledWith(5, expect.anything(), { page: 1 });
  });

  it('a path that is not a user id is a 404', async () => {
    await expect(runAccount({ userId: 'abc' })).rejects.toMatchObject({ status: 404 });
  });

  // Every open report on the account, by the account — not the ones on the current page of the
  // queue, where a second report could sit a page away and go unruled.
  it("loads the account's own open reports", async () => {
    await runAccount({ userId: '5' });
    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reportedUser',
        entityId: 5,
        statuses: ['Pending', 'Processing'],
      })
    );
  });
});

describe('the queue layout', () => {
  // SvelteKit reruns a load whose tracked URL reads changed. `get`/`getAll`/`has` are tracked per key;
  // iterating the query string, or reading the path, makes the queue rerun on every tab click.
  it('reads only its own params, never the whole query or the path', async () => {
    const real = url('/reports/user/5/images?status=Pending&imgPage=3&tos=1');
    const touched: string[] = [];
    const searchParams = new Proxy(real.searchParams, {
      get(target, key) {
        if (key === 'get' || key === 'getAll' || key === 'has')
          return (k: string) => {
            touched.push(k);
            return (target[key] as (k: string) => unknown).call(target, k);
          };
        throw new Error(`searchParams.${String(key)} reads the whole query string`);
      },
    });
    const tracked = new Proxy(real, {
      get(target, key) {
        if (key === 'searchParams') return searchParams;
        throw new Error(`url.${String(key)} is tracked as a whole`);
      },
    });

    await layoutLoad({ url: tracked, locals } as never);
    expect(touched).not.toContain('imgPage');
    expect(touched).not.toContain('tos');
    expect(touched).not.toContain('tab');
    expect(touched).not.toContain('user');
  });
});

describe('?report=', () => {
  it('asks for that one report with every filter off, and opens its account', async () => {
    getReports.mockResolvedValue(page([{ id: 42, entityId: 9 }]));
    const data = await runIndex('?report=42&status=Pending&reportedBy=someone');

    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 42,
        statuses: 'all',
        reasons: 'all',
        reportedBy: undefined,
        page: 1,
      })
    );
    expect(data.account?.suspectId).toBe(9);
    expect((await runLayout('?report=42')).singleReport).toBe(42);
  });
});

describe('reasons, read as the model queue reads them', () => {
  const asked = () => getReports.mock.calls[0][0].reasons;

  it('absent: every reason but Automated, and the page says it is hiding them', async () => {
    const data = await runLayout('?status=Pending');
    expect(asked()).not.toContain('Automated');
    expect(asked().length).toBeGreaterThan(0);
    expect(data.hidingAutomated).toBe(true);
  });

  it('present but empty: every reason, Automated included', async () => {
    await runLayout('?status=Pending&reason=');
    expect(asked()).toBe('all');
  });

  it('named: those reasons only', async () => {
    await runLayout('?status=Pending&reason=Spam');
    expect(asked()).toEqual(['Spam']);
  });
});

describe('the retool redirect', () => {
  const target = async (query: string) => {
    try {
      await retoolRedirect({ url: url(`/retool/user-reports${query}`) } as never);
    } catch (e) {
      return (e as { location: string }).location;
    }
    throw new Error('did not redirect');
  };

  it('moves ?user= and ?tab= into the path and keeps the rest', async () => {
    expect(await target('?user=5&tab=images&page=2&tos=1')).toBe(
      '/reports/user/5/images?page=2&tos=1'
    );
  });

  it('drops a tab the route does not have rather than 404ing on it', async () => {
    expect(await target('?user=5&tab=history')).toBe('/reports/user/5');
  });

  it('with no account, to the bare queue', async () => {
    expect(await target('?status=Pending')).toBe('/reports/user?status=Pending');
  });
});
