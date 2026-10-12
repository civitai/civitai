import type { Prisma } from '@prisma/client';

/**
 * Records the status a model had when it was deleted, so the creator score can tell an owner's delete
 * of a live model from an owner's delete of one a moderator had already taken down
 * (`update-user-score.ts`). Run it before the delete writes `Deleted`; a second delete of an
 * already-deleted model keeps the first one's value.
 */
export function recordStatusAtDelete(tx: Prisma.TransactionClient, modelId: number) {
  return tx.$executeRaw`
    UPDATE "Model"
    SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('statusAtDelete', status)
    WHERE id = ${modelId} AND status <> 'Deleted'::"ModelStatus"
  `;
}
