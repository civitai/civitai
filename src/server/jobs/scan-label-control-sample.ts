import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { SCAN_LABEL_MAX_ITEMS_PER_POST } from '~/server/services/scan-label-flag.service';
import { excludedImageRow } from './appeal-decision-records';
import { createJob } from './job';

export const CONTROL_STOCK = 30;
export const CONTROL_PER_RUN = 10;
export const CONTROL_PER_DAY = 60;
export const CONTROL_SAMPLE_VERSION = 'control-sample@2026-10-17';

const HOUR_MS = 3_600_000;
const WINDOW_MS = 72 * HOUR_MS;
// Skips images whose scans may still be in flight.
const SETTLE_MS = HOUR_MS;
const CANDIDATES_PER_SLOT = 4;

type Deps = {
  now?: Date;
  rng?: () => number;
  /** Whether the queue writer is enabled for this image; others are not sampled. */
  inRollout?: (imageId: number) => Promise<boolean>;
};

/** The id of the first image created at or after `cutoff`, or `fallback` when there is none. */
async function idCreatedSince(cutoff: Date, fallback: number) {
  const [row] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Image" WHERE "createdAt" >= ${cutoff} ORDER BY "createdAt" LIMIT 1
  `;
  return row?.id ?? fallback;
}

/**
 * Applied when choosing and again in the insert: an image can change in between.
 * A post at the queue writer's cap is skipped; its unqueued images are not known to be unflagged.
 */
const sampleable = (img: Prisma.Sql) => Prisma.sql`(
  ${img}."postId" IS NOT NULL
  AND ${img}.ingestion = 'Scanned'
  AND ${img}."needsReview" IS NULL
  AND ${img}."blockedFor" IS NULL
  AND NOT ${img}."tosViolation"
  AND ${img}."nsfwLevel" <> 32
  AND NOT COALESCE(${excludedImageRow(img)}, false)
  AND NOT EXISTS (
    SELECT 1 FROM "Image" sibling
    JOIN "ScanLabelItem" q ON q."imageId" = sibling.id
    WHERE sibling."postId" = ${img}."postId" AND (sibling.id = ${img}.id OR q.lane = 'control')
  )
  AND (
    SELECT count(*) FROM "Image" sibling
    JOIN "ScanLabelItem" q ON q."imageId" = sibling.id
    WHERE sibling."postId" = ${img}."postId" AND q.lane = 'flagged'
  ) < ${SCAN_LABEL_MAX_ITEMS_PER_POST}
)`;

/**
 * 🔴 Insert-only. In the candidate walk a createdAt bound makes the planner scan the createdAt index
 * for every draw instead of walking a few primary-key rows, and the job hits the statement timeout.
 */
const createdBetween = (img: Prisma.Sql, from: Date, until: Date) =>
  Prisma.sql`(${img}."createdAt" >= ${from} AND ${img}."createdAt" < ${until})`;

/**
 * Adds a random sample of recent uploads that nothing flagged to the control lane, topping it up to
 * `CONTROL_STOCK` open items within the per-run and per-day caps. At most one per post, ever.
 */
export async function feedScanLabelControlSample({
  now = new Date(),
  rng = Math.random,
  inRollout = (imageId) => isFlipt(FLIPT_FEATURE_FLAGS.SCAN_LABEL_QUEUE_WRITER, String(imageId)),
}: Deps = {}) {
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS);
  const [lane] = await dbWrite.$queryRaw<{ open: number; recent: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
      count(*) FILTER (WHERE "createdAt" > ${dayAgo})::int AS recent
    FROM "ScanLabelItem"
    WHERE lane = 'control'
  `;
  const want = Math.min(CONTROL_PER_RUN, CONTROL_STOCK - lane.open, CONTROL_PER_DAY - lane.recent);
  if (want <= 0) return { added: 0, ...lane };

  const [{ maxId }] = await dbWrite.$queryRaw<{ maxId: number | null }[]>`
    SELECT max(id) AS "maxId" FROM "Image"
  `;
  if (!maxId) return { added: 0, ...lane };
  const from = new Date(now.getTime() - WINDOW_MS);
  const until = new Date(now.getTime() - SETTLE_MS);
  const lo = await idCreatedSince(from, maxId + 1);
  // Bounds the walk only; each row's own createdAt decides.
  const hi = maxId + 1;
  if (hi <= lo) return { added: 0, ...lane };

  const starts = Array.from(
    { length: want * CANDIDATES_PER_SLOT },
    () => lo + Math.floor(rng() * (hi - lo))
  );
  const img = Prisma.raw('img');
  const candidates = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM (
      SELECT DISTINCT ON (c."postId") c.id, s.n
      FROM unnest(${starts}::int[]) WITH ORDINALITY AS s(start, n)
      CROSS JOIN LATERAL (
        SELECT img.id, img."postId"
        FROM "Image" img
        WHERE img.id >= s.start AND img.id < ${hi} AND ${sampleable(img)}
        ORDER BY img.id
        LIMIT 1
      ) c
      ORDER BY c."postId", s.n
    ) picked
    ORDER BY n
  `;

  const chosen: number[] = [];
  for (const { id } of candidates) {
    if (chosen.length >= want) break;
    if (await inRollout(id)) chosen.push(id);
  }
  if (!chosen.length) return { added: 0, ...lane };

  // An image queued meanwhile keeps its flagged item.
  const added = await dbWrite.$executeRaw`
    WITH item AS (
      INSERT INTO "ScanLabelItem" ("imageId", lane, "firstFlaggedAt", status, "createdAt")
      SELECT img.id, 'control', ${now}, 'open', ${now}
      FROM "Image" img
      WHERE img.id = ANY(${chosen}::int[])
        AND ${sampleable(img)}
        AND ${createdBetween(img, from, until)}
      ON CONFLICT ("imageId") DO NOTHING
      RETURNING id, "imageId"
    )
    INSERT INTO "ScanLabelFlag" ("itemId", source, "flaggerVersion", "workflowId", "flaggedAt", snapshot)
    SELECT item.id, 'control-sample', ${CONTROL_SAMPLE_VERSION}, 'control-sample:' || item."imageId",
      ${now}, jsonb_build_object('nsfwLevel', img."nsfwLevel")
    FROM item JOIN "Image" img ON img.id = item."imageId"
    ON CONFLICT ("workflowId") DO NOTHING
  `;
  return { added, ...lane };
}

export const scanLabelControlSampleJob = createJob(
  'scan-label-control-sample',
  '17 * * * *',
  async () => {
    try {
      return await feedScanLabelControlSample();
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'scan-label-control-sample',
        message: error instanceof Error ? error.message : 'Unknown error',
      }).catch(() => null);
      throw error;
    }
  }
);
