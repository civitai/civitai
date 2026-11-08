import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { ownerHeld, ownerHeldSql } from '~/server/services/legal-hold.service';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
import { trainingDataVisibility } from '~/shared/utils/training-data-visibility';

/** The owner's dataset-sharing choice, stored on the `Training Data` file's metadata. */
export type TrainingDataShare = { ownRights: boolean; shareDataset: boolean };

/** Sharing needs the rights: a share without them is stored as not shared. */
export function normalizeTrainingDataShare(share: Partial<TrainingDataShare>): TrainingDataShare {
  const ownRights = share.ownRights === true;
  return { ownRights, shareDataset: ownRights && share.shareDataset === true };
}

/** The choice a publish entry carries as `ownRights=1&shareDataset=1`; undefined when it carries
 *  none, so an entry that never asked leaves a stored choice alone. */
export function trainingDataShareFromQuery(
  query: Partial<Record<string, string | string[]>>
): TrainingDataShare | undefined {
  const { ownRights, shareDataset } = query;
  if (ownRights === undefined && shareDataset === undefined) return undefined;
  return normalizeTrainingDataShare({
    ownRights: ownRights === '1',
    shareDataset: shareDataset === '1',
  });
}

/**
 * Whether `owner` (an int SQL expression) is a held owner for sharing a training dataset: every
 * owner `ownerHeldSql` holds, plus any owner a report names at all.
 */
export function trainingDataOwnerHeldSql(owner: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${ownerHeldSql(owner)} OR EXISTS (
    SELECT 1 FROM "CsamReport" tr
    WHERE tr."userId" = ${owner} OR tr.details ->> 'secondaryUserId' = (${owner})::text
  ))`;
}

/** Whether the model version `versionId` (an int SQL expression) carries held content. */
export function trainingDataContentHeldSql(versionId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(EXISTS (
    SELECT 1 FROM "ModelVersion" hv JOIN "Model" hm ON hm.id = hv."modelId"
    WHERE hv.id = ${versionId} AND (hm.poi OR hm.minor OR hm."tosViolation")
  ) OR EXISTS (
    SELECT 1 FROM "Post" hp JOIN "Image" hi ON hi."postId" = hp.id
    WHERE hp."modelVersionId" = ${versionId}
      AND (hi."needsReview" IS NOT NULL OR hi."blockedFor" IS NOT NULL OR hi.ingestion = 'Blocked')
  ))`;
}

/**
 * Whether the training dataset of `modelVersionId` must not be shared: a held owner or held
 * content. `true` when that can't be read.
 */
export function trainingDataShareHeld(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  modelVersionId: number
): Promise<boolean> {
  return ownerHeld(
    db,
    Prisma.sql`FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = ${modelVersionId}`,
    Prisma.sql`(${trainingDataOwnerHeldSql(
      Prisma.raw('m."userId"')
    )} OR ${trainingDataContentHeldSql(Prisma.raw('mv.id'))})`
  );
}

/**
 * The visibility of a Training Studio dataset row. Only an archived zip that holds the whole run
 * (`complete`) can be shared; a placeholder never can.
 */
export async function studioDatasetVisibility(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  {
    modelVersionId,
    metadata,
    complete,
  }: { modelVersionId: number; metadata: Record<string, unknown>; complete: boolean }
) {
  const choice = normalizeTrainingDataShare(metadata);
  if (!choice.shareDataset) return trainingDataVisibility(choice);
  // A share that can't be honoured fails closed to Private, not to the owner-only Sensitive.
  if (!complete || (await trainingDataShareHeld(db, modelVersionId)))
    return ModelFileVisibility.Private;
  return ModelFileVisibility.Public;
}

type DatasetRow = { id: number; sizeKB: number; metadata: Record<string, unknown> | null };

/**
 * Record the owner's sharing choice on a Studio run's `Training Data` row. A row whose zip is already
 * in place takes the matching visibility now; a placeholder keeps its own until the archive job
 * swaps the zip in and applies it.
 */
export async function setStudioDatasetShare(modelVersionId: number, choice: TrainingDataShare) {
  const changed = await dbWrite.$transaction(async (tx) => {
    // Locked, so the archive job's swap cannot interleave and drop the choice.
    const [row] = await tx.$queryRaw<DatasetRow[]>`
      SELECT id, "sizeKB", metadata FROM "ModelFile"
      WHERE "modelVersionId" = ${modelVersionId} AND type = 'Training Data'
        AND metadata ? 'selectedEpochUrl'
      ORDER BY id LIMIT 1
      FOR UPDATE`;
    if (!row) return false;
    const metadata: Record<string, unknown> = {
      ...row.metadata,
      ...normalizeTrainingDataShare(choice),
    };
    const archive = metadata.datasetArchive as { status?: string; complete?: boolean } | undefined;
    const archived = row.sizeKB > 0 && archive?.status === 'archived';
    await tx.modelFile.update({
      where: { id: row.id },
      data: {
        metadata: metadata as Prisma.InputJsonObject,
        ...(archived && {
          visibility: await studioDatasetVisibility(tx, {
            modelVersionId,
            metadata,
            complete: archive?.complete === true,
          }),
        }),
      },
    });
    return archived;
  });
  if (changed) await deleteFilesForModelVersionCache(modelVersionId);
}
