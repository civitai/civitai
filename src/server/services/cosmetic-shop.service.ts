import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { GetPaginatedCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getPaginatedCosmeticShopItems = async (input: GetPaginatedCosmeticShopItemInput) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.CosmeticShopItemFindManyArgs['where'] = {};
  const cosmeticWhere: Prisma.CosmeticFindManyArgs['where'] = {};

  if (input.name) cosmeticWhere.name = { contains: input.name };
  if (input.types && input.types.length) cosmeticWhere.type = { in: input.types };

  if (Object.keys(cosmeticWhere).length > 0) where.cosmetic = cosmeticWhere;

  const items = await dbRead.cosmeticShopItem.findMany({
    where,
    take,
    skip,
    select: {
      id: true,
      unitAmount: true,
      addedBy: {
        select: simpleUserSelect,
      },
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
    },
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cosmeticShopItem.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};
