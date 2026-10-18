import type { Prisma } from '@prisma/client';

/**
 * Adds one sale to a listing's `meta.purchases`, counting from the row as it is now and leaving
 * every other `meta` key alone. Call it inside the grant transaction, after `lockItemHolder`.
 */
export async function countShopItemSale(tx: Prisma.TransactionClient, shopItemId: number) {
  await tx.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET "meta" = jsonb_set(
      CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END,
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
