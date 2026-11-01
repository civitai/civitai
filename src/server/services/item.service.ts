import type { Prisma } from '@prisma/client';

export { ITEM_DEFINITION_STATUS, ITEM_TYPE, type ItemType } from '@civitai/shared/mystery-box';

const USER_HOLDER = 'user';

/**
 * Grants one held item to a user. `sourceKey` names what granted it (a purchase claim's transaction
 * id, a prize key, or a moderator grant's `modGrantSourceKey`, which starts with
 * `MOD_GRANT_SOURCE_PREFIX`; the moderator app writes those rows itself) and is unique, so a retried
 * grant throws instead of making a second row.
 */
export function grantItem(
  tx: Prisma.TransactionClient,
  {
    itemDefinitionId,
    userId,
    sourceKey,
  }: { itemDefinitionId: number; userId: number; sourceKey: string }
) {
  return tx.item.create({
    data: { itemDefinitionId, holderType: USER_HOLDER, holderId: userId, sourceKey },
    select: { id: true, itemDefinitionId: true },
  });
}

/**
 * How many of one definition a user holds, summing `quantity`. The Inventory counts rows instead
 * (`countHeldItemsByDefinition`); the two agree while every grant makes one row of 1.
 */
export async function countHeldItems(
  client: Prisma.TransactionClient,
  { itemDefinitionId, userId }: { itemDefinitionId: number; userId: number }
) {
  const { _sum } = await client.item.aggregate({
    where: { holderType: USER_HOLDER, holderId: userId, itemDefinitionId },
    _sum: { quantity: true },
  });
  return _sum.quantity ?? 0;
}

/** Counts rows, not `quantity`: one row is one item to open, as `listHeldItems` lists them. */
export async function countHeldItemsByDefinition(
  client: Prisma.TransactionClient,
  { userId, definition }: { userId: number; definition: Prisma.ItemDefinitionWhereInput }
) {
  const rows = await client.item.groupBy({
    by: ['itemDefinitionId'],
    where: { holderType: USER_HOLDER, holderId: userId, itemDefinition: definition },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.itemDefinitionId, row._count._all]));
}

/**
 * The items a user holds of these definitions, oldest first. It filters by holder only: pass
 * definition ids already checked for type and status.
 */
export function listHeldItems(
  client: Prisma.TransactionClient,
  { userId, itemDefinitionIds }: { userId: number; itemDefinitionIds: number[] }
) {
  return client.item.findMany({
    where: {
      holderType: USER_HOLDER,
      holderId: userId,
      itemDefinitionId: { in: itemDefinitionIds },
    },
    select: { id: true, itemDefinitionId: true, createdAt: true },
    orderBy: { id: 'asc' },
  });
}

/** One held item, with its definition's params, if this user holds it. */
export function findHeldItemById(
  client: Prisma.TransactionClient,
  { id, userId }: { id: bigint; userId: number }
) {
  return client.item.findFirst({
    where: { id, holderType: USER_HOLDER, holderId: userId },
    select: { id: true, itemDefinitionId: true, itemDefinition: { select: { params: true } } },
  });
}

/** The held item a grant with this `sourceKey` made, if this user still holds it. */
export function findHeldItemBySource(
  client: Prisma.TransactionClient,
  { sourceKey, userId }: { sourceKey: string; userId: number }
) {
  return client.item.findFirst({
    where: { sourceKey, holderType: USER_HOLDER, holderId: userId },
    select: { id: true, itemDefinitionId: true },
  });
}
