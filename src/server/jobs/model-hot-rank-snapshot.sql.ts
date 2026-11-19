import { Prisma } from '@prisma/client';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  freePublishedVersionExistsSql,
  paidAccessLiveSql,
} from '~/server/services/paid-access-sql';

export const HOT_RANK_DAILY_TABLE = 'default.model_hot_rank_daily';
export const HOT_RANK_STAGING_TABLE = 'default.model_hot_rank_staging';
export const HOT_RANK_RUNS_TABLE = 'default.model_hot_rank_runs';

/**
 * Every model the Hot feed shows to some viewer who is not its owner: getModelsRaw's default status,
 * availability and Archived filters, a browsing level any viewer can pick (so unscanned and
 * Blocked-only models are out), and no TakenDown, which the model controller drops after the query.
 * Unscored models stay in: the feed shows them, first. Per-viewer filters (browsing level, poi,
 * minor, Hide Paid) are stored as columns, so a viewer's rank can be re-derived at read time.
 * model-hot-rank-snapshot.pglite.test.ts holds this to the feed.
 */
export const hotRankUniverseSql = Prisma.sql`mm.status = 'Published'::"ModelStatus"
    AND mm.availability <> 'Private'::"Availability"
    AND mm.mode IS NULL
    AND (mm."nsfwLevel" & ${allBrowsingLevelsFlag}) != 0`;

// One statement, so every rank comes from one snapshot: hotScore is rewritten every minute.
// ORDER BY matches the feed's, including DESC putting a NULL score first.
// One row of parallel arrays rather than ~780k row objects, to keep the job's memory small.
// CASE, not OR: only the few thousand gated models pay for the free-version probe.
export const hotRankSnapshotSql = Prisma.sql`
  WITH paid AS (
    SELECT mv."modelId", bool_or(pa."timeframeDays" IS NULL) AS permanent
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE ${paidAccessLiveSql}
    GROUP BY mv."modelId"
  ), snapshot AS (
    SELECT
      mm."modelId",
      mm."hotScore",
      mm."nsfwLevel",
      mm.availability::text AS availability,
      mm.poi,
      mm.minor,
      paid."modelId" IS NOT NULL AS paid,
      coalesce(paid.permanent, false) AS "paidPermanent",
      -- publicOnly, as the browse feed sets it (getModelsRaw's hidePrivateModels).
      CASE WHEN paid."modelId" IS NULL THEN true
        ELSE ${freePublishedVersionExistsSql(Prisma.sql`mm."modelId"`, { publicOnly: true })} END
        AS "hidePaidKeeps"
    FROM "ModelMetric" mm
    LEFT JOIN paid ON paid."modelId" = mm."modelId"
    WHERE ${hotRankUniverseSql}
  )
  SELECT
    coalesce(array_agg("modelId" ORDER BY "hotScore" DESC, "modelId"), '{}') AS "modelIds",
    coalesce(array_agg("hotScore" ORDER BY "hotScore" DESC, "modelId"), '{}') AS "hotScores",
    coalesce(array_agg("nsfwLevel" ORDER BY "hotScore" DESC, "modelId"), '{}') AS "nsfwLevels",
    coalesce(array_agg(availability ORDER BY "hotScore" DESC, "modelId"), '{}') AS availabilities,
    coalesce(array_agg(poi ORDER BY "hotScore" DESC, "modelId"), '{}') AS pois,
    coalesce(array_agg(minor ORDER BY "hotScore" DESC, "modelId"), '{}') AS minors,
    coalesce(array_agg(paid ORDER BY "hotScore" DESC, "modelId"), '{}') AS paids,
    coalesce(array_agg("paidPermanent" ORDER BY "hotScore" DESC, "modelId"), '{}') AS "paidPermanents",
    coalesce(array_agg("hidePaidKeeps" ORDER BY "hotScore" DESC, "modelId"), '{}') AS "hidePaidKeeps"
  FROM snapshot
`;

export type HotRankSnapshotArrays = {
  modelIds: number[];
  hotScores: (number | null)[];
  nsfwLevels: number[];
  availabilities: string[];
  pois: boolean[];
  minors: boolean[];
  paids: boolean[];
  paidPermanents: boolean[];
  hidePaidKeeps: boolean[];
};

export type HotRankRow = {
  day: string;
  modelId: number;
  rank: number;
  hotScore: number | null;
  nsfwLevel: number;
  availability: string;
  poi: number;
  minor: number;
  paid: number;
  paidPermanent: number;
  hidePaidKeeps: number;
};

/** Rows for one batch of the snapshot, ranks counted from 1 at the top of the whole snapshot. */
export function toHotRankRows(
  s: HotRankSnapshotArrays,
  day: string,
  start: number,
  end: number
): HotRankRow[] {
  const rows: HotRankRow[] = [];
  for (let i = start; i < Math.min(end, s.modelIds.length); i++) {
    rows.push({
      day,
      modelId: s.modelIds[i],
      rank: i + 1,
      hotScore: s.hotScores[i],
      nsfwLevel: s.nsfwLevels[i],
      availability: s.availabilities[i],
      poi: s.pois[i] ? 1 : 0,
      minor: s.minors[i] ? 1 : 0,
      paid: s.paids[i] ? 1 : 0,
      paidPermanent: s.paidPermanents[i] ? 1 : 0,
      hidePaidKeeps: s.hidePaidKeeps[i] ? 1 : 0,
    });
  }
  return rows;
}
