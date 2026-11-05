import { TRPCError } from '@trpc/server';
import type { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbWrite } from '~/server/db/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import {
  CosmeticEquipRefusedError,
  deleteUserCosmeticCache,
  equipCosmetic,
  unequipCosmeticByType,
} from '~/server/services/user.service';

export async function refreshKnightsShopCosmetics(userId: number) {
  await refreshOwnedStickerCache([userId]);
  await deleteUserCosmeticCache(userId);
}

export class KnightsCosmeticRefused extends Error {}

/** Equips through the main app's `equipCosmetic`: ownership, event-decoration and withheld-cosmetic rules, caches and the worn-cosmetic queue. */
export async function equipKnightsShopCosmetic({
  userId,
  cosmeticId,
}: {
  userId: number;
  cosmeticId: number;
}) {
  try {
    // Knights equips right after it grants, which the replica may not have seen yet.
    await equipCosmetic({ userId, cosmeticId, readOwnershipFromPrimary: true });
  } catch (error) {
    // Only the service's own refusals are final; a database or network failure stays a 5xx the caller can retry.
    if (error instanceof CosmeticEquipRefusedError) throw new KnightsCosmeticRefused(error.message);
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST') {
      throw new KnightsCosmeticRefused(error.message);
    }
    throw error;
  }
}

/** Takes `cosmeticId` off, only when the user has it equipped; a type has one equipped slot, so this clears that slot. */
export async function unequipKnightsShopCosmetic({
  userId,
  cosmeticId,
}: {
  userId: number;
  cosmeticId: number;
}) {
  const worn = await dbWrite.userCosmetic.findFirst({
    where: { userId, cosmeticId, equippedAt: { not: null } },
    select: { cosmetic: { select: { type: true } } },
  });
  if (!worn) return;
  await unequipCosmeticByType({ userId, type: worn.cosmetic.type as CosmeticType });
}
