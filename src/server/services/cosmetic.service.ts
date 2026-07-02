import { Prisma } from '@prisma/client';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { cosmeticEntityCaches } from '~/server/redis/caches';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  EquipCosmeticInput,
  GetPaginatedCosmeticsInput,
} from '~/server/schema/cosmetic.schema';
import {
  articlesSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';

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

  await cosmeticEntityCaches[equippedToType].refresh(equippedToId);

  if (equippedToType === 'Model')
    await modelsSearchIndex.queueUpdate([
      { id: equippedToId, action: SearchIndexUpdateQueueAction.Update },
    ]);
  if (equippedToType === 'Image')
    await queueImageSearchIndexUpdate({
      ids: [equippedToId],
      action: SearchIndexUpdateQueueAction.Update,
    });
  if (equippedToType === 'Article')
    await articlesSearchIndex.queueUpdate([
      { id: equippedToId, action: SearchIndexUpdateQueueAction.Update },
    ]);

  // Clear cache for previous entity if it was equipped
  if (userCosmetic.equippedToId && userCosmetic.equippedToType) {
    await cosmeticEntityCaches[userCosmetic.equippedToType].refresh(userCosmetic.equippedToId);
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

  await cosmeticEntityCaches[equippedToType].refresh(equippedToId);

  if (equippedToType === 'Model')
    await modelsSearchIndex.queueUpdate([
      { id: equippedToId, action: SearchIndexUpdateQueueAction.Update },
    ]);
  if (equippedToType === 'Image')
    await queueImageSearchIndexUpdate({
      ids: [equippedToId],
      action: SearchIndexUpdateQueueAction.Update,
    });
  if (equippedToType === 'Article')
    await articlesSearchIndex.queueUpdate([
      { id: equippedToId, action: SearchIndexUpdateQueueAction.Update },
    ]);

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
  return await cosmeticEntityCaches[entity].fetch(ids);
}

export const grantCosmetics = async ({
  userId,
  cosmeticIds,
}: {
  userId: number;
  cosmeticIds: number[];
}) => {
  if (cosmeticIds.length === 0) return;

  await dbWrite.$executeRaw`
    INSERT INTO "UserCosmetic"("userId", "cosmeticId", "claimKey")
    SELECT
      ${userId} "userId",
      c.id as "cosmeticId",
      'claimed'
    FROM "Cosmetic" c
    WHERE c.id IN (${Prisma.join(cosmeticIds)})
    ON CONFLICT DO NOTHING;
  `;
};

// NOTE(moderator-migration): grantCosmeticsToUsers (the moderator cross-product grant) now lives in the
// spoke app (apps/moderator, Kysely). The shared grantCosmetics helper above stays (payments/referrals).

/**
 * Resolve a target descriptor (collection of approved items, or explicit
 * userIds) to the set of users that should receive a cosmetic, then grant it.
 *
 * - `target.type === 'collection'`: every user whose CollectionItem in that
 *   collection has status ACCEPTED (the moderator-approved state). When
 *   `requireApproved` is false, includes REVIEW + REJECTED too — rare, but
 *   supported for completeness.
 * - `target.type === 'userIds'`: exactly the listed users.
 *
 * `dryRun: true` resolves and returns the user list without granting.
 */
export async function assignCosmeticByTarget({
  cosmeticId,
  target,
  dryRun = false,
}: {
  cosmeticId: number;
  target:
    | { type: 'collection'; collectionId: number; requireApproved?: boolean }
    | { type: 'userIds'; userIds: number[] };
  dryRun?: boolean;
}) {
  let userIds: number[];
  if (target.type === 'userIds') {
    userIds = Array.from(new Set(target.userIds));
  } else {
    const requireApproved = target.requireApproved ?? true;
    const rows = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT ci."addedById" AS "userId"
      FROM "CollectionItem" ci
      WHERE ci."collectionId" = ${target.collectionId}
        AND ci."addedById" IS NOT NULL
        ${
          requireApproved
            ? Prisma.sql`AND ci."status" = 'ACCEPTED'::"CollectionItemStatus"`
            : Prisma.empty
        }
    `;
    userIds = rows.map((r) => r.userId);
  }

  if (dryRun) {
    return { granted: 0, userIds, dryRun: true };
  }

  // Single bulk insert via unnest — one round-trip vs. N. Returns rows that
  // were actually inserted (ON CONFLICT DO NOTHING skips already-granted users),
  // so `granted` reflects truth, not request size.
  let granted = 0;
  if (userIds.length > 0) {
    const inserted = await dbWrite.$queryRaw<{ userId: number }[]>`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT u, ${cosmeticId}, 'claimed'
      FROM unnest(${userIds}::int[]) AS u
      WHERE EXISTS (SELECT 1 FROM "Cosmetic" WHERE id = ${cosmeticId})
      ON CONFLICT DO NOTHING
      RETURNING "userId"
    `;
    granted = inserted.length;
  }

  return { granted, userIds, dryRun: false };
}

export async function unassignCosmetic({
  cosmeticId,
  userIds,
}: {
  cosmeticId: number;
  userIds: number[];
}) {
  if (userIds.length === 0) return { count: 0 };
  const result = await dbWrite.userCosmetic.deleteMany({
    where: { cosmeticId, userId: { in: userIds } },
  });
  return { count: result.count };
}

export async function createCosmetic(data: Prisma.CosmeticUncheckedCreateInput) {
  const cosmetic = await dbWrite.cosmetic.create({ data });
  return cosmetic;
}

export async function updateCosmetic({
  id,
  data,
}: {
  id: number;
  data: Prisma.CosmeticUncheckedUpdateInput;
}) {
  const cosmetic = await dbWrite.cosmetic.update({ where: { id }, data });
  return cosmetic;
}

export async function deleteCosmetic({ id }: { id: number }) {
  await dbWrite.cosmetic.delete({ where: { id } });
  return { deleted: true };
}
