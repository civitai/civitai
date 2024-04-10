import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetPaginatedCosmeticShopItemInput,
  UpsertCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getShopItemById = async ({ id }: GetByIdInput) => {
  return dbRead.cosmeticShopItem.findUniqueOrThrow({
    where: {
      id,
    },
    select: cosmeticShopItemSelect,
  });
};

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
    select: cosmeticShopItemSelect,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cosmeticShopItem.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export const upsertCosmeticShopItem = async ({
  userId,
  availableQuantity,
  availableTo,
  availableFrom,
  id,
  ...cosmeticShopItem
}: UpsertCosmeticShopItemInput & { userId: number }) => {
  const existingItem = id
    ? await dbRead.cosmeticShopItem.findUnique({
        where: { id },
        select: {
          id: true,
          _count: {
            select: {
              purchases: true,
            },
          },
        },
      })
    : undefined;

  if (existingItem?.id && availableQuantity && existingItem._count.purchases > availableQuantity) {
    throw new Error('Cannot reduce available quantity below the number of purchases');
  }

  if (availableTo && availableFrom && availableTo < availableFrom) {
    throw new Error('Available to date cannot be before available from date');
  }

  if (id) {
    return dbWrite.cosmeticShopItem.upsert({
      where: { id },
      create: {
        ...cosmeticShopItem,
        availableQuantity,
        addedById: userId,
      },
      update: cosmeticShopItem,
      select: cosmeticShopItemSelect,
    });
  } else {
    return dbWrite.cosmeticShopItem.create({
      data: {
        ...cosmeticShopItem,
        availableQuantity,
        addedById: userId,
        availableTo,
        availableFrom,
      },
    });
  }
};
