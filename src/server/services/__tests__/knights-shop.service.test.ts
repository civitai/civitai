import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserService from '~/server/services/user.service';

/**
 * The Knights shop equips and unequips through the main app's own cosmetic service. Only that service and the
 * database are replaced here, so the mapping from its refusals to the endpoint's 409 is tested against the real
 * `CosmeticEquipRefusedError` and TRPC error the service throws.
 */

const user = vi.hoisted(() => ({
  equipCosmetic: vi.fn(),
  unequipCosmeticByType: vi.fn(),
  deleteUserCosmeticCache: vi.fn(),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  ...user,
}));
const stickers = vi.hoisted(() => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...stickers,
}));

const { CosmeticEquipRefusedError } = await import('~/server/services/user.service');
const {
  equipKnightsShopCosmetic,
  KnightsCosmeticRefused,
  refreshKnightsShopCosmetics,
  unequipKnightsShopCosmetic,
} = await import('~/server/services/knights/shop.service');

beforeEach(() => vi.clearAllMocks());

describe('equipKnightsShopCosmetic', () => {
  it('equips from the primary, because Knights equips right after it grants', async () => {
    await equipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 });

    expect(user.equipCosmetic).toHaveBeenCalledTimes(1);
    expect(user.equipCosmetic).toHaveBeenCalledWith({
      userId: 9,
      cosmeticId: 5,
      readOwnershipFromPrimary: true,
    });
  });

  it.each([
    ["You don't have that cosmetic"],
    ['Stickers cannot be equipped'],
    ['Event decorations are placed on content, not equipped'],
  ])('turns the main app refusal "%s" into a final refusal with its message', async (message) => {
    user.equipCosmetic.mockRejectedValue(new CosmeticEquipRefusedError(message));

    const error = await equipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(KnightsCosmeticRefused);
    expect(error.message).toBe(message);
  });

  it('turns a withheld cosmetic (a bad request from the service) into a final refusal', async () => {
    user.equipCosmetic.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'This cosmetic is withheld' })
    );

    await expect(equipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 })).rejects.toBeInstanceOf(
      KnightsCosmeticRefused
    );
  });

  it('rethrows anything else so the caller can retry it', async () => {
    const failure = new Error('connection reset');
    user.equipCosmetic.mockRejectedValue(failure);
    await expect(equipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 })).rejects.toBe(failure);

    const serverError = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });
    user.equipCosmetic.mockRejectedValue(serverError);
    await expect(equipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 })).rejects.toBe(serverError);
  });
});

describe('unequipKnightsShopCosmetic', () => {
  it('looks only at the cosmetic the user is wearing, and clears that type', async () => {
    dbMock.dbWrite.userCosmetic.findFirst.mockResolvedValue({
      cosmetic: { type: 'Badge' },
    } as never);

    await unequipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 });

    expect(dbMock.dbWrite.userCosmetic.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 9, cosmeticId: 5, equippedAt: { not: null } },
      })
    );
    expect(user.unequipCosmeticByType).toHaveBeenCalledWith({ userId: 9, type: 'Badge' });
  });

  it('does nothing when the cosmetic is not worn, so another one of its type stays on', async () => {
    dbMock.dbWrite.userCosmetic.findFirst.mockResolvedValue(null as never);

    await unequipKnightsShopCosmetic({ userId: 9, cosmeticId: 5 });

    expect(user.unequipCosmeticByType).not.toHaveBeenCalled();
  });
});

describe('refreshKnightsShopCosmetics', () => {
  it("refreshes the user's owned-sticker and cosmetic caches", async () => {
    await refreshKnightsShopCosmetics(9);

    expect(stickers.refreshOwnedStickerCache).toHaveBeenCalledWith([9]);
    expect(user.deleteUserCosmeticCache).toHaveBeenCalledWith(9);
  });
});
