import type { Prisma } from '@prisma/client';

/** `ItemDefinition.type` values. Text + CHECK in the database; a new type is a migration and a grant handler. */
export const ITEM_TYPE = { cosmetic: 'cosmetic', box: 'box' } as const;
export type ItemType = (typeof ITEM_TYPE)[keyof typeof ITEM_TYPE];

/** `ItemDefinition.status` values. */
export const ITEM_DEFINITION_STATUS = {
  draft: 'draft',
  published: 'published',
  archived: 'archived',
} as const;

const USER_HOLDER = 'user';

/**
 * Grants one held item to a user. `sourceKey` names what granted it (a purchase claim's transaction
 * id, a prize key) and is unique, so a retried grant throws instead of making a second row.
 */
export function grantItem(
  tx: Prisma.TransactionClient,
  { itemDefinitionId, userId, sourceKey }: { itemDefinitionId: number; userId: number; sourceKey: string }
) {
  return tx.item.create({
    data: { itemDefinitionId, holderType: USER_HOLDER, holderId: userId, sourceKey },
    select: { id: true, itemDefinitionId: true },
  });
}

/** How many of one definition a user holds. */
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
