import { Prisma } from '@prisma/client';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const cosmeticShopItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  id: true,
  unitAmount: true,
  availableFrom: true,
  availableTo: true,
  availableQuantity: true,
  title: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  cosmetic: {
    // creator = attribution for creator-made cosmetics featured in official
    // sections (null for official cosmetics).
    select: {
      ...simpleCosmeticSelect,
      videoUrl: true,
      creator: { select: userWithCosmeticsSelect },
    },
  },
  cosmeticId: true,
  meta: true,
});
