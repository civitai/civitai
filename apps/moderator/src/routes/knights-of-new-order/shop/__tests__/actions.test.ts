import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  createShopItem: vi.fn(),
  listShopChanges: vi.fn(),
  listShopItems: vi.fn(),
  setShopItemActive: vi.fn(),
  stockView: vi.fn(),
  updateShopItem: vi.fn(),
}));

vi.mock('$lib/server/knights/shop-catalog.service', () => svc);
vi.mock('$lib/server/access', () => ({ requireAccess: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions, load } from '../+page.server';

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 77 } },
    url: new URL('http://localhost/knights-of-new-order/shop'),
  } as never;
};

describe('Knights shop catalog actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a membership the shop would never sell, without writing', async () => {
    const result = await actions.add(
      formEvent({
        kind: 'membership',
        tier: 'gold',
        days: '30',
        name: 'Gold quarter',
        price: '900',
        sortOrder: '0',
      })
    );
    expect(result).toMatchObject({ status: 400 });
    expect(svc.createShopItem).not.toHaveBeenCalled();
  });

  it('shows a refusal from the service as a conflict', async () => {
    svc.setShopItemActive.mockResolvedValueOnce({ ok: false, error: 'gone' });
    expect(await actions.retire(formEvent({ id: '12' }))).toMatchObject({
      status: 409,
      data: { error: 'gone' },
    });
  });

  it('fails the action, not the page, when a write throws', async () => {
    svc.updateShopItem.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await actions.save(formEvent({ id: '12', name: 'x', price: '5', sortOrder: '0' }))
    ).toMatchObject({ status: 500 });
  });
});

describe('Knights shop catalog load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listShopItems.mockResolvedValue([]);
    svc.stockView.mockReturnValue({ day: '', stock: [], excluded: [] });
  });

  const run = (search: string) =>
    load({
      url: new URL(`http://localhost/knights-of-new-order/shop?${search}`),
      locals: { user: { id: 77 } },
    } as never) as Promise<{ day: string; today: string }>;

  it('previews the current catalog for a past or impossible day instead of drawing that day', async () => {
    for (const day of ['2020-01-01', '2026-02-31', 'soon']) {
      const data = await run(`tab=preview&day=${day}`);
      expect(data.day).toBe(data.today);
      expect(svc.stockView).toHaveBeenLastCalledWith([], data.today);
    }
  });

  it('keeps a future day', async () => {
    expect((await run('tab=preview&day=2999-01-01')).day).toBe('2999-01-01');
  });
});
