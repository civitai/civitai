import { CosmeticType } from '~/shared/utils/prisma/enums';
import { PACK_FILTER_VALUE } from '~/server/schema/creator-shop.schema';

export const cosmeticTypeOptions = [
  { value: CosmeticType.Badge, label: 'Badge' },
  { value: CosmeticType.ProfileDecoration, label: 'Avatar Frame' },
  { value: CosmeticType.ProfileBackground, label: 'Profile Background' },
  { value: CosmeticType.Sticker, label: 'Sticker' },
];

// The review queue also holds packs, which are not a CosmeticType.
export const reviewQueueTypeOptions = [
  ...cosmeticTypeOptions,
  { value: PACK_FILTER_VALUE, label: 'Pack' },
];
export type ReviewQueueFilterType = CosmeticType | typeof PACK_FILTER_VALUE;

// The cosmetic types a creator can list — the only ones worth filtering by in the storefront.
export const creatorShopFilterTypes = cosmeticTypeOptions.map((o) => o.value);
// Buyer-facing shelves hold packs too, so the shopper needs a chip for them —
// without one, ticking any type made packs vanish with no way to ask for them.
export const shopFilterTypesWithPack = [...creatorShopFilterTypes, PACK_FILTER_VALUE];
