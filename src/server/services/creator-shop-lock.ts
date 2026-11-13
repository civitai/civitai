import type { Prisma } from '@prisma/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Locks a shop item's row for the rest of the transaction and reads it. `meta` is written back
 * whole, so building it from any earlier read would erase an edit, verdict or refund entry committed
 * since. NO KEY: still serialises with those writes, without holding up a purchase's foreign-key
 * insert.
 */
export const lockShopItem = async (tx: Prisma.TransactionClient, id: number) => {
  await tx.$queryRaw`SELECT id FROM "CosmeticShopItem" WHERE id = ${id} FOR NO KEY UPDATE`;
  const item = await tx.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      status: true,
      meta: true,
      unitAmount: true,
      rejectionReason: true,
      // Prior values, so an editor can record what it moved from.
      title: true,
      description: true,
      availableQuantity: true,
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  return item;
};
