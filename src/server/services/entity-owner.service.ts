import { dbRead } from '~/server/db/client';
import type { dbWrite } from '~/server/db/client';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

/**
 * Who authored an entity, or null when it does not exist. Pass `dbWrite` when the answer gates
 * a write, so a just-created or just-transferred entity is not judged from a lagging replica.
 */
export async function getEntityOwnerId(
  entityType: CosmeticEntity,
  id: number,
  db: typeof dbRead | typeof dbWrite = dbRead
): Promise<number | null> {
  const where = { id };
  const select = { userId: true } as const;
  switch (entityType) {
    case 'Model':
      return (await db.model.findUnique({ where, select }))?.userId ?? null;
    case 'Image':
      return (await db.image.findUnique({ where, select }))?.userId ?? null;
    case 'Post':
      return (await db.post.findUnique({ where, select }))?.userId ?? null;
    case 'Article':
      return (await db.article.findUnique({ where, select }))?.userId ?? null;
    case 'Model3D':
      return (await db.model3D.findUnique({ where, select }))?.userId ?? null;
    default: {
      const unhandled: never = entityType;
      return unhandled;
    }
  }
}
