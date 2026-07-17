import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// EntityModeration.status, derived from the schema so this module needs no separate enum import.
type EntityModerationStatusValue = Selectable<DB['EntityModeration']>['status'];
// The non-success terminal states recordEntityModerationFailure accepts (Failed / Expired / Canceled).
type EntityModerationFailureStatus = Exclude<EntityModerationStatusValue, 'Pending' | 'Succeeded'>;

// The row shape getEntityModerationWithImageNsfwLevel returns — the EntityModeration columns plus the
// derived max nsfwLevel of the entity's connected images.
export type EntityModerationWithImageNsfwLevel = {
  id: number;
  entityType: string;
  entityId: number;
  workflowId: string | null;
  status: EntityModerationStatusValue;
  retryCount: number;
  blocked: boolean | null;
  triggeredLabels: string[];
  result: unknown;
  contentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  imageNsfwLevel: number | null;
};

// Upsert the pending moderation row for an entity, keyed on the (entityType, entityId) unique. On insert it
// seeds a fresh Pending row; on conflict it RESETS the row to Pending for the new workflow — clearing the
// previous verdict (blocked/triggeredLabels/result). `updatedAt` is set explicitly on both paths — the
// @updatedAt plugin only rewrites plain UPDATEs, not an INSERT or its `ON CONFLICT DO UPDATE`. `result` is
// reset to jsonb `null` (Prisma.JsonNull), not SQL NULL.
export function upsertEntityModerationPending(
  db: Kysely<DB>,
  {
    entityType,
    entityId,
    workflowId,
    contentHash,
  }: {
    entityType: string;
    entityId: number;
    workflowId: string | null;
    contentHash?: string;
  }
) {
  const now = new Date();
  return db
    .insertInto('EntityModeration')
    .values({
      entityType,
      entityId,
      workflowId,
      contentHash: contentHash ?? null,
      status: 'Pending',
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['entityType', 'entityId']).doUpdateSet({
        workflowId,
        contentHash: contentHash ?? null,
        status: 'Pending',
        blocked: null,
        triggeredLabels: [],
        result: sql`'null'::jsonb`,
        updatedAt: now,
      })
    )
    .returningAll()
    .executeTakeFirst();
}

// Record a successful moderation verdict. Guarded on the stored workflowId still matching the callback's, so
// a late callback from a superseded workflow can't clobber a newer in-flight one. Returns true iff a row was
// updated (the callback was current). The `result` jsonb (the caller's slimmed output) is bound via toJson.
// `updatedAt` is auto-stamped by the @updatedAt plugin.
export async function recordEntityModerationSuccess(
  db: Kysely<DB>,
  {
    entityType,
    entityId,
    workflowId,
    blocked,
    triggeredLabels,
    result,
  }: {
    entityType: string;
    entityId: number;
    workflowId: string;
    blocked: boolean;
    triggeredLabels: string[];
    result: unknown;
  }
) {
  const res = await db
    .updateTable('EntityModeration')
    .set({
      status: 'Succeeded',
      blocked,
      triggeredLabels,
      result: toJson(result),
    })
    .where('entityType', '=', entityType)
    .where('entityId', '=', entityId)
    .where('workflowId', '=', workflowId)
    .executeTakeFirst();
  return (res?.numUpdatedRows ?? BigInt(0)) > BigInt(0);
}

// Record a non-success terminal state (Failed / Expired / Canceled) and bump retryCount. Same stale-workflow
// guard as recordEntityModerationSuccess; returns true iff a row was updated. `updatedAt` auto-stamped by the
// plugin.
export async function recordEntityModerationFailure(
  db: Kysely<DB>,
  {
    entityType,
    entityId,
    workflowId,
    status,
  }: {
    entityType: string;
    entityId: number;
    workflowId: string;
    status: EntityModerationFailureStatus;
  }
) {
  const res = await db
    .updateTable('EntityModeration')
    .set({
      status,
      retryCount: sql`"retryCount" + 1`,
    })
    .where('entityType', '=', entityType)
    .where('entityId', '=', entityId)
    .where('workflowId', '=', workflowId)
    .executeTakeFirst();
  return (res?.numUpdatedRows ?? BigInt(0)) > BigInt(0);
}

// The entity's moderation row joined with the max nsfwLevel of its connected images (via ImageConnection).
// Preserves the source raw query exactly — `em.*` + `COALESCE(MAX(i."nsfwLevel"), 0)`, grouped by em.id.
export async function getEntityModerationWithImageNsfwLevel(
  db: Kysely<DB>,
  { entityType, entityId }: { entityType: string; entityId: number }
): Promise<EntityModerationWithImageNsfwLevel | null> {
  const result = await sql<EntityModerationWithImageNsfwLevel>`
    SELECT
      em.*,
      COALESCE(MAX(i."nsfwLevel"), 0) AS "imageNsfwLevel"
    FROM "EntityModeration" em
    LEFT JOIN "ImageConnection" ic
      ON ic."entityType" = em."entityType" AND ic."entityId" = em."entityId"
    LEFT JOIN "Image" i ON i.id = ic."imageId"
    WHERE em."entityType" = ${entityType} AND em."entityId" = ${entityId}
    GROUP BY em.id
    LIMIT 1
  `.execute(db);
  return result.rows[0] ?? null;
}
