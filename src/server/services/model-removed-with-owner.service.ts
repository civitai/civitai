import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  KEPT_MODEL_STATUS,
  REMOVED_WITH_OWNER_META_KEYS,
  withoutRemovedWithOwner,
} from '~/server/utils/legal-hold';

/**
 * The meta a content wipe writes on a model it keeps: its status before, and the versions
 * it took down with the status each had. A moderator's restore puts back exactly those.
 */
export type RemovedWithOwnerMeta = {
  removedWithOwner?: boolean;
  statusBeforeRemoval?: string;
  versionsUnpublishedByRemoval?: { id: number; status: string }[];
};

export { REMOVED_WITH_OWNER_META_KEYS, withoutRemovedWithOwner };

/**
 * Returns a model a content wipe kept to the status it had, and the versions the wipe took down to
 * theirs; a version it found already unpublished stays so. Clears the wipe's meta, which on a model
 * the wipe kept in place (a draft) is all a restore does. Null when the model carries no complete
 * record, or has moved since the wipe.
 */
export async function restoreModelRemovedWithOwner(
  modelId: number
): Promise<{ status: string; userId: number; versionIds: number[] } | null> {
  const [restored] = await dbWrite.$queryRaw<
    { status: string; userId: number; versionIds: number[] }[]
  >`
    WITH hidden AS (
      SELECT id, meta FROM "Model"
      WHERE id = ${modelId}
        AND meta ->> 'removedWithOwner' = 'true' AND meta ->> 'statusBeforeRemoval' IS NOT NULL
        AND (status = ${Prisma.raw(`'${KEPT_MODEL_STATUS}'`)}
          OR status::text = meta ->> 'statusBeforeRemoval')
      FOR UPDATE
    ), model AS (
      UPDATE "Model" m
      SET status = (h.meta ->> 'statusBeforeRemoval')::"ModelStatus",
          meta = m.meta - 'removedWithOwner' - 'statusBeforeRemoval' - 'versionsUnpublishedByRemoval'
      FROM hidden h
      WHERE m.id = h.id
      RETURNING m.status, m."userId"
    ), versions AS (
      UPDATE "ModelVersion" mv
      SET status = (taken ->> 'status')::"ModelStatus"
      FROM hidden h, jsonb_array_elements(h.meta -> 'versionsUnpublishedByRemoval') taken
      WHERE mv."modelId" = h.id AND mv.id = (taken ->> 'id')::int AND mv.status = 'Unpublished'
      RETURNING mv.id
    )
    SELECT model.status::text AS status, model."userId",
           COALESCE((SELECT array_agg(id ORDER BY id) FROM versions), '{}') AS "versionIds"
    FROM model`;
  return restored ?? null;
}
