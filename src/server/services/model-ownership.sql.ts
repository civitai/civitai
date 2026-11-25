import { Prisma } from '@prisma/client';

export type ModelOwnershipReason = 'create' | 'transfer' | 'account-delete' | 'restore';

/**
 * Records `userId` as an owner of every model `where` matches (over `"Model" m`). Run it in the same
 * transaction as the owner write: `restoreUser` reads it to find the models an account handed to the
 * placeholder owner.
 */
export function recordModelOwnershipSql({
  where,
  userId,
  reason,
  actorId = null,
}: {
  where: Prisma.Sql;
  userId: number;
  reason: ModelOwnershipReason;
  actorId?: number | null;
}): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "ModelOwnership" ("modelId", "userId", "reason", "actorId")
    SELECT m.id, ${userId}::int, ${reason}, ${actorId}::int FROM "Model" m WHERE ${where}
  `;
}

/**
 * Records the current owner of every model `where` matches (over `"Model" m`) that has no row for that
 * owner yet, as a baseline for a model created before its history began. Run before the owner write.
 */
export function recordCurrentModelOwnersSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "ModelOwnership" ("modelId", "userId", "reason")
    SELECT m.id, m."userId", 'baseline' FROM "Model" m
    WHERE ${where}
      AND NOT EXISTS (
        SELECT 1 FROM "ModelOwnership" o WHERE o."modelId" = m.id AND o."userId" = m."userId"
      )
  `;
}
