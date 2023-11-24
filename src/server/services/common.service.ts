import { dbRead } from '~/server/db/client';
import { Availability, Prisma } from '@prisma/client';
import { SupportedClubEntities } from '~/server/schema/club.schema';

const entityAccessOwnerTypes = ['User', 'Club', 'ClubTier'] as const;
type EntityAccessOwnerType = (typeof entityAccessOwnerTypes)[number];

type UserEntityAccessStatus = {
  accessToId: number;
  accessToType: SupportedClubEntities;
  hasAccess: boolean;
};

export const hasEntityAccess = async ({
  entityType,
  entityId,
  userId,
  isModerator,
}: {
  entityType: SupportedClubEntities;
  entityId: number;
  userId?: number;
  isModerator?: boolean;
}): UserEntityAccessStatus => {
  if (isModerator) {
    return {
      accessToId: entityId,
      accessToType: entityType,
      hasAccess: true,
    };
  }

  const [record] = await dbRead.$queryRaw<{ availability: Availability; userId: number }[]>`
    SELECT
        "availability",
        "userId"
    FROM "${entityType}" t
    WHERE t.id = ${entityId}
  `;

  // Owners always have access.
  if (userId && record.userId === userId) {
    return true;
  }

  // All public stuff is accessible by everyone.
  if (record.availability !== Availability.Private) {
    // Covers undefined just in case.
    return true;
  }

  if (!userId) {
    return false;
  }

  const entityAccesses = await dbRead.$queryRaw<
    {
      accessToId: number;
      accessToType: SupportedClubEntities;
      accessorId: number;
      accessorType: EntityAccessOwnerType;
    }[]
  >`
    SELECT * 
    FROM "EntityAccess" ea
    WHERE ea."accessToId" = ${entityId}
      AND ea."accessToType" = ${entityType} 
  `;

  if (!entityAccesses.length) {
    return false;
  }

  const accessors = await dbRead.$queryRaw<
    {
      accessToId: number;
      accessToType: SupportedClubEntities;
      hasAccess: boolean;
    }[]
  >`
    SELECT 
      COALESCE(c.id IS NOT NULL, cmc."clubId" IS NOT NULL, cmt."clubId" IS NOT NULL, u.id IS NOT NULL, false) as "hasAccess",
    FROM "EntityAccess" ea
    JOIN "Club" c ON ea."accessorType" = "Club" AND ea."accessorId" = c.id AND c.userId = ${userId} 
    JOIN "ClubMembership" cmc ON ea."accessorType" = "Club" AND ea."accessorId" = cmc."clubId" AND cm.userId = ${userId}
    JOIN "ClubMembership" cmt ON ea."accessorType" = "ClubTier" AND ea."accessorId" = cmt."clubTierId" AND cmt.userId = ${userId}
    JOIN "User" u ON ea."accessorType" = "User" AND ea."accessorId" = u.id AND u.id = ${userId}
    WHERE ea."accessToId" = ${entityId}
      AND ea."accessToType" = ${entityType}
  `;
};
