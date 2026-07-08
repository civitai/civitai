import { Prisma } from '@prisma/client';
import { Availability } from '~/shared/utils/prisma/enums';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelVersionAccessCache } from '~/server/redis/caches';
import type { SupportedAvailabilityResources } from '../schema/base.schema';

type EntityAccessMeta = {
  buzzTransactionId?: string;
} & MixedObject;

type EntityAccessRaw = {
  entityId: number;
  hasAccess: boolean;
  permissions: number;
  meta?: EntityAccessMeta;
};

type UserEntityAccessStatus = EntityAccessRaw & {
  entityId: number;
  entityType: SupportedAvailabilityResources;
  hasAccess: boolean;
  availability: Availability;
};

const OPEN_ACCESS_AVAILABILITY = [Availability.Public, Availability.Unsearchable] as const;

export type EntityAccessDataType = {
  entityId: number;
  userId: number;
  availability: Availability;
};

export const hasEntityAccess = async ({
  entityType,
  entityIds,
  isModerator,
  userId,
  permissions,
}: {
  entityType: SupportedAvailabilityResources;
  entityIds: number[];
  userId?: number;
  isModerator?: boolean;
  permissions?: number;
}): Promise<UserEntityAccessStatus[]> => {
  if (!entityIds.length) {
    return [];
  }

  let data: EntityAccessDataType[];
  if (entityType === 'ModelVersion') {
    const cacheData = await modelVersionAccessCache.fetch(entityIds);
    data = Object.values(cacheData);
  } else {
    const query: Prisma.Sql =
      //     entityType === 'ModelVersion'
      //       ? Prisma.sql`
      //    SELECT
      //      mv.id as "entityId",
      //      mmv."userId" as "userId",
      //      mv."availability" as "availability"
      //    FROM "ModelVersion" mv
      //    JOIN "Model" mmv ON mv."modelId" = mmv.id
      //    WHERE mv.id IN (${Prisma.join(entityIds, ',')})
      // ` :
      entityType === 'Article'
        ? Prisma.sql`
    SELECT
      a."id" as "entityId",
      a."userId" as "userId",
      a."availability" as "availability"
    FROM "Article" a
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `
        : entityType === 'Post'
        ? Prisma.sql`
    SELECT
      p."id" as "entityId",
      p."userId" as "userId",
      p."availability" as "availability"
    FROM "Post" p
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `
        : entityType === 'Model'
        ? Prisma.sql`
    SELECT
      m."id" as "entityId",
      m."userId" as "userId",
      m."availability" as "availability"
    FROM "Model" m
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `
        : entityType === 'Collection'
        ? Prisma.sql`
    SELECT
      c."id" as "entityId",
      c."userId" as "userId",
      c."availability" as "availability"
    FROM "Collection" c
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `
        : entityType === 'Bounty'
        ? Prisma.sql`
    SELECT
      b."id" as "entityId",
      b."userId" as "userId",
      b."availability" as "availability"
    FROM "Bounty" b
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `
        : entityType === 'ComicChapter'
        ? Prisma.sql`
    SELECT
      cc."id" as "entityId",
      cp."userId" as "userId",
      cc."availability" as "availability"
    FROM "ComicChapter" cc
    JOIN "ComicProject" cp ON cc."projectId" = cp.id
    WHERE cc."id" IN (${Prisma.join(entityIds, ',')})
  `
        : Prisma.sql`SELECT NULL::int as "entityId", NULL::int as "userId", NULL::"Availability" as "availability" WHERE false`;

    data = await dbRead.$queryRaw<EntityAccessDataType[]>(query);
  }

  const matched = entityIds.map((entityId) => ({
    entityId,
    entityType,
    hasAccess: false,
    availability: Availability.Private,
    permissions: -1,
    ...data.find((x) => x.entityId === entityId),
  }));

  const privateRecords = matched.filter((d) =>
    // Private & EarlyAccess both require a permission check.
    [Availability.Private, Availability.EarlyAccess].some((a) => a === d.availability)
  );

  // All entities are public. Access granted to everyone.
  if (privateRecords.length === 0 || isModerator) {
    return matched.map((d) => ({
      entityId: d.entityId,
      entityType,
      hasAccess: true,
      availability: d.availability,
      permissions: EntityAccessPermission.All,
    }));
  }

  const ownedRecords = matched.filter((d) => d.userId === userId);

  // Owners always have access.
  if (userId && ownedRecords.length === matched.length) {
    // Access to all records since all are owned by the user.
    return matched.map((d) => ({
      entityId: d.entityId,
      entityType,
      hasAccess: true,
      availability: d.availability,
      permissions: EntityAccessPermission.All,
    }));
  }

  if (!userId) {
    // Unauthenticated user. Only grant access to public items.
    return matched.map((d) => ({
      entityType,
      entityId: d.entityId,
      hasAccess: OPEN_ACCESS_AVAILABILITY.some((a) => a === d.availability),
      availability: d.availability,
      permissions: EntityAccessPermission.All,
    }));
  }

  // Note, we use DB write because we don't wanna have the user experience lag after unlocks.
  const entityAccess = await dbWrite.$queryRaw<EntityAccessRaw[]>`
    SELECT
      ea."accessToId" "entityId",
      ${
        !!permissions ? Prisma.sql`(${permissions} & ea."permissions") != 0` : Prisma.sql`true`
      } as "hasAccess",
      ea."permissions",
      ea."meta"
    FROM "EntityAccess" ea
    WHERE ea."accessToId" IN (${Prisma.join(entityIds, ', ')})
      AND ea."accessToType" = ${entityType}
      AND ea."accessorType" = 'User' AND ea."accessorId" = ${userId}
  `;

  // Complex scenario - we have mixed entities with public/private access.
  return entityIds.map((entityId) => {
    const openAccess = data.find(
      (entity) =>
        entity.entityId === entityId &&
        OPEN_ACCESS_AVAILABILITY.some((a) => a === entity.availability)
    );
    // If the entity is public, we're ok to assume the user has access.
    if (openAccess) {
      return {
        entityId,
        entityType,
        hasAccess: true,
        availability: openAccess.availability,
        permissions: 0,
      };
    }

    const resource = data.find((d) => d.entityId === entityId);
    const privateEntityAccess = entityAccess.find((entity) => entity.entityId === entityId);
    // If we could not find a privateEntityAccess record, means the user is guaranteed not to have
    // a link between the entity and himself.
    if (!privateEntityAccess) {
      return {
        entityId,
        entityType,
        hasAccess: false,
        availability: resource?.availability ?? Availability.Private,
        permissions: -1,
      };
    }

    const { hasAccess, permissions, meta } = privateEntityAccess;
    return {
      entityId,
      entityType,
      hasAccess,
      availability: resource?.availability ?? Availability.Private,
      permissions,
      meta,
    };
  });
};

