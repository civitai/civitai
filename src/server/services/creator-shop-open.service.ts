import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { CREATOR_SHOP_MIN_CREATOR_SCORE } from '~/shared/constants/cosmetic-shop.constants';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';

/** A listing of their own (any status) or another creator's item they resell. */
async function hasCreatorShop(userId: number) {
  const [own, resold] = await Promise.all([
    dbRead.cosmeticShopItem.findFirst({ where: { addedById: userId }, select: { id: true } }),
    dbRead.userCosmeticShopItemResale.findFirst({
      where: { userId },
      select: { shopItemId: true },
    }),
  ]);
  return !!own || !!resold;
}

/**
 * Putting anything in a shop needs the Blaze Creator Score, except for a user who already has a shop:
 * those owners keep it whatever their score.
 */
export async function assertCanOpenCreatorShop(userId: number) {
  const user = await dbRead.user.findUnique({ where: { id: userId }, select: { meta: true } });
  if (creatorScoreFromMeta(user?.meta) >= CREATOR_SHOP_MIN_CREATOR_SCORE) return;
  if (await hasCreatorShop(userId)) return;
  throw throwAuthorizationError(
    `Opening a Creator Shop unlocks at a Creator Score of ${CREATOR_SHOP_MIN_CREATOR_SCORE.toLocaleString(
      'en-US'
    )}.`
  );
}
