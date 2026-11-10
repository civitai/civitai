import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';
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

/** Whether `owner` (an int SQL expression) may not share a training dataset. */
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
 * owner and moderators (`viewerManages`). Fails closed: every dataset is left out when the check
 * can't be read.
 */
export async function trainingDataListing(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  versions: { id: number; files?: ListedFile[] | null }[],
  { redCapable, viewerManages = false }: { redCapable: boolean; viewerManages?: boolean }
): Promise<(file: ListedFile) => boolean> {
  if (viewerManages) return () => true;
  const candidates = versions
    // `files` is absent when the read did not select them (model-version getById without
    // `withFiles`): such a version lists nothing, so it has nothing to check.
    .filter((v) => v.files?.some((f) => f.type === 'Training Data'))
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
export function trainingDataOwnerView<
  T extends Pick<ViewedFile, 'type' | 'metadata'>[] | null | undefined
>(files: T): T {
  return files?.map((file) =>
    file.type === 'Training Data'
      ? { ...file, metadata: withoutServerOnlyKeys(file.metadata) }
      : file
  ) as T;
}

/**
 * Files without their training epochs' urls, which are the orchestrator's links to the run's
 * weights; everything else about each epoch is kept. A file whose own `url` is one of those links
 * (a Training Studio dataset placeholder holds its selected epoch until it is archived) loses it
 * too. For a model whose weights are withheld (`isModelDeletedOrTakenDown`) from everyone but moderators.
 */
export function withoutEpochUrls<
  T extends { url?: unknown; metadata?: unknown }[] | null | undefined
>(files: T): T {
  return files?.map((file) => {
    const metadata = file.metadata as Record<string, unknown> | null | undefined;
    const epochUrls = new Set<unknown>();
    let kept = metadata;
    if (metadata && typeof metadata === 'object') {
      const { selectedEpochUrl, ...rest } = metadata;
      epochUrls.add(selectedEpochUrl);
      const trainingResults = rest.trainingResults as { epochs?: unknown } | undefined;
      if (Array.isArray(trainingResults?.epochs)) {
        rest.trainingResults = {
          ...trainingResults,
          epochs: trainingResults.epochs.map((epoch: unknown) => {
            if (!epoch || typeof epoch !== 'object') return epoch;
            const { modelUrl, model_url, ...epochRest } = epoch as Record<string, unknown>;
            epochUrls.add(modelUrl);
            epochUrls.add(model_url);
            return epochRest;
          }),
        };
      }
      kept = rest;
    }
    const url =
      typeof file.url === 'string' &&
      (epochUrls.has(file.url) || isTrustedOrchestratorUrl(file.url))
        ? undefined
        : file.url;
    return { ...file, ...('url' in file ? { url } : {}), metadata: kept };
  }) as T;
}

/** Whether any of `files` could hold an epoch url, so a view need not look its model up otherwise. */
export function mayCarryEpochUrls(
  files: { url?: unknown; metadata?: unknown }[] | null | undefined
) {
  return !!files?.some((file) => {
    const metadata = file.metadata as Record<string, unknown> | null | undefined;
    return (
      !!metadata?.selectedEpochUrl ||
      !!metadata?.trainingResults ||
      (typeof file.url === 'string' && isTrustedOrchestratorUrl(file.url))
    );
  });
}

/** A `Training Data` file's metadata as its owner sees it (`trainingDataOwnerView`). */
export function withoutServerOnlyKeys<M>(metadata: M): M {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const copy = { ...(metadata as Record<string, unknown>) };
  for (const key of SERVER_ONLY_KEYS) delete copy[key];
  return copy as M;
}

/**
 * Everyone else's view (not the owner, not a moderator): a `Training Data` file is listed only
 * while it is Public and `trainingDataListing` lists it, and then without its metadata, so a row
 * that is absent reads the same as one never shared.
 */
export async function trainingDataPublicView<F extends ViewedFile>(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  versions: { id: number; files?: F[] | null }[],
  { redCapable }: { redCapable: boolean }
): Promise<<T extends F[] | null | undefined>(files: T) => T> {
  const listed = await trainingDataListing(db, versions, { redCapable });
  // An absent `files` (not selected by the read) is passed through as it came.
  return (files) =>
    files == null
      ? files
      : (files
          .filter((f) => f.type !== 'Training Data' || (f.visibility === 'Public' && listed(f)))
          .map((f) => (f.type === 'Training Data' ? { ...f, metadata: {} } : f)) as typeof files);
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

/**
 * Whether `modelVersionId` is a Training Studio version: it has a Studio dataset row, or its model
 * was published from Studio (a server-owned meta key, so deleting the row does not change the
 * answer). Any other `Training Data` file on that version stays Private for everyone but
 * moderators, so a second upload can't share what the Studio rules keep unshared.
 */
export async function versionHasStudioDataset(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  modelVersionId: number
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT mf.id FROM "ModelFile" mf
    WHERE mf."modelVersionId" = ${modelVersionId} AND mf.type = 'Training Data'
      AND mf.metadata ? 'selectedEpochUrl'
    UNION ALL
    SELECT mv.id FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv.id = ${modelVersionId} AND m.meta ? 'trainingStudioWorkflowId'
    LIMIT 1
  `;
  return rows.length > 0;
}

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