export const entityOwnership = async ({
  entityType,
  entityIds,
  userId,
}: {
  entityType: SupportedAvailabilityResources;
  entityIds: number[];
  userId: number;
}): Promise<
  { entityId: number; entityType: SupportedAvailabilityResources; isOwner: boolean }[]
> => {
  if (entityIds.length === 0) {
    return [];
  }

  const entitiesOwnership = await dbWrite.$queryRaw<
    {
      entityId: number;
      isOwner: boolean;
    }[]
  >`
    SELECT
    ${
      entityType === 'ModelVersion'
        ? Prisma.raw(`
      mmv.id as "entityId",
      mmv."userId" = ${userId} as "isOwner"
    `)
        : entityType === 'Article'
        ? Prisma.raw(`
      a."id" as "entityId",
      a."userId" = ${userId} as "isOwner"
    `)
        : entityType === 'Post'
        ? Prisma.raw(`
      p."id" as "entityId",
      p."userId" = ${userId} as "isOwner"
    `)
        : ''
    }
    ${
      entityType === 'ModelVersion'
        ? Prisma.raw(`
        FROM "ModelVersion" mv
        JOIN "Model" mmv ON mv."modelId" = mmv.id
        WHERE mv.id IN (${entityIds.join(', ')})
    `)
        : entityType === 'Article'
        ? Prisma.raw(`
        FROM "Article" a
        WHERE id IN (${entityIds.join(', ')})
    `)
        : entityType === 'Post'
        ? Prisma.raw(`
        FROM "Post" p
        WHERE id IN (${entityIds.join(', ')})
    `)
        : ''
    }
  `;

  return entitiesOwnership.map((entity) => ({
    ...entity,
    entityType,
  }));
};

export const entityAvailabilityUpdate = async ({
  entityType,
  entityIds,
  availability,
}: {
  entityType: SupportedAvailabilityResources;
  entityIds: number[];
  availability: Availability;
}) => {
  if (entityIds.length === 0) {
    return;
  }

  await dbWrite.$executeRawUnsafe<{ entityId: number; isOwner: boolean }[]>(`
    UPDATE "${entityType}" t
    SET "availability" = '${availability}'::"Availability",
      "updatedAt" = NOW()
    WHERE t.id IN (${entityIds.join(', ')})`);
};

export type EntityAccessWithKey = {
  entityId: number;
  entityType: SupportedAvailabilityResources;
  entityKey: string;
};

export const getUserEntityAccess = async ({ userId }: { userId: number }) => {
  const entities = await dbRead.$queryRaw<EntityAccessWithKey[]>`
    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    WHERE ea."accessorType" = 'User' AND ea."accessorId" = ${userId}
  `;

  return entities;
};
