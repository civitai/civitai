import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

/**
 * Queues a normal rescan for images posted to collections whose judges apply the browsing level,
 * when the image never went through the scan: `Scanned` with no `scanJobs`, or
 * `PendingManualAssignment`. Writes only the queue: `ingestion = 'Rescan'` and a `JobQueue`
 * `ImageScan` row. Dry run by default, returning per-cohort counts and a scope check on one image
 * each side of the scope. Logs counts, never ids.
 */

const BATCH_SIZE = 500;

const schema = z.object({
  dryRun: booleanString().default(true),
  ids: commaDelimitedNumberArray().optional(),
  concurrency: z.coerce.number().min(1).max(10).default(1),
});

const inJudgeCollection = Prisma.sql`EXISTS (
  SELECT 1 FROM "Post" p
  JOIN "Collection" c ON c.id = p."collectionId"
  WHERE p.id = i."postId" AND c.metadata->>'judgesApplyBrowsingLevel' = 'true'
)`;
const neverScanned = Prisma.sql`(i.ingestion = 'Scanned'::"ImageIngestionStatus" AND i."scanJobs" IS NULL)`;
const pendingManual = Prisma.sql`(i.ingestion = 'PendingManualAssignment'::"ImageIngestionStatus")`;
const inScope = Prisma.sql`(${inJudgeCollection} AND (${neverScanned} OR ${pendingManual}))`;

const idFilter = (ids?: number[]) =>
  ids ? Prisma.sql`AND i.id IN (${Prisma.join(ids)})` : Prisma.empty;

async function countCohorts(ids?: number[]) {
  const [row] = await dbRead.$queryRaw<{ neverScanned: number; pendingManual: number }[]>`
    SELECT
      count(*) FILTER (WHERE ${neverScanned})::int AS "neverScanned",
      count(*) FILTER (WHERE ${pendingManual})::int AS "pendingManual"
    FROM "Image" i
    WHERE ${inScope} ${idFilter(ids)}
  `;
  return row ?? { neverScanned: 0, pendingManual: 0 };
}

async function inScopeIds(ids?: number[]) {
  if (ids && !ids.length) return [];
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i WHERE ${inScope} ${idFilter(ids)} ORDER BY i.id
  `;
  return rows.map((r) => r.id);
}

/** One image each side of the scope, picked now, run through the same check the run uses. */
async function scopeControls() {
  const [inside] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i WHERE ${inScope} LIMIT 1
  `;
  const [outside] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i WHERE ${inJudgeCollection} AND NOT ${inScope} LIMIT 1
  `;
  const insideMatched = inside ? (await inScopeIds([inside.id])).length === 1 : null;
  const outsideMatched = outside ? (await inScopeIds([outside.id])).length === 1 : null;
  return {
    inScope: insideMatched === null ? 'none found' : insideMatched ? 'included' : 'MISMATCH',
    outOfScope: outsideMatched === null ? 'none found' : outsideMatched ? 'MISMATCH' : 'excluded',
  };
}

export default WebhookEndpoint(async (req, res) => {
  const { dryRun, ids, concurrency } = schema.parse(req.query);

  if (ids) {
    const matched = await inScopeIds(ids);
    const refused = new Set(ids).size - matched.length;
    if (refused > 0) {
      console.log(`rescan-judge-collection-images: refused ${refused} out-of-scope ids`);
      return res.status(400).json({ error: 'Some ids are outside the scope', refused });
    }
  }

  const cohorts = await countCohorts(ids);
  console.log(
    `rescan-judge-collection-images: neverScanned=${cohorts.neverScanned} pendingManual=${cohorts.pendingManual} dryRun=${dryRun}`
  );
  if (dryRun) return res.status(200).json({ dryRun, cohorts, controls: await scopeControls() });

  let queued = 0;
  await batchProcessor({
    params: { batchSize: BATCH_SIZE, concurrency, ids: await inScopeIds(ids) },
    runContext: res,
    batchFetcher: async () => [],
    processor: async ({ batch, batchNumber, batchCount }) => {
      if (!batch.length) return;
      // The scope is checked again on write, so a row that changed since the read is skipped.
      const updated = await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "Image" i SET ingestion = 'Rescan'::"ImageIngestionStatus"
        WHERE i.id IN (${Prisma.join(batch)}) AND ${inScope}
        RETURNING i.id
      `;
      if (updated.length) {
        await dbWrite.$executeRaw`
          INSERT INTO "JobQueue" (type, "entityType", "entityId")
          SELECT 'ImageScan'::"JobQueueType", 'Image'::"EntityType", id
          FROM unnest(ARRAY[${Prisma.join(updated.map((r) => r.id))}]::int[]) AS id
          ON CONFLICT DO NOTHING
        `;
      }
      queued += updated.length;
      console.log(
        `rescan-judge-collection-images: batch ${batchNumber} of ${batchCount}: queued ${updated.length}`
      );
    },
  });

  return res.status(200).json({ dryRun, cohorts, queued });
});
