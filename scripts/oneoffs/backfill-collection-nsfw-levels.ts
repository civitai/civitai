/**
 * Directly recompute Collection.nsfwLevel for every publicly-visible Collection
 * using the new bucket logic. Bypasses the JobQueue so this script runs the
 * NEW code against prod DB before the deploy rolls out.
 *
 * Scope: availability='Public' AND read IN ('Public','Unlisted').
 *   The default bookmark/liked collections auto-created per user have
 *   availability='Public' but read='Private' — they never surface on any
 *   feed, so nsfwLevel is irrelevant for them.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/backfill-collection-nsfw-levels.ts [options]
 *
 * Options:
 *   --dry-run         Report counts only, no writes.
 *   --chunk-size=N    Collections per UPDATE (default 500).
 *   --concurrency=N   Parallel UPDATE batches in flight (default 5).
 *   --min-id=N        Resume cursor (inclusive).
 *
 * Precedence (applied per-row inside UPDATE_SQL):
 *   1. metadata.forcedBrowsingLevel set → map forced bits to bucket
 *   2. otherwise → two-probe scan of ACCEPTED items
 * The Collection.nsfw boolean is ignored — it's auto-flipped by user NSFW
 * reports and not a reliable signal.
 * Empty non-forced collections stay at 0 (pending-review for owner/mod).
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const chunkArg = args.find((a) => a.startsWith('--chunk-size='));
const concArg = args.find((a) => a.startsWith('--concurrency='));
const minIdArg = args.find((a) => a.startsWith('--min-id='));
const CHUNK = chunkArg ? parseInt(chunkArg.split('=')[1], 10) : 500;
const CONCURRENCY = concArg ? parseInt(concArg.split('=')[1], 10) : 5;
const MIN_ID = minIdArg ? parseInt(minIdArg.split('=')[1], 10) : 0;

const prisma = new PrismaClient();

async function main() {
  console.log(
    `[backfill] dryRun=${isDryRun} chunk=${CHUNK} concurrency=${CONCURRENCY} minId=${MIN_ID}`
  );

  // Scope: non-empty visible collections. Bucket is computed from items
  // (and forcedBrowsingLevel if set). Collections with no items stay at 0.
  const [{ count: candidateCount }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count
     FROM "Collection" c
     JOIN "CollectionMetric" cm ON cm."collectionId" = c.id AND cm.timeframe = 'AllTime'
     WHERE c."availability" = 'Public' AND c."read" IN ('Public', 'Unlisted')
       AND cm."itemCount" > 0 AND c.id >= $1`,
    MIN_ID
  );
  const total = Number(candidateCount);
  console.log(`scan candidates (non-empty visible, id >= ${MIN_ID}): ${total}`);

  if (isDryRun || total === 0) {
    await prisma.$disconnect();
    return;
  }

  // --- Phase 2: iterate by id cursor, batch-update via the new bucket SQL.
  // Mirrors updateCollectionsNsfwLevels in nsfwLevels.service.ts.
  // Precedence: forcedBrowsingLevel > nsfw > item scan.
  const UPDATE_SQL = `WITH collections AS (
    SELECT c.id, (
      CASE
        WHEN (c.metadata->>'forcedBrowsingLevel') IS NOT NULL
          AND (c.metadata->>'forcedBrowsingLevel') ~ '^[0-9]+$' THEN
          ((CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & 3) != 0 THEN 1 ELSE 0 END)
           | (CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & 60) != 0 THEN 28 ELSE 0 END))
        ELSE
          ((CASE WHEN EXISTS (
              SELECT 1 FROM "CollectionItem" ci
              LEFT JOIN "Image"   i ON i.id = ci."imageId"
              LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
              LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
              LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
              WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & 3) != 0
            ) THEN 1 ELSE 0 END)
          | (CASE WHEN EXISTS (
              SELECT 1 FROM "CollectionItem" ci
              LEFT JOIN "Image"   i ON i.id = ci."imageId"
              LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
              LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
              LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
              WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & 60) != 0
            ) THEN 28 ELSE 0 END))
      END
    ) AS "nsfwLevel"
    FROM "Collection" c
    WHERE c.id = ANY($1::int[])
      AND c."availability" = 'Public'
      AND c."read" IN ('Public', 'Unlisted')
  )
  UPDATE "Collection" c
  SET "nsfwLevel" = c2."nsfwLevel"
  FROM collections c2
  WHERE c.id = c2.id AND c."nsfwLevel" != c2."nsfwLevel"`;

  let cursor = MIN_ID;
  let processed = 0;
  const started = Date.now();

  async function runBatch(ids: number[]) {
    try {
      await prisma.$executeRawUnsafe(UPDATE_SQL, ids);
    } catch (err: any) {
      console.error(`[scan] batch failed (first=${ids[0]}, size=${ids.length}):`, err.message);
    }
  }

  while (true) {
    // Pull a super-batch big enough for CONCURRENCY parallel UPDATEs.
    const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
      `SELECT c.id
       FROM "Collection" c
       JOIN "CollectionMetric" cm ON cm."collectionId" = c.id AND cm.timeframe = 'AllTime'
       WHERE c."availability" = 'Public' AND c."read" IN ('Public', 'Unlisted')
         AND cm."itemCount" > 0 AND c.id >= $1
       ORDER BY c.id ASC
       LIMIT $2`,
      cursor,
      CHUNK * CONCURRENCY
    );
    if (!rows.length) break;

    const ids = rows.map((r) => r.id);

    // Split into CHUNK-sized sub-batches and run in parallel.
    const subBatches: number[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) subBatches.push(ids.slice(i, i + CHUNK));
    await Promise.all(subBatches.map(runBatch));

    cursor = ids[ids.length - 1] + 1;
    processed += ids.length;
    const elapsed = (Date.now() - started) / 1000;
    const rate = processed / elapsed;
    const eta = (total - processed) / Math.max(rate, 0.1);
    console.log(
      `[scan] ${processed}/${total} (${((processed / total) * 100).toFixed(1)}%) ` +
        `rate=${rate.toFixed(0)}/s eta=${Math.round(eta / 60)}min cursor=${cursor}`
    );
  }

  console.log(`[backfill] done. processed=${processed}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
