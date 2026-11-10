import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  normalizeTrainingDataShare,
  studioDatasetVisibility,
  type TrainingDataShare,
} from '~/server/services/training-data-restricted.service';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';

export { normalizeTrainingDataShare, type TrainingDataShare };

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

type DatasetRow = { id: number; sizeKB: number; metadata: Record<string, unknown> | null };

function lowered(stored: TrainingDataShare, next: TrainingDataShare): TrainingDataShare {
  return normalizeTrainingDataShare({
    ownRights: stored.ownRights && next.ownRights,
    shareDataset: stored.shareDataset && next.shareDataset,
  });
}

/** Whether `next` claims the rights or shares where `stored` does not, which only
 *  `setStudioDatasetShare` with `raise` may grant. */
export function raisesTrainingDataShare(stored: TrainingDataShare, next: TrainingDataShare) {
  const n = normalizeTrainingDataShare(next);
  return (n.ownRights && !stored.ownRights) || (n.shareDataset && !stored.shareDataset);
}

/** The sharing choice stored on a Studio run's `Training Data` row, or null without one. */
export async function getStudioDatasetShare(
  modelVersionId: number
): Promise<TrainingDataShare | null> {
  const [row] = await dbWrite.$queryRaw<Pick<DatasetRow, 'metadata'>[]>`
    SELECT metadata FROM "ModelFile"
    WHERE "modelVersionId" = ${modelVersionId} AND type = 'Training Data'
      AND metadata ? 'selectedEpochUrl'
    ORDER BY id LIMIT 1`;
  return row ? normalizeTrainingDataShare(row.metadata ?? {}) : null;
}

/**
 * Record the owner's sharing choice on a Studio run's `Training Data` row. A row whose zip is already
 * in place takes the matching visibility now; a placeholder keeps its own until the archive job
 * swaps the zip in and applies it. Without `raise` the choice can only lower the stored one, so a
 * cross-site link can never share a dataset; `raise` is for the owner's own click. `ownerId`
 * limits the write to that owner's model. Returns whether a row was found.
 */
export async function setStudioDatasetShare(
  modelVersionId: number,
  choice: TrainingDataShare,
  { raise = false, ownerId }: { raise?: boolean; ownerId?: number } = {}
): Promise<boolean> {
  const result = await dbWrite.$transaction(async (tx) => {
    // Locked, so the archive job's swap cannot interleave and drop the choice.
    const [row] = await tx.$queryRaw<DatasetRow[]>`
      SELECT mf.id, mf."sizeKB", mf.metadata FROM "ModelFile" mf
      WHERE mf."modelVersionId" = ${modelVersionId} AND mf.type = 'Training Data'
        AND mf.metadata ? 'selectedEpochUrl'
        ${
          ownerId === undefined
            ? Prisma.empty
            : Prisma.sql`AND EXISTS (
                SELECT 1 FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
                WHERE mv.id = mf."modelVersionId" AND m."userId" = ${ownerId}
              )`
        }
      ORDER BY mf.id LIMIT 1
      FOR UPDATE OF mf`;
    if (!row) return { found: false, changed: false };
    const stored = normalizeTrainingDataShare(row.metadata ?? {});
    const next = raise ? normalizeTrainingDataShare(choice) : lowered(stored, choice);
    const metadata: Record<string, unknown> = { ...row.metadata, ...next };
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
    return { found: true, changed: archived };
  });
  if (result.changed) await deleteFilesForModelVersionCache(modelVersionId);
  return result.found;
}
