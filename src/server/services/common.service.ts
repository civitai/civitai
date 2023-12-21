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

// TODO replace "entities" with "entityIds" and "entityType"
export const hasEntityAccess = async ({
  entityType,
  entityIds,
  isModerator,
  userId,
}: {
  entityType: SupportedClubEntities;
  entityIds: number[];
  userId?: number;
  isModerator?: boolean;
}): Promise<UserEntityAccessStatus[]> => {
  if (!entityIds.length) {
    return [];
  }

  const res: UserEntityAccessStatus[] = entityIds.map((entityId) => ({
    entityId,
    entityType,
    hasAccess: false,
  }));

  if (isModerator) {
    return res.map((r) => ({ ...r, hasAccess: true }));
  }

  // TODO: Remove LEFT JOINs to make this more efficient
  const data = await dbRead.$queryRaw<
    { availability: Availability; userId: number; entityId: number }[]
  >`
     SELECT
    ${
      entityType === 'ModelVersion'
        ? Prisma.raw(`
      mmv.id as "entityId",
      mmv."userId" as "userId",
      mv."availability" as "availability"
    `)
        : entityType === 'Article'
        ? Prisma.raw(`
      a."id" as "entityId",
      a."userId" as "userId",
      a."availability" as "availability"
    `)
        : entityType === 'Post'
        ? Prisma.raw(`
      p."id" as "entityId",
      p."userId" as "userId",
      p."availability" as "availability"
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
      entityType,
      entityId: d.entityId,
      hasAccess: d.availability === Availability.Public,
    }));
  }

  // TODO: We migth wanna get more improvements here. might not be possible tho.
  const entityAccess = await dbRead.$queryRaw<
    {
      entityId: number;
      entityType: SupportedClubEntities;
      hasAccess: boolean;
    }[]
  >`
    SELECT 
      ea."accessToId" "entityId",
	    ea."accessToType" "entityType",
      COALESCE(c.id, cct.id, ca."clubId", cact."clubId", cmc."clubId", cmt."clubId", u.id) IS NOT NULL as "hasAccess"
    FROM "EntityAccess" ea
    LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id"
    -- User is the owner of the club and the resource is tied to the club as a whole
    LEFT JOIN "Club" c ON ea."accessorType" = 'Club' AND ea."accessorId" = c.id AND c."userId" = ${userId} 
    -- User is the owner of the club and the resource is tied to a club tier
    LEFT JOIN "Club" cct ON ct."clubId" = cct.id AND cct."userId" = ${userId}
    -- User is an admin of the club and resource is tied to the club as a whole:
    LEFT JOIN "ClubAdmin" ca ON ea."accessorType" = 'Club' AND ea."accessorId" = ca."clubId" AND ca."userId" = ${userId}
    -- User is an admin of the club and resource is tied a club tier:
    LEFT JOIN "ClubAdmin" cact  ON ct."clubId" = cact."clubId" AND cact."userId" = ${userId}
    -- User is a member
    LEFT JOIN "ClubMembership" cmc ON ea."accessorType" = 'Club' AND ea."accessorId" = cmc."clubId" AND cmc."userId" = ${userId}
    LEFT JOIN "ClubMembership" cmt ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = cmt."clubTierId" AND cmt."userId" = ${userId}
    -- User access was granted
    LEFT JOIN "User" u ON ea."accessorType" = 'User' AND ea."accessorId" = u.id AND u.id = ${userId}
    WHERE ea."accessToId" IN (${Prisma.join(entityIds, ', ')})
      AND ea."accessToType" = ${entityType}
  `;

  // Complex scenario - we have mixed entities with public/private access.
  return entityIds.map((entityId) => {
    const publicEntityAccess = data.find(
      (entity) => entity.entityId === entityId && entity.availability === Availability.Public
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

  const entitiesAvailability = await client.$queryRaw<
    { availability: Availability; entityId: number }[]
  >`
    SELECT
    ${
      entityType === 'ModelVersion'
        ? Prisma.raw(`
      mmv.id as "entityId",
      mv."availability" as "availability"
    `)
        : entityType === 'Article'
        ? Prisma.raw(`
      a."id" as "entityId",
      a."availability" as "availability"
    `)
        : entityType === 'Post'
        ? Prisma.raw(`
      p."id" as "entityId",
      p."availability" as "availability"
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
  entityType: SupportedClubEntities;
  entityIds: number[];
  userId: number;
}): Promise<{ entityId: number; entityType: SupportedClubEntities; isOwner: boolean }[]> => {
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
