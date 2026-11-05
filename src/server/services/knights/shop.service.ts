import type { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbWrite } from '~/server/db/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import {
  deleteUserCosmeticCache,
  equipCosmetic,
  unequipCosmeticByType,
} from '~/server/services/user.service';

/** The Knights gold shop inserts `UserCosmetic` rows itself; this is the cache bust the main app's own grants do. */
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
    await equipCosmetic({ userId, cosmeticId });
  } catch (error) {
    throw new KnightsCosmeticRefused((error as Error).message);
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
