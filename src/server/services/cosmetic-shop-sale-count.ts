import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

type RawWriter = Pick<Prisma.TransactionClient, '$executeRaw'>;

const metaObject = Prisma.sql`CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END`;

const SALE_COUNT_LOCK_TIMEOUT = '2s';

/**
 * Adds one sale to `meta.purchases` atomically in SQL. Writing back the `meta` the purchase loaded
 * would overwrite concurrent changes to the row.
 */
export async function countShopItemSale(tx: Prisma.TransactionClient, shopItemId: number) {
  await tx.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET "meta" = jsonb_set(
      ${metaObject},
      '{purchases}',
      to_jsonb(
        CASE WHEN jsonb_typeof("meta"->'purchases') = 'number'
          THEN ("meta"->>'purchases')::numeric
          ELSE 0
        END + 1
      )
    )
    WHERE "id" = ${shopItemId}::int
  `;
}

/**
 * Counts a sale after its grant commits, never inside it: every buyer of a listing updates the same
 * row, and queuing on it under `lockItemHolder` pushed paid grants into the transaction timeout and a
 * refund. Waits at most `SALE_COUNT_LOCK_TIMEOUT`; a failure is logged, not thrown, because stock
 * reads the purchase rows, not this counter.
 */
export async function countShopItemSaleAfterGrant(
  shopItemId: number,
  db: Pick<typeof dbWrite, '$transaction'> = dbWrite
) {
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${SALE_COUNT_LOCK_TIMEOUT}, true)`;
      await countShopItemSale(tx, shopItemId);
    });
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'shop-sale-count',
      message: 'Sale granted but not counted on the listing',
      shopItemId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/** Sets `meta.purchases` to a counted total, leaving the other `meta` keys as the row has them. */
export async function setShopItemSaleCount(db: RawWriter, shopItemId: number, purchases: number) {
  await db.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET "meta" = jsonb_set(${metaObject}, '{purchases}', to_jsonb(${purchases}::int))
    WHERE "id" = ${shopItemId}::int
  `;
}
