import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * Whether the shop offers this cosmetic to the viewer. A sticker purchase is a
 * batch of uses, so holding one is no reason to refuse another unless the
 * holding is unlimited (`stickerRemaining: null`); the server refuses the same.
 */
export function canPurchaseShopCosmetic({
  type,
  owned,
  stickerRemaining,
}: {
  type: CosmeticType;
  owned: boolean;
  stickerRemaining: number | null | undefined;
}) {
  if (type === CosmeticType.ContentDecoration) return true;
  if (type === CosmeticType.Sticker) return stickerRemaining !== null;
  return !owned;
}
