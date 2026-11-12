import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { hasScanWorkflowSql } from '~/server/common/judge-rating';
import { IMAGE_RESCAN_RETRY_LIMIT } from '~/server/services/image-scan-failure';
import {
  queueNeverScannedRescan,
  rescannableImageSql,
} from '~/server/services/judge-collection-rescan.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

/**
 * Sends never-scanned images in collections whose judges apply the browsing level to the scan,
 * through the same write as the rating self-heal (`queueNeverScannedRescan`), which seeds the level
 * the judges applied as a legacy floor. Run it only once the judge-rating floor is deployed; a run
 * refuses until the primary's `update_nsfw_levels_new` carries it. A GET is a dry run.
 */

const BATCH_SIZE = 500;

const schema = z.object({
  dryRun: booleanString().default(true),
  // `ids=` parses as [0]; only positive ids are a list.
  ids: commaDelimitedNumberArray(z.number().int().positive().array().min(1)).optional(),
  concurrency: z.coerce.number().min(1).max(10).default(1),
});

const inCollectionPost = (flagged: boolean) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Post" p
  JOIN "Collection" c ON c.id = p."collectionId"
  WHERE p.id = i."postId"
  ${flagged ? Prisma.sql`AND c.metadata->>'judgesApplyBrowsingLevel' = 'true'` : Prisma.empty}
)`;
const inJudgeCollection = inCollectionPost(true);
// The cohort markers. "No jobs": no scan workflow.
const scannedNoJobs = Prisma.sql`(i.ingestion = 'Scanned'::"ImageIngestionStatus" AND NOT ${hasScanWorkflowSql(
  'i'
)})`;
const pendingManual = Prisma.sql`(i.ingestion = 'PendingManualAssignment'::"ImageIngestionStatus")`;
// What the shared write accepts, in a judge-rated collection: so the counts match what it queues.
const inScope = Prisma.sql`(${inJudgeCollection} AND ${rescannableImageSql('i')})`;
// Counted only: the shared write marks these Error instead of queuing them.
const outOfRetries = Prisma.sql`COALESCE((i."scanJobs"->>'retryCount')::int, 0) >= ${IMAGE_RESCAN_RETRY_LIMIT}`;
const hasScannerTags = Prisma.sql`EXISTS (
  SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi.source != 'User'::"TagSource"
)`;

const idFilter = (ids?: number[]) =>
  ids ? Prisma.sql`AND i.id IN (${Prisma.join(ids)})` : Prisma.empty;

async function countCohorts(ids?: number[]) {
  const [row] = await dbRead.$queryRaw<
    { scannedNoJobs: number; pendingManual: number; outOfRetries: number }[]
  >`
    SELECT
      count(*) FILTER (WHERE ${scannedNoJobs})::int AS "scannedNoJobs",
      count(*) FILTER (WHERE ${pendingManual})::int AS "pendingManual",
      count(*) FILTER (WHERE ${outOfRetries})::int AS "outOfRetries"
    FROM "Image" i
    WHERE ${inScope} ${idFilter(ids)}
  `;
  return row ?? { scannedNoJobs: 0, pendingManual: 0, outOfRetries: 0 };
}

/**
 * The same markers without the flag: `PendingManualAssignment` anywhere, and `Scanned` without a
 * scan workflow in any collection's post. Rows here and not in the cohorts are in a collection
 * whose flag is off now; they are reported, not queued.
 */
async function countWide() {
  const [row] = await dbRead.$queryRaw<{ pendingManual: number; scannedNoJobs: number }[]>`
    SELECT
      (SELECT count(*)::int FROM "Image" i WHERE ${pendingManual}) AS "pendingManual",
      (SELECT count(*)::int FROM "Image" i WHERE ${scannedNoJobs} AND ${inCollectionPost(
    false
  )}) AS "scannedNoJobs"
  `;
  return row ?? { pendingManual: 0, scannedNoJobs: 0 };
}

/**
 * Checks the scope against scanner tags, which the markers do not read: an image in scope should
 * have none, and a Scanned image in the same collections with a scan workflow should have them.
 */
async function scopeControls() {
  const [row] = await dbRead.$queryRaw<
    { inScopeWithScannerTags: number; outOfScopeScannedWithoutScannerTags: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM "Image" i WHERE ${inScope} AND ${hasScannerTags})
        AS "inScopeWithScannerTags",
      (SELECT count(*)::int FROM "Image" i
        WHERE ${inJudgeCollection} AND i.ingestion = 'Scanned'::"ImageIngestionStatus"
          AND ${hasScanWorkflowSql('i')} AND NOT ${hasScannerTags})
        AS "outOfScopeScannedWithoutScannerTags"
  `;
  return row ?? { inScopeWithScannerTags: 0, outOfScopeScannedWithoutScannerTags: 0 };
}

