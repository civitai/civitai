import { Prisma } from '@prisma/client';
import client from 'prom-client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  countImagesSql,
  countNextHour,
  MAX_HOURS_PER_RUN,
  WATERMARK_KEY,
  type VersionCount,
  type Watermark,
} from '~/server/metrics/model-image-count';
import { PROM_PREFIX } from '~/server/prom/client';
import { createJob } from './job';

const DRIFT_SAMPLE = 20;
/** Most versions have no images, so draw enough candidates to find 20 that do. */
const DRIFT_CANDIDATES = 400;
const DRIFT_SAMPLE_MAX_IRN_ROWS = 5_000;
const DRIFT_TOLERANCE = 0.05;
const DRIFT_HOUR_UTC = 6;

declare global {
  // eslint-disable-next-line no-var
  var modelImageCountDriftGauge: client.Gauge<string> | undefined;
}

/** Alert when this exceeds 2: the count has drifted from a fresh recount on more than a few versions. */
const driftGauge = (global.modelImageCountDriftGauge ??= new client.Gauge({
  name: `${PROM_PREFIX}model_image_count_drifted_versions`,
  help: `Versions, of a daily sample of ${DRIFT_SAMPLE}, whose imageCount is off a fresh recount by more than ${
    DRIFT_TOLERANCE * 100
  }%`,
}));

/**
 * Recounts a few small, recently active versions read-only and compares them with imageCount.
 * Over-counts from removals after an hour was counted are expected; a large or growing number
 * means the hourly count itself is wrong.
 */
async function sampleDrift() {
  const watermark = await dbRead.$queryRaw<{ value: Watermark }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${WATERMARK_KEY}
  `.then((r) => r[0]?.value);
  if (!watermark) return;
  // Candidates are drawn regardless of imageCount, so a version wrongly left at 0 can be sampled;
  // the capped IRN count keeps the small ones without ever walking a big version in full.
  const sample = await dbRead.$queryRaw<VersionCount[]>`
    SELECT s."modelVersionId", s.count FROM (
      SELECT "modelVersionId", "imageCount" AS count FROM "ModelVersionMetric"
      ORDER BY random() LIMIT ${DRIFT_CANDIDATES}
    ) s
    WHERE (
      SELECT count(*) FROM (
        SELECT 1 FROM "ImageResourceNew" ir WHERE ir."modelVersionId" = s."modelVersionId"
        LIMIT ${DRIFT_SAMPLE_MAX_IRN_ROWS + 1}
      ) capped
    ) BETWEEN 1 AND ${DRIFT_SAMPLE_MAX_IRN_ROWS}
    LIMIT ${DRIFT_SAMPLE}
  `;
  if (!sample.length) return;
  const ids = sample.map((s) => s.modelVersionId);
  const fresh = await dbRead.$queryRaw<VersionCount[]>(
    countImagesSql(
      Prisma.sql`ir."modelVersionId" = ANY(${ids}::int[]) AND p."publishedAt" < ${new Date(
        watermark.hour
      )}`
    )
  );
  const byId = new Map(fresh.map((f) => [f.modelVersionId, f.count]));
  const drifted = sample
    .map((s) => ({ ...s, recount: byId.get(s.modelVersionId) ?? 0 }))
    .filter((s) => Math.abs(s.count - s.recount) > DRIFT_TOLERANCE * Math.max(s.recount, 1));
  driftGauge.set(drifted.length);
  if (drifted.length)
    logToAxiom({
      type: 'warning',
      name: 'model-image-count-drift',
      message: `${drifted.length} of ${sample.length} sampled versions drifted`,
      payload: { drifted },
    });
}

/**
 * Hourly: counts each hour of published posts once, 24 hours after it closes, and adds it to
 * ModelVersionMetric.imageCount (model-image-count.ts). The 1-minute model metric job rolls the
 * changed rows up to ModelMetric and ModelBaseModelMetric. Inert until the backfill's finalize
 * writes the watermark; paused while the watermark says so.
 */
export const updateModelImageCountsJob = createJob(
  'update-model-image-counts',
  '7 * * * *',
  async (ctx) => {
    const hours = [];
    let skipped: string | undefined;
    for (let i = 0; i < MAX_HOURS_PER_RUN; i++) {
      ctx.checkIfCanceled();
      const result = await countNextHour();
      if ('skipped' in result) {
        skipped = result.skipped;
        break;
      }
      hours.push(result);
    }
    // Whatever the count did, so the gauge never keeps yesterday's value through a pause.
    if (new Date().getUTCHours() === DRIFT_HOUR_UTC) await sampleDrift();
    return { hours, skipped };
  },
  { lockExpiration: 30 * 60 }
);
