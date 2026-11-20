import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/analytics', () => ({ getContentTotals: vi.fn(async () => null) }));
vi.mock('$lib/server/earnings', () => ({ getEarningsSummary: vi.fn(async () => null) }));
vi.mock('$lib/server/models-earnings', () => ({ getModelEarnings: vi.fn(async () => null) }));
vi.mock('$lib/server/cash', () => ({ getCreatorCash: vi.fn(async () => null) }));
vi.mock('$lib/server/banked', () => ({ getBanked: vi.fn(async () => null) }));
vi.mock('$lib/server/storage', () => ({ loadStorageUsage: vi.fn(async () => ({ ready: false })) }));

const { load } = await import('./+page.server');

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

const ROW = {
  id: 'posts.daily',
  area: 'posts',
  label: 'Posts per day',
  limit: 300,
  used: 4,
  remaining: 296,
  windowSeconds: 86400,
  window: 'rolling',
  nextAt: null,
  resetAt: null,
};

const loadDashboard = async () =>
  (await load({
    locals: { user: { id: 7 } },
    cookies: { get: () => undefined },
    request: new Request('https://studio.test/dashboard', {
      headers: { cookie: 'civ-token=abc; cs-buzz-currencies=yellow' },
    }),
  } as unknown as Parameters<typeof load>[0])) as { usageLimits: unknown };

describe('/dashboard usage limits', () => {
  it("reads the creator's limits from the main app with their session cookie", async () => {
    fetchMock.mockResolvedValue(Response.json({ limits: [ROW] }));
    const data = await loadDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/api/v1/me/limits');
    expect((init?.headers as Record<string, string>).cookie).toBe('civ-token=abc');
    // Bounded: an unbounded main-app read would hold the whole dashboard load open.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(data.usageLimits).toEqual([ROW]);
  });

  it('gives null, not a throw, when the read fails or is refused', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await loadDashboard()).usageLimits).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'nope' }, { status: 500 }));
    expect((await loadDashboard()).usageLimits).toBeNull();
  });
});
