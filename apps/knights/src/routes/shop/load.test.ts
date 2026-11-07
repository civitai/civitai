import { beforeEach, describe, expect, it, vi } from 'vitest';

const getGoldBalance = vi.hoisted(() => vi.fn());
const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
const loadShop = vi.hoisted(() => vi.fn());
const recentPurchases = vi.hoisted(() => vi.fn());
const buyItem = vi.hoisted(() => vi.fn());
const rankGate = vi.hoisted(() => ({ value: null as string | null, fail: false }));
vi.mock('$lib/server/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () => {
            if (rankGate.fail) throw new Error('db down');
            return { minRank: rankGate.value };
          },
        }),
      }),
    }),
  },
}));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));
vi.mock('$lib/server/conversion/balance', () => ({ getGoldBalance }));
vi.mock('$lib/server/shop/catalog', () => ({ loadShop }));
vi.mock('$lib/server/shop/inventory', () => ({ recentPurchases }));
vi.mock('$lib/server/shop/purchase', () => ({ buyItem }));
vi.mock('$lib/server/shop/main-app', () => ({ getMainAppPort: () => ({ main: true }) }));
const buzzConfigured = vi.hoisted(() => vi.fn());
const conversionEnabled = vi.hoisted(() => vi.fn());
const shopEnabled = vi.hoisted(() => vi.fn());
const logToAxiom = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/conversion/runtime', () => ({
  getBuzzPort: () => ({ buzz: true }),
  buzzConfigured,
  conversionEnabled,
  shopEnabled,
}));

const { load, actions } = await import('./+page.server');
const locals = { user: { id: 7 } };

const post = (fields: Record<string, string>) =>
  actions.buy({
    locals,
    request: new Request('http://knights.test/shop?/buy', {
      method: 'POST',
      body: new URLSearchParams(fields),
    }),
  } as never);
const FIELDS = { itemId: '41', price: '400', requestKey: 'request-0001' };

beforeEach(() => {
  getGoldBalance.mockReset();
  getPlayerStatusOrNew.mockReset();
  loadShop.mockReset();
  recentPurchases.mockReset();
  recentPurchases.mockResolvedValue([]);
  buyItem.mockReset();
  rankGate.value = null;
  rankGate.fail = false;
  buzzConfigured.mockReset();
  buzzConfigured.mockReturnValue(true);
  conversionEnabled.mockReset();
  conversionEnabled.mockReturnValue(true);
  shopEnabled.mockReset();
  shopEnabled.mockReturnValue(true);
  logToAxiom.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('shop page load', () => {
  it("loads the signed-in player's balance and today's shop for their rank", async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
    getGoldBalance.mockResolvedValue({ convertible: 5000 });
    loadShop.mockResolvedValue({ day: '2026-12-20', cards: [] });

    const data = await load({ locals } as never);

    expect(data).toMatchObject({
      balance: { convertible: 5000 },
      shopOpen: true,
      shop: { day: '2026-12-20' },
    });
    expect(loadShop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ playerId: 7, rank: 'Knight', buzzPacksOpen: true })
    );
    expect(getGoldBalance).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('lists Buzz packs as closed while the Buzz switch is on, and still shows the shop', async () => {
    conversionEnabled.mockReturnValue(false);
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
    getGoldBalance.mockResolvedValue({});
    loadShop.mockResolvedValue({ cards: [] });

    expect(await load({ locals } as never)).toMatchObject({ shopOpen: true });
    expect(loadShop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buzzPacksOpen: false })
    );
  });

  it('serves no stock while the shop is switched off', async () => {
    shopEnabled.mockReturnValue(false);
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
    getGoldBalance.mockResolvedValue({});

    expect(await load({ locals } as never)).toMatchObject({
      shopOpen: false,
      shop: null,
      recent: [],
    });
    expect(loadShop).not.toHaveBeenCalled();
  });

  it('serialises recent purchases', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
    getGoldBalance.mockResolvedValue({});
    loadShop.mockResolvedValue({ cards: [] });
    const at = new Date('2026-12-20T10:00:00Z');
    recentPurchases.mockResolvedValue([
      { id: 1, gold: 400, status: 'granted', name: 'Seal', kind: 'cosmetic', createdAt: at },
    ]);

    const { recent } = (await load({ locals } as never)) as { recent: unknown[] };

    expect(recent).toEqual([
      { id: 1, gold: 400, status: 'granted', name: 'Seal', kind: 'cosmetic', at: at.toISOString() },
    ]);
  });
});

