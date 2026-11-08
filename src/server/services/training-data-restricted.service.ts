import { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import { ownerHeld, ownerHeldSql } from '~/server/services/legal-hold.service';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
import {
  trainingDataServableOnHost,
  trainingDataVisibility,
} from '~/shared/utils/training-data-visibility';

// The read side of dataset sharing, kept apart from the write side so the listing paths and the
// model-file service that import it do not pull in the model-file cache.

/** The owner's dataset-sharing choice, stored on the `Training Data` file's metadata. */
export type TrainingDataShare = { ownRights: boolean; shareDataset: boolean };

/** Sharing needs the rights: a share without them is stored as not shared. */
export function normalizeTrainingDataShare(share: Partial<TrainingDataShare>): TrainingDataShare {
  const ownRights = share.ownRights === true;
  return { ownRights, shareDataset: ownRights && share.shareDataset === true };
}

/**
 * Whether `owner` (an int SQL expression) may not share a training dataset: every owner
 * `ownerHeldSql` covers, plus the users `legalHoldUserIdsSql` pairs, here without its age limit.
 */
export function trainingDataOwnerRestrictedSql(owner: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${ownerHeldSql(owner)} OR EXISTS (
    SELECT 1 FROM "CsamReport" tr
    WHERE tr."userId" = ${owner} OR tr.details ->> 'secondaryUserId' = (${owner})::text
  ))`;
}

/** Whether the model version `versionId` (an int SQL expression) carries restricted content. */
export function trainingDataContentRestrictedSql(versionId: Prisma.Sql): Prisma.Sql {
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
 * Whether the training dataset of `modelVersionId` must not be shared: a restricted owner or
 * restricted content. `true` when that can't be read.
 */
export function trainingDataShareRestricted(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  modelVersionId: number
): Promise<boolean> {
  return ownerHeld(
    db,
    Prisma.sql`FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = ${modelVersionId}`,
    Prisma.sql`(${trainingDataOwnerRestrictedSql(
      Prisma.raw('m."userId"')
    )} OR ${trainingDataContentRestrictedSql(Prisma.raw('mv.id'))})`
  );
}

type ListedFile = { id: number; type: string; visibility: string };

/**
 * Whether a file may be listed: a `Training Data` file is left out where its download would be
 * refused, so the listing never offers one. That is a shared dataset `trainingDataShareRestricted`
 * refuses, or one `trainingDataServableOnHost` refuses on this host. Neither applies to the
 * owner and moderators (`viewerManages`). Versions with no dataset cost no query; when the check
 * can't be read, every dataset among them is left out.
 */
export async function trainingDataListing(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  versions: { id: number; files: ListedFile[] }[],
  { redCapable, viewerManages = false }: { redCapable: boolean; viewerManages?: boolean }
): Promise<(file: ListedFile) => boolean> {
  if (viewerManages) return () => true;
  const candidates = versions
    .filter((v) => v.files.some((f) => f.type === 'Training Data'))
    .map((v) => v.id);
  if (!candidates.length) return () => true;
  const rows = await db.$queryRaw<
    { id: number; nsfwLevel: unknown; fullyRated: unknown; restricted: boolean | null }[]
  >`
    SELECT mf.id, mf.metadata -> 'nsfwLevel' AS "nsfwLevel",
      mf.metadata -> 'fullyRated' AS "fullyRated", (${trainingDataOwnerRestrictedSql(
        Prisma.raw('m."userId"')
      )}
      OR ${trainingDataContentRestrictedSql(Prisma.raw('mv.id'))}) AS restricted
    FROM "ModelFile" mf
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mf."modelVersionId" = ANY(${candidates}::int[]) AND mf.type = 'Training Data'`.catch(
    (e: unknown) => {
      logToAxiom({
        type: 'error',
        name: 'training-data-share-check-failed',
        message: (e as Error).message,
      }).catch(() => undefined);
      return null;
    }
  );
  if (!rows) return (file) => file.type !== 'Training Data';
  const refused = new Set(
    rows
      .filter((r) => r.restricted !== false || !trainingDataServableOnHost(r, redCapable))
      .map((r) => r.id)
  );
  return (file) => !(file.type === 'Training Data' && refused.has(file.id));
}

type ViewedFile = { id: number; type: string; visibility: string; metadata?: unknown };

/** Training Data metadata the server writes for its own decisions; none of it is for display. */
const SERVER_ONLY_KEYS = ['datasetArchive', 'nsfwLevel', 'fullyRated'];

/**
 * The owner's view of their files: a share stored Private reads the same whatever kept it there,
 * with no reason attached.
 */
export function trainingDataOwnerView<T extends ViewedFile[] | null | undefined>(files: T): T {
  return files?.map((file) => {
    if (file.type !== 'Training Data' || !file.metadata || typeof file.metadata !== 'object')
      return file;
    const metadata = { ...(file.metadata as Record<string, unknown>) };
    for (const key of SERVER_ONLY_KEYS) delete metadata[key];
    return { ...file, metadata };
  }) as T;
}

/**
 * Everyone else's view (not the owner, not a moderator): a `Training Data` file is listed only
 * while it is Public and `trainingDataListing` lists it, and then without its metadata, so a row
 * that is absent reads the same as one never shared.
 */
export async function trainingDataPublicView<F extends ViewedFile>(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  versions: { id: number; files: F[] }[],
  { redCapable }: { redCapable: boolean }
): Promise<(files: F[]) => F[]> {
  const listed = await trainingDataListing(db, versions, { redCapable });
  return (files) =>
    files
      .filter((f) => f.type !== 'Training Data' || (f.visibility === 'Public' && listed(f)))
      .map((f) => (f.type === 'Training Data' ? { ...f, metadata: {} } : f));
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
  if (!complete || (await trainingDataShareRestricted(db, modelVersionId)))
    return ModelFileVisibility.Private;
  return ModelFileVisibility.Public;
}

const VISIBILITY_RANK: Record<ModelFileVisibility, number> = {
  [ModelFileVisibility.Private]: 0,
  [ModelFileVisibility.Sensitive]: 1,
  [ModelFileVisibility.Public]: 2,
};

/** A Training Studio dataset row: its sharing is decided by `studioDatasetVisibility`. */
export function isStudioDataset(file: { type: string; metadata: unknown }) {
  return (
    file.type === 'Training Data' &&
    !!file.metadata &&
    typeof file.metadata === 'object' &&
    'selectedEpochUrl' in file.metadata
  );
}

/**
 * The visibility a Studio dataset row takes when its owner edits it directly: what they asked for,
 * but never above what `studioDatasetVisibility` allows for the stored zip, which an unrated item
 * also keeps unshared. A placeholder allows only Private.
 */
export async function cappedStudioDatasetVisibility(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  {
    modelVersionId,
    sizeKB,
    metadata,
    requested,
  }: {
    modelVersionId: number;
    sizeKB: number;
    metadata: Record<string, unknown>;
    requested: ModelFileVisibility;
  }
): Promise<ModelFileVisibility> {
  const archive = metadata.datasetArchive as { status?: string; complete?: boolean } | undefined;
  const allowed =
    sizeKB > 0 && archive?.status === 'archived'
      ? await studioDatasetVisibility(db, {
          modelVersionId,
          metadata,
          complete: archive.complete === true && metadata.fullyRated !== false,
        })
      : ModelFileVisibility.Private;
  return VISIBILITY_RANK[requested] <= VISIBILITY_RANK[allowed] ? requested : allowed;
}
