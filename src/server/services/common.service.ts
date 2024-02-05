import { dbRead, dbWrite } from '~/server/db/client';
import { Availability, Prisma } from '@prisma/client';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { isDefined } from '~/utils/type-guards';
import { SupportedAvailabilityResources } from '../schema/base.schema';

const entityAccessOwnerTypes = ['User', 'Club', 'ClubTier'] as const;
type EntityAccessOwnerType = (typeof entityAccessOwnerTypes)[number];

type UserEntityAccessStatus = {
  entityId: number;
  entityType: SupportedAvailabilityResources;
  hasAccess: boolean;
  availability: Availability;
};

type EntityAccessRaw = {
  entityId: number;
  hasAccess: boolean;
};

const OPEN_ACCESS_AVAILABILITY = [Availability.Public, Availability.Unsearchable] as const;

export const hasEntityAccess = async ({
  entityType,
  entityIds,
  isModerator,
  userId,
}: {
  entityType: SupportedAvailabilityResources;
  entityIds: number[];
  userId?: number;
  isModerator?: boolean;
}): Promise<UserEntityAccessStatus[]> => {
  if (!entityIds.length) {
    return [];
  }

  const query: Prisma.Sql =
    entityType === 'ModelVersion'
      ? Prisma.sql`
     SELECT
       mv.id as "entityId",
       mmv."userId" as "userId",
       mv."availability" as "availability"
     FROM "ModelVersion" mv
     JOIN "Model" mmv ON mv."modelId" = mmv.id
     WHERE mv.id IN (${Prisma.join(entityIds, ',')})
  `
      : entityType === 'Article'
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
      : // Bounty
        Prisma.sql`
    SELECT
      b."id" as "entityId",
      b."userId" as "userId",
      b."availability" as "availability"
    FROM "Bounty" b
    WHERE id IN (${Prisma.join(entityIds, ',')})
  `;

  const data = await dbRead.$queryRaw<
    { availability: Availability; userId: number; entityId: number }[]
  >(query);

  const privateRecords = data.filter((d) => d.availability === Availability.Private);

  // All entities are public. Access granted to everyone.
  if (privateRecords.length === 0 || isModerator) {
    return data.map((d) => ({
      entityId: d.entityId,
      entityType,
      hasAccess: true,
      availability: d.availability,
    }));
  }

  const ownedRecords = data.filter((d) => d.userId === userId);

  // Owners always have access.
  if (userId && ownedRecords.length === data.length) {
    // Access to all records since all are owned by the user.
    return data.map((d) => ({
      entityId: d.entityId,
      entityType,
      hasAccess: true,
      availability: d.availability,
    }));
  }

  if (!userId) {
    // Unauthenticated user. Only grant access to public items.
    return data.map((d) => ({
      entityType,
      entityId: d.entityId,
      hasAccess: OPEN_ACCESS_AVAILABILITY.some((a) => a === d.availability),
      availability: d.availability,
    }));
  }

  // TODO: Add userId index to Club, ClubMemberhsip and ClubAdmin.
  const entityAccess = await dbRead.$queryRaw<EntityAccessRaw[]>`
    SELECT
      ea."accessToId" "entityId",
      true as "hasAccess"
    FROM "EntityAccess" ea
    WHERE ea."accessToId" IN (${Prisma.join(entityIds, ', ')})
      AND ea."accessToType" = ${entityType}
      AND (
        -- ClubTier check
        (
          ea."accessorType" = 'ClubTier' AND
          (
            -- User is a member of the club tier
            ea."accessorId" IN (
              SELECT cm."clubTierId"
              FROM "ClubMembership" cm
              WHERE cm."userId" = ${userId} AND (cm."expiresAt"<= NOW() OR cm."expiresAt" IS NULL)
            )
            -- User is a admin of the club tier
            OR ea."accessorId" IN (
              SELECT ct.id
              FROM "ClubTier" ct
              JOIN "ClubAdmin" ca ON ca."clubId" = ct."clubId"
              WHERE ca."userId" = ${userId}
            )
            -- User is a owner of the club
            OR ea."accessorId" IN (
              SELECT ct.id
              FROM "ClubTier" ct
              JOIN "Club" c ON c.id = ct."clubId"
              WHERE c."userId" = ${userId}
            )
          )
        ) OR
        -- Club check
        (
          ea."accessorType" = 'Club' AND
          (
            -- User is the owner of the club
            ea."accessorId" IN (
              SELECT c.id
              FROM "Club" c
              WHERE c."userId" = ${userId}
            )
            -- User is a member of this club
            OR ea."accessorId" IN (
              SELECT cm."clubId"
              FROM "ClubMembership" cm
              WHERE cm."userId" = ${userId} AND (cm."expiresAt"<= NOW() OR cm."expiresAt" IS NULL)
            )
            --- User is an admin of this club
            OR ea."accessorId" IN (
              SELECT ca."clubId"
              FROM "ClubAdmin" ca
              WHERE ca."userId" = ${userId}
            )
          )
        ) OR
        -- User check
        (
          ea."accessorType" = 'User' AND ea."accessorId" = ${userId}
        )
      )
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
      };
    }

    const privateEntityAccess = entityAccess.find((entity) => entity.entityId === entityId);
    // If we could not find a privateEntityAccess record, means the user is guaranteed not to have
    // a link between the entity and himself.
    if (!privateEntityAccess) {
      return {
        entityId,
        entityType,
        hasAccess: false,
        availability: Availability.Private,
      };
    }

    const { hasAccess } = privateEntityAccess;
    return {
      entityId,
      entityType,
      hasAccess,
      availability: Availability.Private,
    };
  });
};

type ClubEntityAccessStatus = {
  entityId: number;
  entityType: SupportedClubEntities;
  requiresClub: boolean;
  clubs: {
    clubId: number;
    clubTierIds: number[];
  }[];
  availability: Availability;
};

export const entityRequiresClub = async ({
  entityIds,
  entityType,
  clubId,
  clubIds,
  tx,
}: {
  entityIds: number[];
  entityType: SupportedClubEntities;
  clubId?: number;
  clubIds?: number[];
  tx?: Prisma.TransactionClient;
}): Promise<ClubEntityAccessStatus[]> => {
  if (entityIds.length === 0) {
    return [];
  }

  const client = tx || dbRead;

  let query = Prisma.sql``;
  switch (entityType) {
    case 'ModelVersion':
      query = Prisma.sql`
        SELECT
          mv.id as "entityId",
          mv."availability" as "availability"
        FROM "ModelVersion" mv
        WHERE mv.id IN (${Prisma.join(entityIds, ', ')})
        `;

      break;
    case 'Article':
      query = Prisma.sql`
        SELECT
          a."id" as "entityId",
          a."availability" as "availability"
        FROM "Article" a
        WHERE id IN (${Prisma.join(entityIds, ', ')})
        `;
      break;
    case 'Post':
      query = Prisma.sql`
        SELECT
          p."id" as "entityId",
          p."availability" as "availability"
        FROM "Post" p
        WHERE id IN (${Prisma.join(entityIds, ', ')})
          `;
      break;
    case 'Post':
      query = Prisma.sql`
        SELECT
          p."id" as "entityId",
          p."availability" as "availability"
        FROM "Post" p
        WHERE id IN (${Prisma.join(entityIds, ', ')})
          `;
      break;
    default:
      query = Prisma.sql``;
  }

  const entitiesAvailability = await client.$queryRaw<
    { availability: Availability; entityId: number }[]
  >`
    ${query}
  `;

  const publicEntities = entitiesAvailability.filter(
    (entity) => entity.availability !== Availability.Private
  );
  const privateEntities = entitiesAvailability.filter(
    (entity) => entity.availability === Availability.Private
  );

  const publicEntitiesAccess = publicEntities.map((entity) => ({
    entityType,
    entityId: entity.entityId,
    requiresClub: false,
    clubs: [],
    availability: entity.availability,
  }));

  if (!privateEntities.length) {
    return publicEntitiesAccess;
  }

  const getClubFilter = (accessor: string) => {
    if (clubIds && clubIds.length > 0) {
      return Prisma.raw(`AND ${accessor} IN (${Prisma.join(clubIds, ', ')})`);
    }

    if (clubId) {
      return Prisma.raw(`AND ${accessor} = ${clubId}`);
    }
    return Prisma.raw('');
  };

  const privateEntitiesAccess = await client.$queryRaw<
    {
      entityId: number;
      entityType: string;
      clubId: number;
      clubTierId: number | null;
    }[]
  >`
    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      COALESCE(c.id, ct."clubId") as "clubId",
      ct."id" as "clubTierId"
    FROM "EntityAccess" ea
    LEFT JOIN "Club" c ON ea."accessorType" = 'Club' AND ea."accessorId" = c.id ${getClubFilter(
      'c.id'
    )}
    LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" ${getClubFilter(
      'ct."clubId"'
    )}
    WHERE ea."accessToId" IN (${Prisma.join(entityIds, ', ')})
      AND ea."accessToType" = ${entityType}
    ORDER BY "clubTierId", "clubId"
  `;

  const access: ClubEntityAccessStatus[] = entityIds.map((entityId) => {
    const publicEntityAccess = publicEntitiesAccess.find(
      (entity) => entity.entityId === entityId && entity.entityType === entityType
    );

    if (publicEntityAccess) {
      return publicEntityAccess;
    }

    const privateEntityAccesses = privateEntitiesAccess.filter(
      (entity) => entity.entityId === entityId && entity.entityType === entityType
    );

    if (privateEntityAccesses.length === 0) {
      return {
        entityId,
        entityType,
        requiresClub: false,
        clubs: [],
        availability: Availability.Private,
      };
    }

    const clubIds = [
      ...new Set(privateEntityAccesses.map((privateEntityAccess) => privateEntityAccess.clubId)),
    ];

    return {
      entityId,
      entityType,
      requiresClub: true,
      availability: Availability.Private,
      clubs: clubIds.map((clubId) => ({
        clubId,
        clubTierIds: privateEntityAccesses
          .filter((e) => e.clubId === clubId)
          .map((e) => e.clubTierId)
          .filter(isDefined),
      })),
    };
  });

  return access;
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
    SET "availability" = '${availability}'::"Availability"
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

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "Club" c ON c.id = ea."accessorId" AND ea."accessorType" = 'Club'
    WHERE c."userId" = ${userId}

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "ClubTier" ct ON ct.id = ea."accessorId" AND ea."accessorType" = 'ClubTier'
    JOIN "Club" c ON c.id = ct."clubId"
    WHERE c."userId" = ${userId}

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "ClubTier" ct ON ct.id = ea."accessorId" AND ea."accessorType" = 'ClubTier'
    JOIN "ClubAdmin" ca ON ca."clubId" = ct."clubId"
    WHERE ca."userId" = ${userId}

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "Club" c ON c.id = ea."accessorId" AND ea."accessorType" = 'Club'
    JOIN "ClubAdmin" ca ON ca."clubId" = c.id
    WHERE ca."userId" = ${userId}

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "ClubMembership" cm ON cm."clubId" = ea."accessorId" AND ea."accessorType" = 'Club'
    WHERE cm."userId" = ${userId} AND (cm."expiresAt"<= NOW() OR cm."expiresAt" IS NULL)

    UNION

    SELECT
      ea."accessToId" "entityId",
      ea."accessToType" "entityType",
      CONCAT(ea."accessToType", ':', ea."accessToId") "entityKey"
    FROM "EntityAccess" ea
    JOIN "ClubMembership" cm ON cm."clubId" = ea."accessorId" AND ea."accessorType" = 'ClubTier'
    WHERE cm."userId" = ${userId} AND (cm."expiresAt"<= NOW() OR cm."expiresAt" IS NULL)
  `;

  return entities;
};