/** In-scope rows held for moderator review: a rescan's verdict would replace the hold. */
async function countHeld(ids?: number[]) {
  const [row] = await dbRead.$queryRaw<{ held: number }[]>`
    SELECT count(*)::int AS held FROM "Image" i
    WHERE ${inScope} AND i."needsReview" IS NOT NULL ${idFilter(ids)}
  `;
  return row?.held ?? 0;
}

async function inScopeIds(ids?: number[]) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i WHERE ${inScope} ${idFilter(ids)} ORDER BY i.id
  `;
  return rows.map((r) => r.id);
}

/**
 * Whether the primary's tag recompute carries the judge-rating floor (migration
 * 20270105120000): without it, a recompute can take a rescanned image below the seeded rating.
 */
async function floorMigrationApplied() {
  const [row] = await dbWrite.$queryRaw<{ applied: boolean }[]>`
    SELECT COALESCE(
      pg_get_functiondef(to_regprocedure('update_nsfw_levels_new(integer[])')) LIKE '%judgeRating%',
      false
    ) AS applied
  `;
  return row?.applied === true;
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query' });
  const { dryRun, ids, concurrency } = parsed.data;
  if (!dryRun && req.method !== 'POST')
    return res.status(405).json({ error: 'Only a POST may write; a GET is a dry run' });

  if (ids) {
    const matched = await inScopeIds(ids);
    const refused = new Set(ids).size - matched.length;
    if (refused > 0) {
      console.log(`rescan-judge-collection-images: refused ${refused} out-of-scope ids`);
      return res.status(400).json({ error: 'Some ids are outside the scope', refused });
    }
  }

  const [cohorts, heldForReview, floorApplied] = await Promise.all([
    countCohorts(ids),
    countHeld(ids),
    floorMigrationApplied(),
  ]);
  console.log(
    `rescan-judge-collection-images: scannedNoJobs=${cohorts.scannedNoJobs} pendingManual=${cohorts.pendingManual} outOfRetries=${cohorts.outOfRetries} heldForReview=${heldForReview} floorMigrationApplied=${floorApplied} dryRun=${dryRun}`
  );
  if (dryRun) {
    const [wide, controls] = await Promise.all([countWide(), scopeControls()]);
    console.log(
      `rescan-judge-collection-images: wide pendingManual=${wide.pendingManual} scannedNoJobs=${wide.scannedNoJobs}; controls inScopeWithScannerTags=${controls.inScopeWithScannerTags} outOfScopeScannedWithoutScannerTags=${controls.outOfScopeScannedWithoutScannerTags}`
    );
    return res.status(200).json({
      dryRun,
      cohorts,
      heldForReview,
      floorMigrationApplied: floorApplied,
      wide,
      controls,
    });
  }
  if (!floorApplied)
    return res.status(400).json({ error: 'The judge-rating floor migration is not applied' });
  if (heldForReview > 0)
    return res
      .status(400)
      .json({ error: 'Some in-scope images are held for moderator review', heldForReview });

  let queued = 0;
  let markedError = 0;
  await batchProcessor({
    params: { batchSize: BATCH_SIZE, concurrency, ids: await inScopeIds(ids) },
    runContext: res,
    batchFetcher: async () => [],
    processor: async ({ batch, batchNumber, batchCount }) => {
      if (!batch.length) return;
      // The write checks the scope again, so a row that changed since the read is skipped.
      const count = await queueNeverScannedRescan(batch, inJudgeCollection);
      queued += count.queued.length;
      markedError += count.failed.length;
      console.log(
        `rescan-judge-collection-images: batch ${batchNumber} of ${batchCount}: queued ${count.queued.length} markedError ${count.failed.length}`
      );
    },
  });

  return res.status(200).json({ dryRun, cohorts, queued, markedError });
});
