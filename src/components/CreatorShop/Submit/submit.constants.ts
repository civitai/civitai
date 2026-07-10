import { CosmeticType } from '~/shared/utils/prisma/enums';

export const cosmeticTypeOptions = [
  { value: CosmeticType.Badge, label: 'Badge' },
  { value: CosmeticType.ProfileDecoration, label: 'Avatar Frame' },
  { value: CosmeticType.ProfileBackground, label: 'Profile Background' },
];

// The cosmetic types a creator can list — the only ones worth filtering by in the storefront.
export const creatorShopFilterTypes = cosmeticTypeOptions.map((o) => o.value);
