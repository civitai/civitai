import { Prisma } from '@prisma/client';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/**
 * The purchases one grant row can hold, and what each one grants (see `earlyAccessPurchase`). The
 * amount and currency paid weigh the buyer in the Hot head-start bar, which reads these keys in SQL
 * (migration 20271126120000_model_hot_score_buyer_price_weight).
 */
export const EARLY_ACCESS_PURCHASES = [
  {
    type: 'download',
    transactionKey: 'download-buzzTransactionId',
    purchasedAtKey: 'download-purchasedAt',
    amountKey: 'download-amount',
    buzzTypeKey: 'download-buzzType',
    permissions:
      EntityAccessPermission.EarlyAccessGeneration | EntityAccessPermission.EarlyAccessDownload,
  },
  {
    type: 'generation',
    transactionKey: 'generation-buzzTransactionId',
    purchasedAtKey: 'generation-purchasedAt',
    amountKey: 'generation-amount',
    buzzTypeKey: 'generation-buzzType',
    permissions: EntityAccessPermission.EarlyAccessGeneration,
  },
] as const;

/** Meta key a gift claim records its permissions under, so a refund can leave the gift's bits. */
export const GIFT_PERMISSIONS_KEY = 'gift-permissions';

/** The bits a grant row's recorded purchases pay for. */
export function purchasedPermissions(meta: Record<string, unknown>) {
  return EARLY_ACCESS_PURCHASES.reduce((bits, kind) => {
    const transactionId = meta[kind.transactionKey];
    return typeof transactionId === 'string' && transactionId.length > 0
      ? bits | kind.permissions
      : bits;
  }, 0);
}

/** The bits a gift claim granted on a grant row. A gift row without its recorded bits counts as all. */
export function giftedPermissions(meta: Record<string, unknown>) {
  if (meta.giftLinkId == null) return 0;
  const recorded = meta[GIFT_PERMISSIONS_KEY];
  return typeof recorded === 'number'
    ? recorded
    : EntityAccessPermission.EarlyAccessGeneration | EntityAccessPermission.EarlyAccessDownload;
}

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

/** {@link giftedPermissions} of a row's `meta` column, for a write that must read the row as it is. */
function giftedPermissionsSql(column: string) {
  const meta = asJsonbObjectSql(column);
  return Prisma.sql`(CASE
    WHEN COALESCE(jsonb_typeof(${meta} -> 'giftLinkId'), 'null') = 'null' THEN 0
    WHEN jsonb_typeof(${meta} -> ${GIFT_PERMISSIONS_KEY}::text) = 'number'
      THEN (${meta} ->> ${GIFT_PERMISSIONS_KEY}::text)::numeric::int
    ELSE ${
      EntityAccessPermission.EarlyAccessGeneration | EntityAccessPermission.EarlyAccessDownload
    }::int
  END)`;
}

/**
 * Takes back refunded purchases. With `narrow`, only those bits and meta keys go and the row stays
 * for what is kept (an older purchase or a gift); without it, the whole grant goes. A gift's bits
 * are never taken: they are read from the row when it is written. Neither throws on a row that is
 * already gone.
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
         SET "permissions" = "permissions"
               & ~(${narrow.revokePermissions}::int & ~${giftedPermissionsSql('"meta"')}),
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

/** Purchase and gift keys a moderator revoke moves into a `revocations` entry. */
const ARCHIVED_ON_REVOKE_KEYS = [
  ...EARLY_ACCESS_PURCHASES.flatMap(({ transactionKey, purchasedAtKey }) => [
    transactionKey,
    purchasedAtKey,
  ]),
  'giftLinkId',
  GIFT_PERMISSIONS_KEY,
];

/** Meta key holding a grant's moderator revokes, oldest first. */
export const REVOCATIONS_KEY = 'revocations';

/**
 * A moderator's revoke, for a purchase refunded outside the unpublish refund. The row stays with no
 * permissions, as the record of what was paid: its purchase and gift keys move into a new entry of
 * `revocations`, with who revoked it and when. The unpublish refund reads only the live keys, so it
 * can't refund it again, and a later purchase starts a fresh refund window. A grant from before
 * permissions were recorded (0, no `revocations`) still counts as access, so it is revoked too.
 * Returns the grant as it was, or null when there was none to revoke.
 */
export async function archiveModelVersionAccess({
  client = dbWrite,
  userId,
  modelVersionId,
  revokedById,
}: {
  client?: Prisma.TransactionClient;
  userId: number;
  modelVersionId: number;
  revokedById: number;
}) {
  const meta = asJsonbObjectSql('ea."meta"');
  const [before] = await client.$queryRaw<{ permissions: number; meta: unknown }[]>`
    WITH before AS (
      SELECT permissions, meta FROM "EntityAccess" ea
       WHERE "accessToId" = ${modelVersionId} AND "accessToType" = 'ModelVersion'
         AND "accessorId" = ${userId} AND "accessorType" = 'User'
         AND (permissions <> 0 OR NOT (${meta} ? ${REVOCATIONS_KEY}::text))
       FOR UPDATE
    )
    UPDATE "EntityAccess" ea
       SET permissions = 0,
           meta = (${meta} - ${ARCHIVED_ON_REVOKE_KEYS}::text[]) || jsonb_build_object(
             ${REVOCATIONS_KEY}::text,
             (CASE WHEN jsonb_typeof(${meta} -> ${REVOCATIONS_KEY}::text) = 'array'
                   THEN ${meta} -> ${REVOCATIONS_KEY}::text ELSE '[]'::jsonb END)
             || jsonb_build_array(
                  (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                     FROM jsonb_each(${meta}) e
                    WHERE e.key = ANY(${ARCHIVED_ON_REVOKE_KEYS}::text[]))
                  || jsonb_build_object(
                       'revokedAt', now(),
                       'revokedById', ${revokedById}::int,
                       'refundedExternally', true
                     )
                )
           )
      FROM before
     WHERE ea."accessToId" = ${modelVersionId} AND ea."accessToType" = 'ModelVersion'
       AND ea."accessorId" = ${userId} AND ea."accessorType" = 'User'
    RETURNING before.permissions, before.meta
  `;
  return before ?? null;
}
