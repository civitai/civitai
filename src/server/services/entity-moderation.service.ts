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
  return dbWrite.entityModeration.update({
    where: { entityType_entityId: { entityType, entityId } },
    data: {
      workflowId,
      status: EntityModerationStatus.Succeeded,
      blocked,
      triggeredLabels,
      result: output as unknown as object,
    },
  });
}

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
  return dbWrite.entityModeration.update({
    where: { entityType_entityId: { entityType, entityId } },
    data: {
      workflowId,
      status,
      retryCount: { increment: 1 },
    },
  });
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
