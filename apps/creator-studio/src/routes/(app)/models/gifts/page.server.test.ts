import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callMainApp, flag, loadUsageLimits } = vi.hoisted(() => ({
  callMainApp: vi.fn(),
  flag: { on: true },
  loadUsageLimits: vi.fn(),
}));
vi.mock('$lib/server/main-app', () => ({ callMainApp }));
vi.mock('$lib/server/usage-limits', () => ({ loadUsageLimits, USAGE_LIMITS_URL: 'u' }));
vi.mock('$lib/server/main-app-flags', () => ({ darkFlagEnabled: vi.fn(async () => flag.on) }));
vi.mock('$lib/server/session-cookies', () => ({ sessionCookies: () => 'cookie' }));

const { actions, load } = await import('./+page.server');

const user = { id: 7 };
const jar = new Map<string, string>();
const cookies = {
  get: (k: string) => jar.get(k),
  set: (k: string, v: string) => void jar.set(k, v),
  delete: (k: string) => void jar.delete(k),
};
const loadAt = (url: string) =>
  load({
    locals: { user },
    request: new Request(url),
    url: new URL(url),
    cookies,
  } as unknown as Parameters<typeof load>[0]);

function revoke(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return actions.revoke({
    locals: { user },
    request: new Request('https://studio.test/models/gifts?/revoke', { method: 'POST', body }),
    cookies,
  } as unknown as Parameters<typeof actions.revoke>[0]);
}

beforeEach(() => {
  jar.clear();
  flag.on = true;
  callMainApp.mockReset();
  callMainApp.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null, revoked: 1 } });
  loadUsageLimits.mockReset();
  loadUsageLimits.mockResolvedValue(null);
});

const row = (id: string, used: number) => ({
  id,
  area: id.split('.')[0],
  label: id,
  limit: 15,
  used,
  remaining: 15 - used,
  windowSeconds: null,
  window: 'utc-month',
  nextAt: null,
  resetAt: '2026-12-01T00:00:00.000Z',
});

describe('/models/gifts', () => {
  it('is not found while the gift-links flag is off, for the page and for revoke', async () => {
    flag.on = false;
    await expect(loadAt('https://studio.test/models/gifts')).rejects.toMatchObject({ status: 404 });
    await expect(revoke({ versionId: '5', id: '9' })).rejects.toMatchObject({ status: 404 });
    expect(callMainApp).not.toHaveBeenCalled();
  });

  it("streams the creator's gifts.monthly row, and lists links without waiting for it", async () => {
    loadUsageLimits.mockResolvedValueOnce([row('posts.daily', 9), row('gifts.monthly', 4)]);
    const data = (await loadAt('https://studio.test/models/gifts')) as {
      giftLimit: Promise<unknown>;
    };
    expect(await data.giftLimit).toMatchObject({ id: 'gifts.monthly', used: 4, limit: 15 });
    expect(loadUsageLimits).toHaveBeenCalledWith('cookie');

    // A limits read that never answers must not hold the list.
    loadUsageLimits.mockReturnValueOnce(new Promise(() => {}));
    callMainApp.mockResolvedValueOnce({ ok: true, data: { items: [{ id: 1 }], nextCursor: null } });
    expect(await loadAt('https://studio.test/models/gifts')).toMatchObject({
      page: { items: [{ id: 1 }] },
    });

    loadUsageLimits.mockResolvedValueOnce(null);
    const failed = (await loadAt('https://studio.test/models/gifts')) as {
      giftLimit: Promise<unknown>;
    };
    expect(await failed.giftLimit).toBeNull();
  });

  it('asks the main app for the page the cursor names', async () => {
    await loadAt('https://studio.test/models/gifts?cursor=a%2Bb');
    expect(callMainApp).toHaveBeenCalledWith('/api/v1/model-versions/gifts?cursor=a%2Bb', 'cookie');
  });

  it('reads the primary once, on the load right after a revoke', async () => {
    await loadAt('https://studio.test/models/gifts');
    await revoke({ versionId: '5', id: '9' });
    await loadAt('https://studio.test/models/gifts');
    await loadAt('https://studio.test/models/gifts');
    expect(callMainApp.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/model-versions/gifts',
      '/api/v1/model-versions/5/gifts/9',
      '/api/v1/model-versions/gifts?fresh=1',
      '/api/v1/model-versions/gifts',
    ]);
  });

  it("revokes a link or a batch on the row's own version", async () => {
    await revoke({ versionId: '5', id: '9' });
    await revoke({ versionId: '6', batchId: '00000000-0000-4000-8000-000000000001' });
    expect(callMainApp.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['/api/v1/model-versions/5/gifts/9', { method: 'DELETE' }],
      [
        '/api/v1/model-versions/6/gifts/batch/00000000-0000-4000-8000-000000000001',
        { method: 'DELETE' },
      ],
    ]);
  });

  it("shows the main app's refusal, and sends nothing for a malformed row", async () => {
    callMainApp.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'You do not own this model version.',
    });
    expect(await revoke({ versionId: '5', id: '9' })).toMatchObject({
      status: 403,
      data: { error: 'You do not own this model version.' },
    });
    callMainApp.mockClear();
    expect(await revoke({ versionId: '../../x', id: '9' })).toMatchObject({ status: 400 });
    expect(callMainApp).not.toHaveBeenCalled();
  });
});
