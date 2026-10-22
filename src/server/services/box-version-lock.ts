import type { Prisma } from '@prisma/client';

const BOX_LOCK_TIMEOUT = '3s';

/**
 * Locks a box's `ItemDefinition` row for a write that changes what it draws. FOR NO KEY UPDATE waits
 * for every open in flight (each reads this row FOR SHARE), so no open draws across the change. Never
 * take the item-holder lock after it: opens take that lock before this row. The wait is bounded
 * because Prisma's transaction timeout doesn't cancel a waiting statement; it stays set to commit.
 */
export async function lockBox(tx: Prisma.TransactionClient, boxId: number) {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${BOX_LOCK_TIMEOUT}, true)`;
  const [box] = await tx.$queryRaw<{ status: string; version: number; updatedAt: Date }[]>`
    SELECT status, version, "updatedAt" FROM "ItemDefinition" WHERE id = ${boxId}
    FOR NO KEY UPDATE`;
  return box;
}
