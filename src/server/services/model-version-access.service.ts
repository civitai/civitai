import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/**
 * The one writer of a user's grant to a model version (a purchase or a gift claim). A single
 * statement that merges in the database: permissions are OR-ed and `meta` keys merged into the
 * stored row, so a concurrent purchase and gift claim can't drop each other's
 * `*-buzzTransactionId`, which the early-access refund reads.
 */
export async function grantModelVersionAccess({
  client = dbWrite,
  userId,
  modelVersionId,
  permissions,
  meta,
  addedById,
}: {
  client?: Prisma.TransactionClient;
  userId: number;
  modelVersionId: number;
  permissions: number;
  meta: Record<string, string | number>;
  addedById: number;
}) {
  const metaJson = JSON.stringify(meta);
  await client.$executeRaw`
    INSERT INTO "EntityAccess"
      ("accessToId", "accessToType", "accessorId", "accessorType", "permissions", "meta", "addedById")
    VALUES
      (${modelVersionId}, 'ModelVersion', ${userId}, 'User', ${permissions}, ${metaJson}::jsonb, ${addedById})
    ON CONFLICT ("accessToId", "accessToType", "accessorId", "accessorType") DO UPDATE SET
      "permissions" = "EntityAccess"."permissions" | EXCLUDED."permissions",
      "meta" = ${asJsonbObjectSql('"EntityAccess"."meta"')} || EXCLUDED."meta"
  `;
}

/** The permissions a user already holds on a model version, from the primary. 0 when none. */
export async function getModelVersionAccessPermissions(
  userId: number,
  modelVersionId: number,
  client: Prisma.TransactionClient = dbWrite
) {
  const row = await client.entityAccess.findUnique({
    where: {
      accessToId_accessToType_accessorId_accessorType: {
        accessToId: modelVersionId,
        accessToType: 'ModelVersion',
        accessorId: userId,
        accessorType: 'User',
      },
    },
    select: { permissions: true },
  });
  return row?.permissions ?? 0;
}
