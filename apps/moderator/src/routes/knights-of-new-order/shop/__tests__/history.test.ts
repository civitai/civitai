import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ listShopChanges: vi.fn() }));
const access = vi.hoisted(() => ({ requireAccess: vi.fn() }));

vi.mock('$lib/server/knights/shop-catalog.service', () => svc);
vi.mock('$lib/server/access', () => access);

import { GET } from '../history/+server';

const call = (search: string) =>
  GET({
    url: new URL(`http://localhost/knights-of-new-order/shop/history?${search}`),
    locals: { user: { id: 77 } },
  } as never);

describe('shop item history endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listShopChanges.mockResolvedValue({ changes: [], nextBefore: null });
  });

  it('checks the moderator grant before reading anything', async () => {
    access.requireAccess.mockImplementationOnce(() => {
      throw new Error('forbidden');
    });
    await expect(call('item=4')).rejects.toThrow('forbidden');
    expect(svc.listShopChanges).not.toHaveBeenCalled();
  });

  it('refuses a request without a usable item id', async () => {
    for (const search of ['', 'item=abc', 'item=-1', 'item=1e3']) {
      expect((await call(search)).status).toBe(400);
    }
    expect(svc.listShopChanges).not.toHaveBeenCalled();
  });

  it("returns one item's changes and passes the paging cursor through", async () => {
    svc.listShopChanges.mockResolvedValueOnce({ changes: [{ id: 9 }], nextBefore: 9 });
    const response = await call('item=4&before=20');
    expect(await response.json()).toEqual({ changes: [{ id: 9 }], nextBefore: 9 });
    expect(svc.listShopChanges).toHaveBeenCalledWith({ itemId: 4, before: 20 });
  });
});
