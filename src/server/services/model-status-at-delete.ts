import type { Prisma } from '@prisma/client';

/**
 * Records the status a model had when it was deleted, so the creator score can tell an owner's delete
 * of a live model from an owner's delete of one a moderator had already taken down
 * (`update-user-score.ts`). Run it before the delete writes `Deleted`. Returns 0 for a model that is
 * already deleted, whose first value is kept.
 */
export function recordStatusAtDelete(tx: Prisma.TransactionClient, modelId: number) {
  // A JSON `null` meta is not an object, and `||` onto it would build an array.
  return tx.$executeRaw`
    UPDATE "Model"
    SET meta = CASE WHEN jsonb_typeof(meta) = 'object' THEN meta ELSE '{}'::jsonb END
      || jsonb_build_object('statusAtDelete', status)
    WHERE id = ${modelId} AND status <> 'Deleted'::"ModelStatus"
  `;
}
