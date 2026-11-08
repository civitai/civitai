import { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import { ownerHeld, ownerHeldSql } from '~/server/services/legal-hold.service';
import { trainingDataServableOnHost } from '~/shared/utils/training-data-visibility';

// The read side of dataset sharing, kept apart from the write side so the listing paths that
// import it do not pull in the model-file cache.

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

type ListedFile = { id: number; type: string; visibility: string };

/**
 * Whether a file may be listed: a `Training Data` file is left out where its download would be
 * refused, so the listing never offers one. That is a shared dataset `trainingDataShareHeld`
 * refuses (checked only when `viewerManages` is false, as the owner and moderators see a held
 * dataset), and a dataset `trainingDataServableOnHost` refuses on this host. Versions with no
 * dataset cost no query, nor do any when neither check applies; when the check can't be read,
 * every dataset among them is left out.
 */
export async function trainingDataListing(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  versions: { id: number; files: ListedFile[] }[],
  { redCapable, viewerManages = false }: { redCapable: boolean; viewerManages?: boolean }
): Promise<(file: ListedFile) => boolean> {
  if (redCapable && viewerManages) return () => true;
  const candidates = versions
    .filter((v) => v.files.some((f) => f.type === 'Training Data'))
    .map((v) => v.id);
  if (!candidates.length) return () => true;
  const held = viewerManages
    ? Prisma.sql`false`
    : Prisma.sql`(${trainingDataOwnerHeldSql(Prisma.raw('m."userId"'))}
        OR ${trainingDataContentHeldSql(Prisma.raw('mv.id'))})`;
  const rows = await db.$queryRaw<{ id: number; nsfwLevel: unknown; held: boolean | null }[]>`
    SELECT mf.id, mf.metadata -> 'nsfwLevel' AS "nsfwLevel", ${held} AS held
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
      .filter((r) => r.held !== false || !trainingDataServableOnHost(r.nsfwLevel, redCapable))
      .map((r) => r.id)
  );
  return (file) => !(file.type === 'Training Data' && refused.has(file.id));
}
