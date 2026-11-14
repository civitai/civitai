import { beforeEach, describe, expect, it, vi } from 'vitest';

const shopEnabled = vi.hoisted(() => vi.fn());
const listInventory = vi.hoisted(() => vi.fn());
const mainApp = vi.hoisted(() => ({ equipCosmetic: vi.fn(), unequipCosmetic: vi.fn() }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/conversion/balance', () => ({ getGoldBalance: vi.fn() }));
vi.mock('$lib/server/conversion/runtime', () => ({ shopEnabled }));
vi.mock('$lib/server/shop/inventory', () => ({ listInventory, membershipOf: vi.fn() }));
vi.mock('$lib/server/shop/main-app', async (original) => ({
  ...(await original<typeof import('$lib/server/shop/main-app')>()),
  getMainAppPort: () => mainApp,
}));

const { actions } = await import('./+page.server');
const { MainAppRejectedError } = await import('$lib/server/shop/main-app');
const locals = { user: { id: 7 } };

const post = (action: 'equip' | 'unequip', fields: Record<string, string>) =>
  actions[action]({
    locals,
    request: new Request(`http://knights.test/shop/inventory?/${action}`, {
      method: 'POST',
      body: new URLSearchParams(fields),
    }),
  } as never);

beforeEach(() => {
  shopEnabled.mockReset();
  shopEnabled.mockReturnValue(true);
  listInventory.mockReset();
  listInventory.mockResolvedValue([{ cosmeticId: 5 }]);
  mainApp.equipCosmetic.mockReset();
  mainApp.equipCosmetic.mockResolvedValue(undefined);
  mainApp.unequipCosmetic.mockReset();
  mainApp.unequipCosmetic.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each([
  ['equip', 'equipCosmetic'],
  ['unequip', 'unequipCosmetic'],
] as const)('%s', (action, method) => {
  it('is refused with a 403 while the shop is closed', async () => {
    shopEnabled.mockReturnValue(false);

    expect(await post(action, { cosmeticId: '5' })).toMatchObject({ status: 403 });
    expect(mainApp[method]).not.toHaveBeenCalled();
  });

  it.each(['', 'abc', '0', '-3', '1.5'])(
    'answers 400 for a cosmeticId of %j',
    async (cosmeticId) => {
      expect(await post(action, { cosmeticId })).toMatchObject({ status: 400 });
      expect(mainApp[method]).not.toHaveBeenCalled();
    }
  );

  it('answers 404 for a cosmetic the inventory does not list', async () => {
    expect(await post(action, { cosmeticId: '6' })).toMatchObject({ status: 404 });
    expect(mainApp[method]).not.toHaveBeenCalled();
  });

  it("answers 409 with the main app's wording when it refuses", async () => {
    mainApp[method].mockRejectedValue(new MainAppRejectedError(409, 'locked', 'Locked for now.'));

    expect(await post(action, { cosmeticId: '5' })).toMatchObject({
      status: 409,
      data: { message: 'Locked for now.', cosmeticId: 5 },
    });
  });

  it('answers 502 and logs its own name when the main app does not answer', async () => {
    mainApp[method].mockRejectedValue(new Error('timeout'));

    expect(await post(action, { cosmeticId: '5' })).toMatchObject({
      status: 502,
      data: { cosmeticId: 5 },
    });
    expect(console.error).toHaveBeenCalledWith(`knights: ${action} failed`, expect.anything());
  });

  it('calls the main app for the signed-in player and says it worked', async () => {
    expect(await post(action, { cosmeticId: '5' })).toEqual({ ok: true, cosmeticId: 5 });
    expect(mainApp[method]).toHaveBeenCalledWith(7, 5);
  });
});

describe('the wording when the main app gives no reason', () => {
  it.each([
    ['equip', 'equipCosmetic', 'Civitai would not equip that.'],
    ['unequip', 'unequipCosmetic', 'Civitai would not unequip that.'],
  ] as const)('says %s for itself', async (action, method, message) => {
    mainApp[method].mockRejectedValue(new MainAppRejectedError(409, 'locked'));

    expect(await post(action, { cosmeticId: '5' })).toMatchObject({ data: { message } });
  });
});
