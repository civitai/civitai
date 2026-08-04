import { Prisma } from '@prisma/client';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  cosmeticCache,
  cosmeticEntityCaches,
  refreshOwnedStickerCache,
  userCosmeticCache,
  userOwnedStickerCache,
} from '~/server/redis/caches';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  EquipCosmeticInput,
  GetStickerCosmeticsInput,
  GetPaginatedCosmeticsInput,
} from '~/server/schema/cosmetic.schema';
import {
  articlesSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { STICKER_SLUG_ERROR, isValidStickerSlug } from '~/shared/utils/sticker-token';
import type { StickerCosmetic } from '~/server/selectors/cosmetic.selector';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import {
  getCosmeticArtworkUrl,
  queueCosmeticPerceptualHash,
} from '~/server/services/cosmetic-phash.service';

export async function getCosmeticDetail({ id }: GetByIdInput) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
  });

  return cosmetic;
}

export async function getStickerCosmetics({ ids }: GetStickerCosmeticsInput) {
  const cosmetics = await cosmeticCache.fetch(ids);

  return Object.values(cosmetics)
    .filter((cosmetic) => cosmetic.type === CosmeticType.Sticker)
    .map(({ id, name, data }) => {
      const { slug, url, animated } = (data ?? {}) as StickerCosmetic['data'];
      return { id, name, slug, url, animated };
    })
    .filter((sticker) => !!sticker.slug && !!sticker.url);
}

export async function getOwnedStickerCosmetics(userId: number) {
  const owned = await userOwnedStickerCache.fetch([userId]);
  const ids = owned[userId]?.cosmeticIds ?? [];
  if (!ids.length) return [];

  return getStickerCosmetics({ ids });
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
  if (input.name) where.name = { contains: input.name, mode: 'insensitive' };
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
  // Same rule as equipCosmetic: stickers are owned, not equipped. This is the
  // other door into that state — it would hand the decoration renderer a `data`
  // shape with no cssFrame or offset, on an entity nobody chose it for.
  if (userCosmetic.cosmetic.type === CosmeticType.Sticker)
    throw new Error('Stickers cannot be equipped');
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

  await refreshOwnedStickerCache([userId]);
};

// NOTE(moderator-migration): grantCosmeticsToUsers (the moderator cross-product grant) now lives in the
// spoke app (apps/moderator, Kysely). The shared grantCosmetics helper above stays (payments/referrals).

/**
 * Revoke cosmetics from users across the cross product. Deletes every UserCosmetic row for the pairs,
 * including equipped ones — equipped placements are captured first so entity caches and search indexes
 * can be refreshed once the rows are gone.
 */
export async function revokeCosmeticsFromUsers({
  userIds,
  cosmeticIds,
}: {
  userIds: number[];
  cosmeticIds: number[];
}) {
  const uniqueUserIds = [...new Set(userIds)];
  const uniqueCosmeticIds = [...new Set(cosmeticIds)];

  const equipped = await dbWrite.userCosmetic.findMany({
    where: {
      userId: { in: uniqueUserIds },
      cosmeticId: { in: uniqueCosmeticIds },
      equippedToId: { not: null },
    },
    select: { equippedToId: true, equippedToType: true },
  });

  const { count } = await dbWrite.userCosmetic.deleteMany({
    where: { userId: { in: uniqueUserIds }, cosmeticId: { in: uniqueCosmeticIds } },
  });

  await userCosmeticCache.refresh(uniqueUserIds);
  await refreshOwnedStickerCache(uniqueUserIds);

  const equippedByType = new Map<CosmeticEntity, number[]>();
  for (const { equippedToId, equippedToType } of equipped) {
    if (!equippedToId || !equippedToType) continue;
    equippedByType.set(equippedToType, [
      ...(equippedByType.get(equippedToType) ?? []),
      equippedToId,
    ]);
  }
  for (const [type, ids] of equippedByType) {
    await cosmeticEntityCaches[type].refresh(ids);
    if (type === 'Model')
      await modelsSearchIndex.queueUpdate(
        ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    if (type === 'Image')
      await queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update });
    if (type === 'Article')
      await articlesSearchIndex.queueUpdate(
        ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
  }

  return { revoked: count };
}

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
    await refreshOwnedStickerCache(inserted.map((r) => r.userId));
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
  await refreshOwnedStickerCache(userIds);
  return { count: result.count };
}

/**
 * Sticker slugs are the send-time lookup key, so format and uniqueness are
 * enforced here — every write path (tRPC upsert, Retool) routes through it.
 */
export async function validateStickerCosmetic({
  id,
  type,
  data,
}: {
  id?: number;
  type?: CosmeticType | null;
  data?: unknown;
}) {
  if (type !== CosmeticType.Sticker) return;

  const slug = (data as { slug?: unknown } | null | undefined)?.slug;
  if (typeof slug !== 'string' || !isValidStickerSlug(slug)) {
    throw throwBadRequestError(STICKER_SLUG_ERROR);
  }

  const conflict = await findStickerSlugConflict(dbWrite, slug, id);
  if (conflict) {
    throw throwBadRequestError(`The sticker slug ":${slug}:" is already in use`);
  }
}

// Both the submit-time check above and the form's live check go through this, so
// the two can't disagree about what "taken" means.
function findStickerSlugConflict(client: typeof dbWrite, slug: string, excludeId?: number) {
  return client.cosmetic.findFirst({
    where: {
      type: CosmeticType.Sticker,
      data: { path: ['slug'], equals: slug },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

/**
 * Advisory only — tells a creator a slug is taken before they fill in the rest
 * of the form. It cannot be authoritative: someone can claim the slug between
 * this call and the submit. `validateStickerCosmetic` and the partial unique
 * index are what actually decide, and must not be removed as redundant.
 */
export async function isStickerSlugAvailable({
  slug,
  excludeCosmeticId,
}: {
  slug: string;
  excludeCosmeticId?: number;
}) {
  if (!isValidStickerSlug(slug)) return { available: false };
  const conflict = await findStickerSlugConflict(dbRead, slug, excludeCosmeticId);
  return { available: !conflict };
}

export async function createCosmetic(data: Prisma.CosmeticUncheckedCreateInput) {
  await validateStickerCosmetic({ type: data.type, data: data.data });
  const cosmetic = await dbWrite.cosmetic.create({ data });

  const url = getCosmeticArtworkUrl(cosmetic.data);
  if (url) queueCosmeticPerceptualHash({ id: cosmetic.id, url });

  return cosmetic;
}

export async function updateCosmetic({
  id,
  data,
}: {
  id: number;
  data: Prisma.CosmeticUncheckedUpdateInput;
}) {
  const existing = await dbWrite.cosmetic.findUnique({
    where: { id },
    select: { type: true, data: true },
  });
  await validateStickerCosmetic({
    id,
    type: (data.type as CosmeticType | undefined) ?? existing?.type,
    data: data.data ?? existing?.data,
  });

  const previous = data.data !== undefined ? await getCosmeticDetail({ id }) : undefined;
  const cosmetic = await dbWrite.cosmetic.update({ where: { id }, data });

  const url = getCosmeticArtworkUrl(cosmetic.data);
  if (previous && url && url !== getCosmeticArtworkUrl(previous.data)) {
    queueCosmeticPerceptualHash({ id: cosmetic.id, url });
  }

  return cosmetic;
}

export async function deleteCosmetic({ id }: { id: number }) {
  await dbWrite.cosmetic.delete({ where: { id } });
  return { deleted: true };
}
