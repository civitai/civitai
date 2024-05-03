import { TextProps } from '@mantine/core';
import { Prisma } from '@prisma/client';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';

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
    select: simpleCosmeticSelect,
  },
  cosmeticId: true,
  meta: true,
});
