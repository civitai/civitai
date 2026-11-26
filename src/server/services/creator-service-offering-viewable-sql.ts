import { Prisma } from '@prisma/client';

/**
 * True in SQL when the service offering whose id is `offeringId` is one a visitor may open: Active, its
 * seller not banned, deleted or muted, and their shop enabled (an unset shop setting is off). The
 * offering page reads the same terms through Prisma; no-divergent-viewable-service-offering pins the
 * two together.
 */
export const viewableServiceOfferingSql = (offeringId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "ServiceOffering" vo
  JOIN "User" vs ON vs."id" = vo."sellerId"
  WHERE vo."id" = ${offeringId}
    AND vo."status" = 'Active'::"ServiceOfferingStatus"
    AND vs."bannedAt" IS NULL
    AND vs."deletedAt" IS NULL
    AND NOT vs."muted"
    AND vs."settings" -> 'creatorShop' -> 'enabled' = 'true'::jsonb
)`;
