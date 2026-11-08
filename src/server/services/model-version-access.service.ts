import { Prisma } from '@prisma/client';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/** The purchases one grant row can hold, and what each one grants (see `earlyAccessPurchase`). */
export const EARLY_ACCESS_PURCHASES = [
  {
    transactionKey: 'download-buzzTransactionId',
    purchasedAtKey: 'download-purchasedAt',
    permissions:
      EntityAccessPermission.EarlyAccessGeneration | EntityAccessPermission.EarlyAccessDownload,
  },
  {
    transactionKey: 'generation-buzzTransactionId',
    purchasedAtKey: 'generation-purchasedAt',
    permissions: EntityAccessPermission.EarlyAccessGeneration,
  },
] as const;

/** Meta key a gift claim records its permissions under, so a refund can leave the gift's bits. */
export const GIFT_PERMISSIONS_KEY = 'gift-permissions';

/**
 * The one writer of a user's grant to a model version (a purchase or a gift claim). A single
 * statement that merges in the database: permissions are OR-ed and `meta` keys merged into the
 * stored row, so a concurrent purchase and gift claim can't drop each other's
 * `*-buzzTransactionId`, which the early-access refund reads.
 */
const PURCHASE_KEYS = Prisma.raw(
  `array[${EARLY_ACCESS_PURCHASES.map(({ transactionKey }) => `'${transactionKey}'`).join(', ')}]`
);

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
      "meta" = ${asJsonbObjectSql('"EntityAccess"."meta"')} || EXCLUDED."meta",
      -- The refund window runs from addedAt: a first purchase on a row a gift created starts it.
      "addedAt" = CASE
        WHEN EXCLUDED."meta" ?| ${PURCHASE_KEYS}
          AND NOT (${asJsonbObjectSql('"EntityAccess"."meta"')} ?| ${PURCHASE_KEYS})
        THEN now()
        ELSE "EntityAccess"."addedAt"
      END
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

/**
 * Takes back refunded purchases. With `narrow`, only those bits and meta keys go and the row stays
 * for what is kept (an older purchase or a gift); without it, the whole grant goes. Neither throws
 * on a row that is already gone.
 */
export async function revokeModelVersionAccess({
  userId,
  modelVersionId,
  narrow,
}: {
  userId: number;
  modelVersionId: number;
  narrow?: { revokePermissions: number; removeKeys: string[] };
}) {
  if (narrow) {
    await dbWrite.$executeRaw`
      UPDATE "EntityAccess"
         SET "permissions" = "permissions" & ~${narrow.revokePermissions}::int,
             "meta" = ${asJsonbObjectSql('"meta"')} - ${narrow.removeKeys}::text[]
       WHERE "accessToId" = ${modelVersionId} AND "accessToType" = 'ModelVersion'
         AND "accessorId" = ${userId} AND "accessorType" = 'User'`;
    return;
  }
  await dbWrite.entityAccess.deleteMany({
    where: {
      accessToId: modelVersionId,
      accessToType: 'ModelVersion',
      accessorId: userId,
      accessorType: 'User',
    },
  });
}
