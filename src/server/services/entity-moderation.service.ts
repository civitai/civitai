import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { XGuardModerationOutput } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

export function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export async function upsertEntityModerationPending({
  entityType,
  entityId,
  workflowId,
  contentHash,
}: {
  entityType: string;
  entityId: number;
  workflowId: string;
  contentHash?: string;
}) {
  return dbWrite.entityModeration.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: {
      entityType,
      entityId,
      workflowId,
      contentHash,
      status: EntityModerationStatus.Pending,
    },
    update: {
      workflowId,
      contentHash,
      status: EntityModerationStatus.Pending,
      blocked: null,
      triggeredLabels: [],
      result: Prisma.JsonNull,
    },
  });
}

/**
 * Records a successful moderation result. Only updates the row if the stored
 * `workflowId` still matches the callback's workflowId — this prevents a late
 * callback from a stale workflow from clobbering a newer in-flight workflow.
 * Returns `true` if the row was updated, `false` if the callback was stale.
 */
export async function recordEntityModerationSuccess({
  entityType,
  entityId,
  workflowId,
  output,
}: {
  entityType: string;
  entityId: number;
  workflowId: string;
  output: XGuardModerationOutput;
}) {
  const { blocked, triggeredLabels } = output;
  const result = await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId },
    data: {
      status: EntityModerationStatus.Succeeded,
      blocked,
      triggeredLabels,
      result: output as unknown as object,
    },
  });
  return result.count > 0;
}

/**
 * Records a non-success terminal state (Failed/Expired/Canceled). Only updates
 * if the stored `workflowId` matches — see `recordEntityModerationSuccess`.
 * Returns `true` if the row was updated, `false` if the callback was stale.
 */
export async function recordEntityModerationFailure({
  entityType,
  entityId,
  workflowId,
  status,
}: {
  entityType: string;
  entityId: number;
  workflowId: string;
  status: Exclude<EntityModerationStatus, 'Pending' | 'Succeeded'>;
}) {
  const result = await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId },
    data: {
      status,
      retryCount: { increment: 1 },
    },
  });
  return result.count > 0;
}

/**
 * Bulk-resolves the current text content for a set of entities of a given type.
 * Returns a Map keyed by entityId. Entities that no longer exist will be absent
 * from the map. Throws if the entityType is unknown.
 */
type BulkContentResolver = (ids: number[]) => Promise<Map<number, string>>;

const bulkContentResolvers: Record<string, BulkContentResolver> = {
  Article: async (ids) => {
    const rows = await dbRead.article.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true },
    });
    return new Map(rows.map((r) => [r.id, r.content]));
  },
};

export function getSupportedModerationEntityTypes() {
  return Object.keys(bulkContentResolvers);
}

export async function resolveEntityContentBulk({
  entityType,
  entityIds,
}: {
  entityType: string;
  entityIds: number[];
}): Promise<Map<number, string>> {
  const resolver = bulkContentResolvers[entityType];
  if (!resolver) throw new Error(`No content resolver for entityType: ${entityType}`);
  if (!entityIds.length) return new Map();
  return resolver(entityIds);
}

/**
 * Returns the entity's text moderation row joined with the max nsfwLevel
 * derived from connected images via ImageConnection.
 */
export async function getEntityModerationWithImageNsfwLevel({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) {
  const rows = await dbRead.$queryRaw<
    Array<{
      id: number;
      entityType: string;
      entityId: number;
      workflowId: string | null;
      status: EntityModerationStatus;
      retryCount: number;
      blocked: boolean | null;
      triggeredLabels: string[];
      result: unknown;
      contentHash: string | null;
      createdAt: Date;
      updatedAt: Date;
      imageNsfwLevel: number | null;
    }>
  >`
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
  `;
  return rows[0] ?? null;
}
