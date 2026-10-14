import { eventDecorationEntityCaches } from '~/server/redis/caches';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

// Event cosmetics render from their own cache, which also caches misses for an hour, so every
// entity whose decoration changed must be refreshed or it keeps showing the old one.
export async function refreshEventDecorations(
  entities: { entityType: CosmeticEntity; entityId: number }[]
) {
  const byType = new Map<CosmeticEntity, number[]>();
  for (const { entityType, entityId } of entities) {
    const ids = byType.get(entityType) ?? [];
    ids.push(entityId);
    byType.set(entityType, ids);
  }
  for (const [entityType, ids] of byType) {
    for (let i = 0; i < ids.length; i += 1000)
      await eventDecorationEntityCaches[entityType].refresh(ids.slice(i, i + 1000));
  }
}
