import { dbRead, dbWrite } from '~/server/db/client';
import { Availability, Prisma } from '@prisma/client';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { isDefined } from '~/utils/type-guards';

const entityAccessOwnerTypes = ['User', 'Club', 'ClubTier'] as const;
type EntityAccessOwnerType = (typeof entityAccessOwnerTypes)[number];

type UserEntityAccessStatus = {
  entityId: number;
  entityType: SupportedClubEntities;
  hasAccess: boolean;
};

export const hasEntityAccess = async ({
  entities,
  userId,
  isModerator,
}: {
  entities: {
    entityType: SupportedClubEntities;
    entityId: number;
  }[];
  userId?: number;
  isModerator?: boolean;
  isPublic?: boolean;
}): Promise<UserEntityAccessStatus[]> => {
  if (!entities.length) {
    return [];
  }

  const res: UserEntityAccessStatus[] = entities.map(({ entityId, entityType }) => ({
    entityId,
    entityType,
    hasAccess: false,
  }));

  if (isModerator) {
    return res.map((r) => ({ ...r, hasAccess: true }));
  }

  const entitiesWith = `
   WITH entities AS (
      SELECT * FROM jsonb_to_recordset('${JSON.stringify(entities)}'::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
    )`;

  const data = await dbRead.$queryRaw<
    { availability: Availability; userId: number; entityId: number; entityType: string }[]
  >`
   ${Prisma.raw(entitiesWith)}
    SELECT
        "entityType",
        "entityId",
        COALESCE(mmv."userId", a."userId") as "userId",
        COALESCE(mv."availability", a."availability") as "availability"
    FROM entities e
    LEFT JOIN "ModelVersion" mv ON e."entityType" = 'ModelVersion' AND e."entityId" = mv.id
    LEFT JOIN "Model" mmv ON mv."modelId" = mmv.id
    LEFT JOIN "Article" a ON e."entityType" = 'Article' AND e."entityId" = a.id
  `;

  const privateRecords = data.filter((d) => d.availability === Availability.Private);

  // All entities are public. Access granted to everyone.
  if (privateRecords.length === 0) {
    return res.map((r) => ({ ...r, hasAccess: true }));
  }

  const ownedRecords = data.filter((d) => d.userId === userId);

  // Owners always have access.
  if (userId && ownedRecords.length === data.length) {
    // Access to all records since all are owned by the user.
    return res.map((r) => ({ ...r, hasAccess: true }));
  }

  if (!userId) {
    // Unauthenticated user. Only grant access to public items.
    return data.map((d) => ({
      entityId: d.entityId,
      entityType: d.entityType as SupportedClubEntities,
      hasAccess: d.availability === Availability.Public,
    }));
  }

  const entityAccess = await dbRead.$queryRaw<
    {
      entityId: number;
      entityType: SupportedClubEntities;
      hasAccess: boolean;
    }[]
  >`
    ${Prisma.raw(entitiesWith)}
    SELECT 
      ea."accessToId" "entityId",
	    ea."accessToType" "entityType",
      COALESCE(c.id, cct.id, cmc."clubId", cmt."clubId", u.id) IS NOT NULL as "hasAccess"
    FROM entities e
    LEFT JOIN "EntityAccess" ea ON ea."accessToId" = e."entityId" AND ea."accessToType" = e."entityType"
    -- User is the owner of the club and the resource is tied to the club as a whole
    LEFT JOIN "Club" c ON ea."accessorType" = 'Club' AND ea."accessorId" = c.id AND c."userId" = ${userId} 
    -- User is the owner of the club and the resource is tied to a club tier
    LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id"
    LEFT JOIN "Club" cct ON ct."clubId" = cct.id AND cct."userId" = ${userId}
    -- User is a member
    LEFT JOIN "ClubMembership" cmc ON ea."accessorType" = 'Club' AND ea."accessorId" = cmc."clubId" AND cmc."userId" = ${userId}
    LEFT JOIN "ClubMembership" cmt ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = cmt."clubTierId" AND cmt."userId" = ${userId}
    -- User access was granted
    LEFT JOIN "User" u ON ea."accessorType" = 'User' AND ea."accessorId" = u.id AND u.id = ${userId} 
  `;

  // Complex scenario - we have mixed entities with public/private access.
  return entities.map(({ entityId, entityType }) => {
    const publicEntityAccess = data.find(
      (entity) =>
        entity.entityId === entityId &&
        entity.entityType === entityType &&
        entity.availability === Availability.Public
    );
    // If the entity is public, we're ok to assume the user has access.
    if (publicEntityAccess) {
      return {
        entityId,
        entityType,
        hasAccess: true,
      };
    }

    const privateEntityAccess = entityAccess.find(
      (entity) => entity.entityId === entityId && entity.entityType === entityType
    );
    // If we could not find a privateEntityAccess record, means the user is guaranteed not to have
    // a link between the entity and himself.
    if (!privateEntityAccess) {
      return {
        entityId,
        entityType,
        hasAccess: false,
      };
    }

    const { hasAccess } = privateEntityAccess;
    return {
      entityId,
      entityType,
      hasAccess,
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
  entities,
  clubId,
  clubIds,
  tx,
}: {
  entities: {
    entityId: number;
    entityType: SupportedClubEntities;
  }[];
  clubId?: number;
  clubIds?: number[];
  tx?: Prisma.TransactionClient;
}): Promise<ClubEntityAccessStatus[]> => {
  if (entities.length === 0) {
    return [];
  }

  const client = tx || dbRead;

  const entitiesWith = `
   WITH entities AS (
      SELECT * FROM jsonb_to_recordset('${JSON.stringify(entities)}'::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
    )`;

  const entitiesAvailability = await client.$queryRaw<
    { availability: Availability; entityType: SupportedClubEntities; entityId: number }[]
  >`
   ${Prisma.raw(entitiesWith)}
    SELECT
        "entityType",
        "entityId",
         CASE
            WHEN e."entityType" = 'ModelVersion'
                THEN  (SELECT "availability" FROM "ModelVersion" WHERE id = e."entityId") 
            WHEN e."entityType" = 'Article'
                THEN  (SELECT "availability" FROM "Article" WHERE id = e."entityId")
            ELSE 'Public'::"Availability"
        END as "availability"
    FROM entities e
  `;

  const publicEntities = entitiesAvailability.filter(
    (entity) => entity.availability !== Availability.Private
  );
  const privateEntities = entitiesAvailability.filter(
    (entity) => entity.availability === Availability.Private
  );

  const publicEntitiesAccess = publicEntities.map((entity) => ({
    entityId: entity.entityId,
    entityType: entity.entityType,
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
    ${Prisma.raw(entitiesWith)}
    SELECT 
      e."entityId", 
      e."entityType", 
      COALESCE(c.id, ct."clubId") as "clubId",
      ct."id" as "clubTierId"
    FROM entities e
    LEFT JOIN "EntityAccess" ea ON ea."accessToId" = e."entityId" AND ea."accessToType" = e."entityType"
    LEFT JOIN "Club" c ON ea."accessorType" = 'Club' AND ea."accessorId" = c.id ${getClubFilter(
      'c.id'
    )}
    LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" ${getClubFilter(
      'ct."clubId"'
    )}
    ORDER BY "clubTierId", "clubId"
  `;

  const access: ClubEntityAccessStatus[] = entities.map(({ entityId, entityType }) => {
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
  entities,
  userId,
}: {
  entities: { entityType: SupportedClubEntities; entityId: number }[];
  userId: number;
}): Promise<{ entityId: number; entityType: SupportedClubEntities; isOwner: boolean }[]> => {
  if (entities.length === 0) {
    return [];
  }

  const entitiesWith = `
   WITH entities AS (
      SELECT * FROM jsonb_to_recordset('${JSON.stringify(entities)}'::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
    )`;

  const entitiesOwnership = await dbRead.$queryRaw<
    {
      entityId: number;
      entityType: SupportedClubEntities;
      isOwner: boolean;
    }[]
  >`
    ${Prisma.raw(entitiesWith)}
    SELECT
        e."entityId",
        e."entityType",
        COALESCE(mmv."userId", a."userId") = ${userId} as "isOwner"
    FROM entities e
    LEFT JOIN "ModelVersion" mv ON e."entityType" = 'ModelVersion' AND e."entityId" = mv.id
    LEFT JOIN "Model" mmv ON mv."modelId" = mmv.id
    LEFT JOIN "Article" a ON e."entityType" = 'Article' AND e."entityId" = a.id
  `;

  return entitiesOwnership;
};

export const entityAvailabilityUpdate = async ({
  entityType,
  entityIds,
  availability,
}: {
  entityType: SupportedClubEntities;
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
