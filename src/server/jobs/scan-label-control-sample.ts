import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { SCAN_LABEL_MAX_ITEMS_PER_POST } from '~/server/services/scan-label-flag.service';
import { excludedImageRow } from './appeal-decision-records';
import { createJob } from './job';

/** Open control-lane items the feeder keeps on hand. */
export const CONTROL_STOCK = 30;
export const CONTROL_PER_RUN = 10;
/** Most control items added in any 24 hours. */
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
  /** Whether the queue writer covers this image; an image it never looked at was not passed. */
  inRollout?: (imageId: number) => Promise<boolean>;
};

/**
 * An id bound such that images from it on were created at or after `cutoff`, found by bisecting the
 * primary key; `maxId + 1` when none were.
 */
async function idSince(cutoff: Date, maxId: number): Promise<number> {
  const createdSince = async (id: number) => {
    const [row] = await dbWrite.$queryRaw<{ createdAt: Date }[]>`
      SELECT "createdAt" FROM "Image" WHERE id >= ${id} ORDER BY id LIMIT 1
    `;
    return !!row && row.createdAt >= cutoff;
  };
  if (!(await createdSince(maxId))) return maxId + 1;
  let lo = 0;
  let hi = maxId;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await createdSince(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Adds a random sample of recent uploads that nothing flagged to the control lane, topping it up to
 * `CONTROL_STOCK` open items within the per-run and per-day caps. One image per post, and none from a
 * post at the queue writer's cap, whose unqueued images may have been flagged and skipped.
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
  const lo = await idSince(new Date(now.getTime() - WINDOW_MS), maxId);
  const hi = await idSince(new Date(now.getTime() - SETTLE_MS), maxId);
  if (hi <= lo) return { added: 0, ...lane };

  const starts = Array.from(
    { length: want * CANDIDATES_PER_SLOT },
    () => lo + Math.floor(rng() * (hi - lo))
  );
  const img = Prisma.raw('img');
  // DISTINCT ON keeps one image per post: the first start (by draw order) that reached it.
  const candidates = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM (
      SELECT DISTINCT ON (c."postId") c.id, s.n
      FROM unnest(${starts}::int[]) WITH ORDINALITY AS s(start, n)
      CROSS JOIN LATERAL (
        SELECT img.id, img."postId"
        FROM "Image" img
        WHERE img.id >= s.start
          AND img.id < ${hi}
          AND img."postId" IS NOT NULL
          AND img.ingestion = 'Scanned'
          AND img."needsReview" IS NULL
          AND img."blockedFor" IS NULL
          AND NOT img."tosViolation"
          AND img."nsfwLevel" <> 32
          AND NOT COALESCE(${excludedImageRow(img)}, false)
          AND NOT EXISTS (SELECT 1 FROM "ScanLabelItem" own WHERE own."imageId" = img.id)
          AND (
            SELECT count(*) FROM "Image" sibling
            JOIN "ScanLabelItem" q ON q."imageId" = sibling.id
            WHERE sibling."postId" = img."postId"
          ) < ${SCAN_LABEL_MAX_ITEMS_PER_POST}
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

  // An image the writer queued meanwhile keeps its flagged item; the control flag is not added.
  const added = await dbWrite.$executeRaw`
    WITH item AS (
      INSERT INTO "ScanLabelItem" ("imageId", lane, "firstFlaggedAt", status, "createdAt")
      SELECT id, 'control', ${now}, 'open', ${now} FROM "Image" WHERE id = ANY(${chosen}::int[])
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
