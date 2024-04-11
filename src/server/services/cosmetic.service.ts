import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { EquipCosmeticInput, GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export async function getCosmeticDetail({ id }: GetByIdInput) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
  });

  return cosmetic;
}

export async function isCosmeticAvailable(id: number, userId?: number) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
    select: { availableStart: true, availableEnd: true, availableQuery: true },
  });
  if (!cosmetic) throw new Error("That cosmetic doesn't exist");

  if (!dayjs().isBetween(cosmetic.availableStart, cosmetic.availableEnd)) return false;
  else if (cosmetic.availableQuery) {
    if (!userId) return false;

    // If the cosmetic has a query, check if the user is eligible
    const result = await dbRead.$queryRawUnsafe<{ available: boolean }[]>(
      cosmetic.availableQuery.replace(/\$\{userId\}/g, `${userId}`)
    );
    if (!result[0].available) return false;
  }

  return true;
}

export const getPaginatedCosmetics = async (input: GetPaginatedCosmeticsInput) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.CosmeticFindManyArgs['where'] = {};
  const items = await dbRead.cosmetic.findMany({
    where,
    take,
    skip,
    select: simpleCosmeticSelect,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cosmetic.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export async function equipCosmeticToEntity({
  cosmeticId,
  equippedToType,
  equippedToId,
  userId,
}: EquipCosmeticInput & { userId: number }) {
  const userCosmetics = await dbWrite.userCosmetic.findMany({
    where: { userId, cosmeticId },
    select: { obtainedAt: true, equippedToId: true, cosmetic: { select: { type: true } } },
  });
  if (!userCosmetics.length) throw new Error("You don't have that cosmetic");

  const updated = await dbWrite.userCosmetic.updateMany({
    where: { userId, cosmeticId },
    data: { equippedToId, equippedToType, equippedAt: new Date() },
  });

  return updated;
}

export async function unequipCosmetic({
  cosmeticId,
  equippedToId,
  userId,
}: EquipCosmeticInput & { userId: number }) {
  return dbWrite.userCosmetic.updateMany({
    where: { cosmeticId, equippedToId, userId },
    data: { equippedToId: null, equippedToType: null, equippedAt: null },
  });
}
