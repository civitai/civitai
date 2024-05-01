import { CosmeticEntity, Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { EquipCosmeticInput, GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import {
  ContentDecorationCosmetic,
  WithClaimKey,
  simpleCosmeticSelect,
} from '~/server/selectors/cosmetic.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import { cachedObject, bustCachedArray } from '~/server/utils/cache-helpers';

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
  if (input.name) where.name = { contains: input.name };
  if (input.types && input.types.length) where.type = { in: input.types };
  const items = await dbRead.cosmetic.findMany({
    where,
    take,
    skip,
    select: {
      ...simpleCosmeticSelect,
      _count: {
        select: {
          cosmeticShopItems: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cosmetic.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export async function equipCosmeticToEntity({
  cosmeticId,
  claimKey,
  equippedToType,
  equippedToId,
  userId,
}: EquipCosmeticInput & { userId: number }) {
  const userCosmetic = await dbWrite.userCosmetic.findFirst({
    where: { userId, cosmeticId, claimKey },
    select: {
      obtainedAt: true,
      equippedToId: true,
      equippedToType: true,
      forId: true,
      forType: true,
      cosmetic: { select: { type: true } },
    },
  });

  if (!userCosmetic) throw new Error("You don't have that cosmetic");
  if (
    userCosmetic.forId &&
    userCosmetic.forType &&
    userCosmetic.forId !== equippedToId &&
    userCosmetic.forType !== equippedToType
  ) {
    throw new Error('You cannot equip this cosmetic to this entity');
  }

  // Unequip any cosmetic equipped on that entity
  await dbWrite.userCosmetic.updateMany({
    where: { userId, equippedToId, equippedToType },
    data: { equippedToId: null, equippedToType: null, equippedAt: null },
  });

  const updated = await dbWrite.userCosmetic.updateMany({
    where: { userId, cosmeticId, claimKey },
    data: { equippedToId, equippedToType, equippedAt: new Date() },
  });

  await deleteEntityCosmeticCache({ entityId: equippedToId, entityType: equippedToType });
  // Clear cache for previous entity if it was equipped
  if (userCosmetic.equippedToId && userCosmetic.equippedToType) {
    await deleteEntityCosmeticCache({
      entityId: userCosmetic.equippedToId,
      entityType: userCosmetic.equippedToType,
    });
  }

  return updated;
}

export async function unequipCosmetic({
  cosmeticId,
  equippedToId,
  userId,
  claimKey,
  equippedToType,
}: EquipCosmeticInput & { userId: number }) {
  const updated = await dbWrite.userCosmetic.updateMany({
    where: { cosmeticId, equippedToId, userId, claimKey },
    data: { equippedToId: null, equippedToType: null, equippedAt: null },
  });

  await deleteEntityCosmeticCache({ entityId: equippedToId, entityType: equippedToType });

  return updated;
}

export async function getCosmeticsForEntity({
  ids,
  entity,
}: {
  ids: number[];
  entity: CosmeticEntity;
}) {
  if (ids.length === 0) return {};

  return await cachedObject<WithClaimKey<ContentDecorationCosmetic>>({
    key: `${REDIS_KEYS.COSMETICS}:${entity}`,
    idKey: 'equippedToId',
    ids,
    lookupFn: async (ids) => {
      const entityCosmetics = await dbRead.$queryRaw<WithClaimKey<ContentDecorationCosmetic>[]>`
        SELECT c.id, c.data, uc."equippedToId", uc."claimKey"
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."equippedToId" IN (${Prisma.join(ids as number[])})
              AND uc."equippedToType" = '${Prisma.raw(entity)}'::"CosmeticEntity"
              AND c.type = 'ContentDecoration';
      `;
      return Object.fromEntries(entityCosmetics.map((x) => [x.equippedToId, x]));
    },
    ttl: 60 * 60 * 24, // 24 hours
  });
}

export async function deleteEntityCosmeticCache({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: CosmeticEntity;
}) {
  await bustCachedArray(`${REDIS_KEYS.COSMETICS}:${entityType}`, 'equippedToId', entityId);
}
