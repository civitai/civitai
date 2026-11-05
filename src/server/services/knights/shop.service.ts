import { TRPCError } from '@trpc/server';
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

const EQUIP_REFUSALS = [
  "You don't have that cosmetic",
  'Stickers cannot be equipped',
  'Event decorations are placed',
];

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
    // Only the service's own refusals are final; a database or network failure stays a 5xx the caller can retry.
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST') {
      throw new KnightsCosmeticRefused(error.message);
    }
    if (error instanceof Error && EQUIP_REFUSALS.some((text) => error.message.startsWith(text))) {
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
