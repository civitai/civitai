import { Prisma } from '@prisma/client';

type RawWriter = Pick<Prisma.TransactionClient, '$executeRaw'>;

const metaObject = Prisma.sql`CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END`;

/**
 * Adds one sale to `meta.purchases` atomically in SQL. Writing back the `meta` the purchase loaded
 * would overwrite concurrent changes to the row. Call it on the grant transaction, after
 * `lockItemHolder`: a write on `dbWrite` takes a second pooled connection while the buyer's lock is held.
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

/** Sets `meta.purchases` to a counted total, leaving the other `meta` keys as the row has them. */
export async function setShopItemSaleCount(db: RawWriter, shopItemId: number, purchases: number) {
  await db.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET "meta" = jsonb_set(${metaObject}, '{purchases}', to_jsonb(${purchases}::int))
    WHERE "id" = ${shopItemId}::int
  `;
}
