import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Yellow figure on the user-lookup panel. The buzz API's untyped `/account/{id}` sums Yellow and
 * Blue (verified against prod, user 5: 467,019 + 95,030 = 562,049), so reading it as "Yellow"
 * overstates the number a moderator makes refund and withdrawal calls from. These pin that the yellow
 * row comes from an explicitly typed read, and that a broken colour call cannot take it down with it.
 */

const { getAccount, getUserBuzzByAccountType } = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getUserBuzzByAccountType: vi.fn(),
}));

vi.mock('../buzz', () => ({ getBuzz: () => ({ getAccount, getUserBuzzByAccountType }) }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => ({}) }));
vi.mock('../notifications', () => ({ getNotifications: () => ({}) }));
vi.mock('../users.service', () => ({ usersByIds: async () => new Map() }));

const { getBuzzBalance } = await import('../user-account.service');

const account = (balance: number, lifetimeBalance: number) => ({ id: 5, balance, lifetimeBalance });

beforeEach(() => {
  getAccount.mockReset();
  getUserBuzzByAccountType.mockReset();
  getUserBuzzByAccountType.mockImplementation(async (_id: number, type: string) =>
    type === 'yellow' ? account(467_019, 1_527_146) : account(95_030, 131_811)
  );
});

describe('getBuzzBalance', () => {
  it('reports the yellow account alone, not the yellow+blue sum', async () => {
    const buzz = await getBuzzBalance(5);

    expect(buzz?.balance).toBe(467_019);
    expect(buzz?.lifetimeBalance).toBe(1_527_146);
    expect(getUserBuzzByAccountType).toHaveBeenCalledWith(5, 'yellow');
    // The untyped read is the summed one — using it at all is the bug.
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('keeps the yellow balance when the colour reads fail', async () => {
    getUserBuzzByAccountType.mockImplementation(async (_id: number, type: string) => {
      if (type === 'yellow') return account(467_019, 1_527_146);
      throw new Error('buzz colour read failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const buzz = await getBuzzBalance(5);

    expect(buzz?.balance).toBe(467_019);
    expect(buzz?.blue).toBeNull();
    expect(buzz?.green).toBeNull();
  });

  it('returns null when the yellow read fails', async () => {
    getUserBuzzByAccountType.mockRejectedValue(new Error('buzz down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await getBuzzBalance(5)).toBeNull();
  });
});
