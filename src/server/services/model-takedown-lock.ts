import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';

/**
 * How a publish reads a model or version's takedown status. `share` for a publish that only reads
 * the rows (a post onto the version); `update` for one that writes them next, since two share
 * holders that both upgrade to a write deadlock; `false` for a plain read.
 */
export type TakedownLock = 'share' | 'update' | false;

const lockSql = (lock: TakedownLock) =>
  lock === 'share'
    ? Prisma.sql`FOR SHARE`
    : lock === 'update'
    ? Prisma.sql`FOR NO KEY UPDATE`
    : Prisma.empty;

const downedSql = Prisma.sql`status::text IN (${Prisma.join(constants.modPublishOnlyStatuses)})`;

/**
 * Whether a moderator took this model down. With a lock, call it in the publish's transaction: a
 * takedown already in flight is waited for and seen, and one that starts later waits for the
 * publish to commit, then its own cascade takes the published rows down.
 */
export async function readDownedModel(
  tx: Prisma.TransactionClient,
  modelId: number,
  lock: TakedownLock
) {
  const [row] = await tx.$queryRaw<{ downed: boolean }[]>`
    SELECT ${downedSql} AS downed FROM "Model" WHERE id = ${modelId} ${lockSql(lock)}
  `;
  return !!row?.downed;
}

/**
 * Whether this version or its model is taken down, as readDownedModel. The model is locked first, in
 * the order a model takedown and publishModelById take them.
 */
export async function readDownedVersion(
  tx: Prisma.TransactionClient,
  modelVersionId: number,
  lock: TakedownLock
) {
  const [model] = await tx.$queryRaw<{ downed: boolean }[]>`
    SELECT ${downedSql} AS downed
    FROM "Model" WHERE id = (SELECT "modelId" FROM "ModelVersion" WHERE id = ${modelVersionId})
    ${lockSql(lock)}
  `;
  const [version] = await tx.$queryRaw<{ downed: boolean }[]>`
    SELECT ${downedSql} AS downed
    FROM "ModelVersion" WHERE id = ${modelVersionId}
    ${lockSql(lock)}
  `;
  return !!model?.downed || !!version?.downed;
}
