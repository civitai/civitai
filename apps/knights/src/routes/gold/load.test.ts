import { beforeEach, describe, expect, it, vi } from 'vitest';

const getGoldBalance = vi.hoisted(() => vi.fn());
const convertGold = vi.hoisted(() => vi.fn());
const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));
vi.mock('$lib/server/conversion/balance', () => ({ getGoldBalance }));
vi.mock('$lib/server/conversion/convert', () => ({ convertGold }));
vi.mock('$lib/server/conversion/runtime', () => ({ getBuzzPort: () => ({}) }));

const { load, actions } = await import('./+page.server');
const locals = { user: { id: 7 } };

beforeEach(() => {
  getGoldBalance.mockReset();
  convertGold.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('gold page', () => {
  it('loads the status and the balance of the signed-in player', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
    getGoldBalance.mockResolvedValue({ convertible: 5000, frozen: 0 });

    expect(await load({ locals } as never)).toEqual({
      status: { rank: 'Knight' },
      balance: { convertible: 5000, frozen: 0 },
    });
    expect(getGoldBalance).toHaveBeenCalledWith({}, 7);
  });

  it('converts for the signed-in player only', async () => {
    convertGold.mockResolvedValue({ status: 'converted', gold: 6000, buzz: 6, transactionId: 't' });

    expect(await actions.convert({ locals } as never)).toMatchObject({ converted: 6 });
    expect(convertGold).toHaveBeenCalledWith({}, {}, expect.objectContaining({ playerId: 7 }));
  });

  it('tells a held player why, with a 409', async () => {
    convertGold.mockResolvedValue({ status: 'refused', reason: 'held' });

    expect(await actions.convert({ locals } as never)).toMatchObject({
      status: 409,
      data: { message: expect.stringContaining('frozen') },
    });
  });

  it('says a conversion Buzz has not confirmed is on its way', async () => {
    convertGold.mockResolvedValue({ status: 'pending', gold: 6000, buzz: 6 });

    expect(await actions.convert({ locals } as never)).toMatchObject({ pending: true });
  });

  it('answers 500 when the conversion throws', async () => {
    convertGold.mockRejectedValue(new Error('db down'));

    expect(await actions.convert({ locals } as never)).toMatchObject({ status: 500 });
  });
});