describe('buying', () => {
  it('buys for the signed-in player only, with the price and key the form carried', async () => {
    buyItem.mockResolvedValue({ status: 'granted', kind: 'cosmetic', gold: 400, purchaseId: 1 });

    expect(await post(FIELDS)).toMatchObject({
      ok: true,
      pending: false,
      itemId: 41,
      gold: 400,
    });
    expect(buyItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buzzPacksOpen: true }),
      expect.objectContaining({
        playerId: 7,
        itemId: 41,
        price: 400,
        requestKey: 'request-0001',
      })
    );
  });

  it('refuses before touching anything while the shop is switched off', async () => {
    shopEnabled.mockReturnValue(false);

    expect(await post(FIELDS)).toMatchObject({ status: 403 });
    expect(buyItem).not.toHaveBeenCalled();
  });

  it('answers 400 for a form with no item or a price that is not a number', async () => {
    for (const itemId of ['', 'badge-seal', '0', '-3', '4.5', '41abc'])
      expect(await post({ ...FIELDS, itemId })).toMatchObject({ status: 400 });
    expect(await post({ ...FIELDS, price: 'free' })).toMatchObject({ status: 400 });
    expect(buyItem).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'abc'],
    ['of the wrong shape', 'request key with spaces!'],
  ])('answers 400, without buying, for a request key that is %s', async (_, requestKey) => {
    const { requestKey: _dropped, ...rest } = FIELDS;

    expect(await post(requestKey === undefined ? rest : { ...rest, requestKey })).toMatchObject({
      status: 400,
      data: { reason: 'bad-key' },
    });
    expect(buyItem).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '12.5'],
  ])('answers 400, without buying, for a price that is %s', async (_, price) => {
    const { price: _dropped, ...rest } = FIELDS;

    expect(await post(price === undefined ? rest : { ...rest, price })).toMatchObject({
      status: 400,
    });
    expect(buyItem).not.toHaveBeenCalled();
  });

  it('keeps Buzz packs closed, without asking Buzz, when it is not configured, and says so once', async () => {
    buzzConfigured.mockReturnValue(false);
    buyItem.mockResolvedValue({ status: 'refused', reason: 'closed' });

    vi.resetModules();
    const fresh = await import('./+page.server');
    const again = () =>
      fresh.actions.buy({
        locals,
        request: new Request('http://knights.test/shop?/buy', {
          method: 'POST',
          body: new URLSearchParams(FIELDS),
        }),
      } as never);

    expect(await again()).toMatchObject({ status: 403, data: { reason: 'closed' } });
    await again();
    expect(buyItem.mock.calls[0][1]).toMatchObject({ buzzPacksOpen: false });
    expect(buyItem).toHaveBeenCalledTimes(2);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('says how short the gold is', async () => {
    buyItem.mockResolvedValue({ status: 'refused', reason: 'insufficient', shortfall: 1200 });

    expect(await post(FIELDS)).toMatchObject({
      status: 409,
      data: { message: '1,200 gold short.', shortfall: 1200, reason: 'insufficient' },
    });
  });

  it('tells a held player their gold is kept, with a 403', async () => {
    buyItem.mockResolvedValue({ status: 'refused', reason: 'held' });

    expect(await post(FIELDS)).toMatchObject({
      status: 403,
      data: { message: expect.stringContaining('kept, not lost') },
    });
  });

  it('names the rank that opens a gated item', async () => {
    rankGate.value = 'Paladin';
    buyItem.mockResolvedValue({ status: 'refused', reason: 'rank' });

    expect(await post(FIELDS)).toMatchObject({
      status: 403,
      data: { message: 'This unlocks at Paladin.' },
    });
  });

  it('says a purchase the other side has not confirmed is reserved, and not charged twice', async () => {
    buyItem.mockResolvedValue({
      status: 'pending',
      kind: 'membership',
      gold: 12000,
      purchaseId: 3,
    });

    expect(await post(FIELDS)).toMatchObject({
      ok: true,
      pending: true,
    });
  });

  it('says a refused delivery leaves the gold untouched, or forfeited by a reset', async () => {
    buyItem.mockResolvedValueOnce({ status: 'failed', purchaseId: 1, forfeited: false });
    buyItem.mockResolvedValueOnce({ status: 'failed', purchaseId: 1, forfeited: true });

    expect(await post(FIELDS)).toMatchObject({
      status: 502,
      data: { message: expect.stringContaining('untouched') },
    });
    expect(await post(FIELDS)).toMatchObject({
      status: 502,
      data: { message: expect.stringContaining('forfeited') },
    });
  });

  it('answers with the structured failure, carrying the item, when the rank lookup fails', async () => {
    buyItem.mockResolvedValue({ status: 'refused', reason: 'rank' });
    rankGate.fail = true;

    expect(await post(FIELDS)).toMatchObject({
      status: 500,
      data: { itemId: 41, message: expect.any(String) },
    });
  });

  it('answers 500 when the purchase throws', async () => {
    buyItem.mockRejectedValue(new Error('db down'));

    expect(await post(FIELDS)).toMatchObject({ status: 500 });
  });
});
