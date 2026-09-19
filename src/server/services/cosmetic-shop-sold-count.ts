import { dbRead } from '~/server/db/client';

/**
 * Sold counts for exactly the listed shop items, from the purchase rows.
 *
 * Prisma's relation `_count` aggregates the WHOLE purchases table once per query and
 * joins the result, so its cost grows with the table rather than with the page. This
 * is restricted to the ids asked for, which is what lets
 * `UserCosmeticShopPurchases_shopItemId_idx` turn it into an index-only lookup.
 * `= ANY(array)` rather than `IN (...)` keeps one statement shape for every page size.
 *
 * Items with no purchases are absent from the map; read them as 0.
 */
export async function getSoldCounts(shopItemIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(shopItemIds)];
  if (!ids.length) return new Map();
  const rows = await dbRead.$queryRaw<{ shopItemId: number; sold: number }[]>`
    SELECT "shopItemId", COUNT(*)::int AS sold
    FROM "UserCosmeticShopPurchases"
    WHERE "shopItemId" = ANY(${ids}::int[])
    GROUP BY "shopItemId"
  `;
  return new Map(rows.map((r) => [r.shopItemId, r.sold]));
}

/**
 * For the editor reads, which hand back the whole `meta` rather than the display
 * list. They read `meta.purchases`, so the row count has to land on that key or
 * an editor shows the drifting counter while every buyer surface shows rows.
 * Buyer surfaces go through `shopItemDisplayMeta` instead, never this.
 */
export const withSoldCount = <T extends { meta: unknown }>(item: T, sold: number) => ({
  ...item,
  meta: { ...((item.meta ?? {}) as Record<string, unknown>), purchases: sold },
});

export async function withSoldCounts<T extends { id: number; meta: unknown }>(items: T[]) {
  const sold = await getSoldCounts(items.map((i) => i.id));
  return items.map((item) => withSoldCount(item, sold.get(item.id) ?? 0));
}
