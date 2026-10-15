import type { PrismaClient } from '@prisma/client';
import { chunk, partition } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { templateHandler } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { CreatorScoreUnlock } from '~/shared/utils/creator-score-unlocks';
import { CREATOR_SCORE_CATEGORIES } from '~/shared/utils/creator-score';
import { REPORTS_AGAINST_EVENT } from '~/shared/constants/creator-journey.constants';
import {
  countRemovalsByOwner,
  getOwnersWithReversalsSince,
  reportsAgainstScore,
} from '~/server/services/creator-removals.service';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
  getCreatorScoreUnlocks,
} from '~/server/services/creator-score-unlocks.service';
import type {
  ScoreTierCrossing,
  ScoreTotalTransition,
} from '~/server/services/creator-milestone-grant.service';
import {
  grantScoreTierMilestones,
  markMilestonesSeen,
  notifyScoreTierCrossings,
} from '~/server/services/creator-milestone-grant.service';
import { isMilestoneAnnounced } from '~/server/services/creator-milestone-registry';
import { alertNewLegends } from '~/server/services/creator-legend-alert.service';
import {
  CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG,
  creatorJourneyAudience,
} from '~/server/services/creator-journey-flag.service';
import { allInjectableResourceIds } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';
import type { JobContext } from './job';
import { createJob, getJobDate } from './job';
import { userUpdateCounter } from '~/server/prom/client';

const BATCH_SIZE = 500;
const log = createLogger('update-user-score');
const jobKey = 'update-user-score';
export const updateUserScore = createJob(
  jobKey,
  '55 23 * * *',
  async (jobContext) => {
    if (!clickhouse) return;

    // Build Context
    //-------------------------------------
    // Legacy combined checkpoint. Seeds each per-category checkpoint on first run
    // after this change so the cutover doesn't rescan from epoch; ignored once the
    // per-category keys exist and own their own progress.
    const [legacyLastUpdate] = await getJobDate(jobKey);
    const ctx: Context = {
      db: dbWrite,
      ch: clickhouse,
      pg: pgDbWrite,
      jobContext,
      scoreMultipliers: await getScoreMultipliers(),
      lastUpdate: legacyLastUpdate,
      toUpdate: {},
      tierUnlocks: [],
      tierGrantErrors: [],
      setScore: (id, category, score) => {
        if (!ctx.toUpdate[id]) ctx.toUpdate[id] = {};
        ctx.toUpdate[id][category] = Number(score);
      },
    };

    // Update scores
    //-------------------------------------
    // Each category advances its own checkpoint. A fetcher that throws is isolated:
    // its checkpoint stays frozen (retried next run) while the others still persist
    // and advance — one broken category can't freeze all six (as images did nightly
    // from 2026-06-22). Failures are collected and re-thrown after the good work is
    // committed, so the run still surfaces as failed for alerting.
    const advanceCheckpoint: Array<() => Promise<void>> = [];
    const failures: Array<{ category: string; error: unknown }> = [];
    for (const [category, fetcher] of Object.entries(scoreFetchers)) {
      const [lastUpdate, setLastUpdate] = await getJobDate(
        checkpointKey(category),
        legacyLastUpdate
      );
      ctx.lastUpdate = lastUpdate;
      try {
        log('getting score', category);
        await fetcher(ctx);
        advanceCheckpoint.push(setLastUpdate);
      } catch (e) {
        log('score category failed; leaving its checkpoint frozen', category, e);
        failures.push({ category, error: e });
      }
    }

    try {
      ctx.tierUnlocks = await getCreatorScoreUnlocks();
    } catch (e) {
      failures.push({ category: 'tierUnlocks', error: e });
      ctx.tierUnlocks = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);
    }

    // Update score totals
    //-------------------------------------
    const totalTasks = await getUpdateTotalTasks(ctx);
    log('updating scores', Object.keys(ctx.toUpdate).length, 'batches', totalTasks.length);
    await limitConcurrency(totalTasks, 5);

    // Advance only the categories that fetched cleanly, and only after their scores
    // are persisted. NB: a crash in this gap re-runs the window next time — a no-op
    // for the five absolute categories, but a double-count for the incremental
    // `images` category (see getImageScore). Accepted; force-backfill reconciles.
    for (const setLastUpdate of advanceCheckpoint) await setLastUpdate();

    await settleTierGrants(ctx.tierGrantErrors, failures, async () => {
      const [, setTierGrantsCheckpoint] = await getJobDate(checkpointKey(TIER_GRANTS_CHECKPOINT));
      await setTierGrantsCheckpoint();
    });

    // Re-throw so the run still surfaces as failed. Each category's original stack
    // is embedded into the thrown error's own stack: the job runner logs
    // `error.stack` to Axiom (job.ts) and ignores `.cause`/AggregateError.errors,
    // so embedding is the only way the real failure site survives.
    if (failures.length) {
      const summary = `update-user-score: ${failures.length} categor${
        failures.length > 1 ? 'ies' : 'y'
      } failed (${failures.map((f) => f.category).join(', ')})`;
      const err = new Error(summary);
      err.stack = [
        summary,
        ...failures.map(({ category, error }) => {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          return `\n--- ${category} ---\n${detail}`;
        }),
      ].join('');
      throw err;
    }
  },
  {
    lockExpiration: 30 * 60,
    queue: 'metrics',
  }
);

type Context = {
  db: PrismaClient;
  ch: CustomClickHouseClient;
  pg: AugmentedPool;
  jobContext: JobContext;
  scoreMultipliers: ScoreMultipliers;
  toUpdate: Record<number, Partial<Record<ScoreCategory, number>>>;
  setScore: (id: number, category: ScoreCategory, score: number) => void;
  lastUpdate: Date;
  tierUnlocks: CreatorScoreUnlock[];
  tierGrantErrors: unknown[];
};

const scoreFetchers = {
  models: getModelScore,
  articles: getArticleScore,
  users: getUserScore,
  reportsActioned: getReportedActionedScore,
  reportsAgainst: getReportAgainstScore,
  images: getImageScore,
} as const;

const TIER_GRANTS_CHECKPOINT = 'tierGrants';
const checkpointKey = (name: string) => `${jobKey}:${name}`;

/**
 * One per category, advanced only by a run in which that category scored cleanly, plus one advanced
 * only by a run in which every tier grant succeeded.
 */
export const userScoreCheckpointKeys = [...Object.keys(scoreFetchers), TIER_GRANTS_CHECKPOINT].map(
  checkpointKey
);

// A model taken down by anyone but its owner stops counting; one the owner unpublished or deleted
// keeps its points. A missing actor counts as the owner: nothing shows a moderator acted.
const unpublishedByOther = `COALESCE(m.meta->>'unpublishedBy' <> m."userId"::text, false)`;
const LIVE_MODEL_COUNTS = `(m.status IN ('Published', 'Scheduled')
  OR (m.status = 'Unpublished' AND NOT ${unpublishedByOther}))`;
// An owner can delete a model a moderator already took down, so a delete keeps only what the model
// held when it was deleted: `statusAtDelete` where the delete recorded it, else the takedown marks.
const DELETED_MODEL_COUNTS = `(m.status = 'Deleted'
  AND COALESCE(m."deletedBy" = m."userId", true)
  AND CASE WHEN m.meta ? 'statusAtDelete'
    THEN m.meta->>'statusAtDelete' IN ('Published', 'Scheduled')
      OR (m.meta->>'statusAtDelete' = 'Unpublished' AND NOT ${unpublishedByOther})
    ELSE NOT (m.meta ? 'unpublishedReason') AND NOT ${unpublishedByOther}
  END)`;
export const MODEL_COUNTS_TOWARD_SCORE = `(${LIVE_MODEL_COUNTS} OR ${DELETED_MODEL_COUNTS})`;

export async function getModelScore(ctx: Context) {
  const refreshed = await refreshRecentSelfGenerations(ctx);
  await scoreModelOwners(ctx, { alsoRescore: refreshed });
}

type SelfGenerationRow = { modelId: number; userId: number; generationCount: number };

/**
 * The `models` score of every owner whose models changed since `lastUpdate`, plus `alsoRescore`.
 * `selfGenerations` replaces the stored self-generation table, so a dry run can score rows it has
 * not written.
 */
export async function scoreModelOwners(
  ctx: Pick<Context, 'pg' | 'jobContext' | 'scoreMultipliers' | 'lastUpdate' | 'setScore'>,
  {
    alsoRescore = [],
    selfGenerations,
  }: { alsoRescore?: number[]; selfGenerations?: SelfGenerationRow[] } = {}
) {
  const { reviews, downloads, generations } = ctx.scoreMultipliers.models;
  const selfSource = selfGenerations
    ? `(SELECT * FROM jsonb_to_recordset('${JSON.stringify(
        selfGenerations.map(({ modelId, userId, generationCount }) => ({
          modelId: +modelId,
          userId: +userId,
          generationCount: +generationCount,
        }))
      )}') AS x("modelId" int, "userId" int, "generationCount" bigint))`
    : `"ModelSelfGeneration"`;
  // A takedown writes `Model`, not `ModelMetric`, so owners whose models changed are re-scored too.
  // Every model of a re-scored owner is summed, so one who no longer has any counting model gets 0.
  await getScores(ctx, 'models')`
    WITH changed AS (
      SELECT "userId" FROM "ModelMetric" WHERE "updatedAt" > '${ctx.lastUpdate}'
      UNION
      SELECT "userId" FROM "Model"
      WHERE "updatedAt" > '${ctx.lastUpdate}' OR "deletedAt" > '${ctx.lastUpdate}'
      UNION
      SELECT unnest('{${alsoRescore.map(Number).join(',')}}'::int[])
    )
    SELECT
      s."userId",
      (
          COALESCE(SUM(s."thumbsUpCount") FILTER (WHERE s.counts), 0) * ${reviews}
        + COALESCE(SUM(s."downloadCount") FILTER (WHERE s.counts), 0) * ${downloads}
        + COALESCE(SUM(GREATEST(s."generationCount" - s."selfGenerations", 0)) FILTER (WHERE s.counts), 0) * ${generations}
      ) as score
    FROM (
      SELECT mm."userId", mm."thumbsUpCount", mm."downloadCount", mm."generationCount",
        COALESCE(sg."generationCount", 0) AS "selfGenerations",
        ${MODEL_COUNTS_TOWARD_SCORE} AS counts
      FROM "ModelMetric" mm
      JOIN "Model" m ON m.id = mm."modelId"
      LEFT JOIN ${selfSource} sg ON sg."modelId" = mm."modelId" AND sg."userId" = m."userId"
      WHERE mm."userId" IN (SELECT "userId" FROM changed)
    ) s
    GROUP BY 1
  `;
}

// Job rows can reach ClickHouse well after their `createdAt`; a re-read owner is just recounted.
const SELF_GENERATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Recounts the self-generations of every owner who generated with one of their own models since
 * `lastUpdate`, and returns those owners.
 */
async function refreshRecentSelfGenerations(ctx: Context) {
  const since = new Date(ctx.lastUpdate.getTime() - SELF_GENERATION_LOOKBACK_MS);
  const pairs = await ctx.ch.$query<{ userId: number; modelVersionId: number }>`
    SELECT DISTINCT userId, r AS modelVersionId
    FROM orchestration.jobs
    ARRAY JOIN resourcesUsed AS r
    WHERE createdAt > ${since} AND length(resourcesUsed) > 0
  `;
  const versionOwners = await getVersionOwners(
    ctx.pg,
    pairs.map((p) => Number(p.modelVersionId))
  );
  const owners = [
    ...new Set(
      pairs
        .filter((p) => versionOwners.get(Number(p.modelVersionId))?.userId === Number(p.userId))
        .map((p) => Number(p.userId))
    ),
  ];
  for (const batch of chunk(owners, SELF_GENERATION_OWNER_BATCH)) {
    const rows = await countSelfGenerations(ctx.ch, ctx.pg, batch);
    await writeSelfGenerations(ctx.pg, batch, rows);
  }
  return owners;
}

// A lifetime count scans all of `orchestration.jobs` whatever the owner count, so keep batches wide.
export const SELF_GENERATION_OWNER_BATCH = 5000;

const injectedVersionIds = new Set<number>(allInjectableResourceIds);

/** Each version's model and owner, leaving out injected versions, which no score counts. */
async function getVersionOwners(pg: AugmentedPool, versionIds: number[]) {
  const owners = new Map<number, { modelId: number; userId: number }>();
  const ids = [...new Set(versionIds)].filter((id) => id > 0 && !injectedVersionIds.has(id));
  for (const batch of chunk(ids, 10000)) {
    const query = await pg.cancellableQuery<{ id: number; modelId: number; userId: number }>(
      `SELECT mv.id, mv."modelId", m."userId"
       FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
       WHERE mv.id = ANY($1::int[])`,
      [batch]
    );
    for (const { id, modelId, userId } of await query.result()) owners.set(id, { modelId, userId });
  }
  return owners;
}

/**
 * Every image each of `ownerIds` generated with their own models, over all time, per model. Counts
 * images the way `orchestration.daily_resource_generation_counts` (the source of
 * `ModelMetric.generationCount`) does.
 */
export async function countSelfGenerations(
  ch: CustomClickHouseClient,
  pg: AugmentedPool,
  ownerIds: number[]
): Promise<SelfGenerationRow[]> {
  if (!ownerIds.length) return [];
  const generated = await ch.$query<{ userId: number; modelVersionId: number; images: number }>`
    SELECT userId, r AS modelVersionId, sum(coalesce(blobsCount, 1)) AS images
    FROM orchestration.jobs
    ARRAY JOIN resourcesUsed AS r
    WHERE userId IN (${ownerIds})
    GROUP BY userId, r
  `;
  const versionOwners = await getVersionOwners(
    pg,
    generated.map((g) => Number(g.modelVersionId))
  );
  return selfGenerationsByModel(generated, versionOwners);
}

export function selfGenerationsByModel(
  generated: { userId: number; modelVersionId: number; images: number }[],
  versionOwners: Map<number, { modelId: number; userId: number }>
): SelfGenerationRow[] {
  const byModel = new Map<number, SelfGenerationRow>();
  for (const { userId, modelVersionId, images } of generated) {
    const owner = versionOwners.get(Number(modelVersionId));
    if (!owner || owner.userId !== Number(userId)) continue;
    const row = byModel.get(owner.modelId) ?? {
      modelId: owner.modelId,
      userId: owner.userId,
      generationCount: 0,
    };
    row.generationCount += Number(images);
    byModel.set(owner.modelId, row);
  }
  return [...byModel.values()];
}

/** Replaces every stored self-generation row of `ownerIds` with `rows`. */
export async function writeSelfGenerations(
  pg: AugmentedPool,
  ownerIds: number[],
  rows: SelfGenerationRow[]
) {
  if (!ownerIds.length) return;
  const stampedAt = new Date().toISOString();
  await pg
    .cancellableQuery(
      `INSERT INTO "ModelSelfGeneration" ("modelId", "userId", "generationCount", "updatedAt")
       SELECT * , $4::timestamp FROM unnest($1::int[], $2::int[], $3::bigint[])
       ON CONFLICT ("modelId", "userId") DO UPDATE
         SET "generationCount" = EXCLUDED."generationCount", "updatedAt" = EXCLUDED."updatedAt"`,
      [
        rows.map((r) => r.modelId),
        rows.map((r) => r.userId),
        rows.map((r) => r.generationCount),
        stampedAt,
      ]
    )
    .then((q) => q.result());
  await pg
    .cancellableQuery(
      `DELETE FROM "ModelSelfGeneration"
       WHERE "userId" = ANY($1::int[])
         AND ("modelId", "userId") NOT IN (SELECT * FROM unnest($2::int[], $3::int[]))`,
      [ownerIds, rows.map((r) => r.modelId), rows.map((r) => r.userId)]
    )
    .then((q) => q.result());
}

async function getArticleScore(ctx: Context) {
  await getScores(ctx, 'articles')`
    SELECT
      "userId",
      (
          SUM(am."viewCount") * ${ctx.scoreMultipliers.articles.views}
        + SUM(am."commentCount") * ${ctx.scoreMultipliers.articles.comments}
        + SUM(am."likeCount"+am."heartCount"+am."laughCount"+am."cryCount") * ${ctx.scoreMultipliers.articles.reactions}
      ) as score
    FROM "ArticleMetric" am
    JOIN "Article" a ON a.id = am."articleId"
    WHERE am.timeframe = 'AllTime'
    GROUP BY 1
    HAVING BOOL_OR(am."updatedAt" > '${ctx.lastUpdate}')
  `;
}

// Incremental image score: fold each affected owner's engagement DELTA since the
// last run onto their stored `images` score. Work scales with the images that
// changed (~hundreds of thousands/day), NOT with each owner's full catalog (the
// old full-recompute read tens of millions of `Image` rows nightly and timed the
// job out).
//
// NOT idempotent (unlike the five absolute-recompute categories, whose replay is
// a no-op): a run writes `stored + delta` and only advances the images checkpoint
// AFTER persistence, so a crash between the User write and the checkpoint upsert
// re-applies the same delta window next run (double count). Accepted per the
// incident decision — a full recompute (`admin/temp/backfill-image-scores?force=true`)
// re-establishes the baseline.
/**
 * When the nightly `images` score started leaving out owners' own engagement: the checkpoint its
 * first such run read from. The one-off recompute subtracts own engagement from before it only.
 */
export const SELF_EXCLUSION_SINCE_KEY = `${jobKey}:selfExclusionSince`;

export async function getImageScore(ctx: Context) {
  await ctx.pg
    .cancellableQuery(
      `INSERT INTO "KeyValue" (key, value) VALUES ($1, to_jsonb($2::bigint)) ON CONFLICT (key) DO NOTHING`,
      [SELF_EXCLUSION_SINCE_KEY, ctx.lastUpdate.getTime()]
    )
    .then((q) => q.result());
  // 1. Net engagement delta per image and acting user since the checkpoint.
  // `metricValue` is signed (un-likes / removed comments are negative), so this is
  // the exact change in each image's reaction/comment totals — no catalog read
  // needed. The actor is kept so the owner's own engagement can be left out.
  const deltas = await ctx.ch.$query<ImageEngagementDelta>`
    SELECT entityId AS imageId, userId,
      sumIf(metricValue, metricType IN ('Like', 'Heart', 'Laugh', 'Cry')) AS dReactions,
      sumIf(metricValue, metricType = 'commentCount') AS dComments
    FROM entityMetricEvents_month
    WHERE entityType = 'Image'
    AND metricType IN ('Like', 'Heart', 'Laugh', 'Cry', 'commentCount')
    AND createdAt > ${ctx.lastUpdate}
    GROUP BY entityId, userId
    HAVING dReactions != 0 OR dComments != 0
  `;
  if (!deltas.length) return;

  // 2. Map each changed image to its owner (Postgres authoritative; deleted images
  // and null owners drop out) and roll deltas up per owner, ONE 10k-image batch at
  // a time. A single owner map over every changed image could grow unbounded if the
  // checkpoint ever froze for a wide window — the same V8 Map-cap failure class that
  // first broke this job. Batching keeps each owner map small; only the per-owner
  // accumulator (bounded by affected owners) survives across batches.
  const scoreDeltaByUser = new Map<number, number>();
  for (const batch of chunk(deltas, 10000)) {
    const ids = [...new Set(batch.map((d) => d.imageId))];
    const query = await ctx.pg.cancellableQuery<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM "Image" WHERE id = ANY($1::int[]) AND "userId" IS NOT NULL`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    const ownerByImage = new Map<number, number>();
    for (const { id, userId } of await query.result()) ownerByImage.set(id, userId);
    for (const [userId, delta] of rollupImageScoreDeltas(
      batch,
      ownerByImage,
      ctx.scoreMultipliers.images
    )) {
      scoreDeltaByUser.set(userId, (scoreDeltaByUser.get(userId) ?? 0) + delta);
    }
  }
  if (!scoreDeltaByUser.size) return;

  // 3. Fold each delta onto the owner's stored images score -> new absolute value,
  // handed to the shared persist path (which recomputes `total`).
  const userIds = [...scoreDeltaByUser.keys()];
  for (const ids of chunk(userIds, 5000)) {
    const query = await ctx.pg.cancellableQuery<{ id: number; images: string | null }>(
      `SELECT id, (meta->'scores'->>'images') AS images FROM "User" WHERE id = ANY($1::int[])`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    const stored = new Map<number, number>();
    for (const { id, images } of await query.result()) stored.set(id, images ? Number(images) : 0);

    const partialDelta = new Map(ids.map((id) => [id, scoreDeltaByUser.get(id) ?? 0]));
    for (const [userId, score] of foldImageDeltasOntoStored(partialDelta, stored)) {
      ctx.setScore(userId, 'images', score);
    }
  }
}

export type ImageEngagementDelta = {
  imageId: number;
  /** Who reacted or commented. */
  userId: number;
  dReactions: number;
  dComments: number;
};

// Roll per-image engagement deltas up per owner. Images missing from
// `ownerByImage` (deleted, or null userId) are dropped — their owner can't be
// credited, which also keeps deleted-image engagement out of the delta window.
export function rollupImageScoreDeltas(
  deltas: ImageEngagementDelta[],
  ownerByImage: Map<number, number>,
  multipliers: { reactions: number; comments: number }
): Map<number, number> {
  const byUser = new Map<number, number>();
  for (const { imageId, userId: actorId, dReactions, dComments } of deltas) {
    const userId = ownerByImage.get(Number(imageId));
    if (!userId || userId === Number(actorId)) continue;
    const delta =
      Number(dReactions) * multipliers.reactions + Number(dComments) * multipliers.comments;
    byUser.set(userId, (byUser.get(userId) ?? 0) + delta);
  }
  return byUser;
}

// New absolute images score = stored (or 0) + this run's delta. Keeps `images`
// in the shared absolute-score persist path so `total` is recomputed there.
export function foldImageDeltasOntoStored(
  scoreDeltaByUser: Map<number, number>,
  storedByUser: Map<number, number>
): Map<number, number> {
  const result = new Map<number, number>();
  for (const [userId, delta] of scoreDeltaByUser) {
    result.set(userId, (storedByUser.get(userId) ?? 0) + delta);
  }
  return result;
}

async function getUserScore(ctx: Context) {
  await getScores(ctx, 'users')`
    SELECT
      "userId",
      "followerCount" * ${ctx.scoreMultipliers.users.followers} as score
    FROM "UserMetric"
    WHERE "updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime'
  `;
}

async function getReportedActionedScore(ctx: Context) {
  await getScores(ctx, 'reportsActioned')`
    SELECT
      "userId",
      COUNT(id) * ${ctx.scoreMultipliers.reportsActioned} as score
    FROM "Report"
    WHERE status = 'Actioned'
    GROUP BY 1
    HAVING BOOL_OR("statusSetAt" > '${ctx.lastUpdate}')
  `;
}

// Absolute per owner, so every re-scored owner is set, including to 0 once nothing counts.
export async function getReportAgainstScore(
  ctx: Pick<Context, 'ch' | 'lastUpdate' | 'scoreMultipliers' | 'setScore'>
) {
  const removed = await ctx.ch.$query<{ ownerId: number }>`
    SELECT DISTINCT ownerId
    FROM images
    WHERE type = '${REPORTS_AGAINST_EVENT}'
    AND time > ${ctx.lastUpdate}
  `;
  const owners = [
    ...new Set([
      ...removed.map((r) => Number(r.ownerId)),
      ...(await getOwnersWithReversalsSince(ctx.ch, ctx.lastUpdate)),
    ]),
  ];

  const violations = await countRemovalsByOwner(ctx.ch, owners);
  for (const id of owners) {
    const score = reportsAgainstScore(violations.get(id), ctx.scoreMultipliers.reportsAgainst);
    ctx.setScore(id, 'reportsAgainst', score);
  }
}

async function getUpdateTotalTasks(ctx: Context) {
  return chunk(Object.entries(ctx.toUpdate), BATCH_SIZE).map(
    (records) => () => persistScoreBatch(ctx, records)
  );
}

export async function settleTierGrants(
  tierGrantErrors: unknown[],
  failures: { category: string; error: unknown }[],
  advanceCheckpoint: () => Promise<void>
) {
  if (tierGrantErrors.length) failures.push({ category: 'tierGrants', error: tierGrantErrors[0] });
  else await advanceCheckpoint();
}

export async function persistScoreBatch(
  ctx: Pick<Context, 'pg' | 'jobContext' | 'tierUnlocks' | 'tierGrantErrors'>,
  records: [string, Partial<Record<ScoreCategory, number>>][],
  options: { grantsRequireFlag?: boolean; now?: Date } = {}
) {
  ctx.jobContext.checkIfCanceled();
  const onCancel = (cancel: () => Promise<void>) => ctx.jobContext.on('cancel', cancel);
  const transitions = await applyUserScoreUpdates(ctx.pg, records, onCancel);
  userUpdateCounter?.inc({ location: 'job:update-user-score' }, records.length);
  await grantScoreTierCrossings(ctx, transitions, { ...options, onCancel });
}

/**
 * Tier grants, notifications and Legend alerts for totals already written. Scores are committed by
 * then, so a failed grant is pushed onto `tierGrantErrors` rather than thrown: the next run that
 * touches these users grants silently, and the backfill endpoint reconciles everyone else.
 */
export async function grantScoreTierCrossings(
  ctx: Pick<Context, 'pg' | 'tierUnlocks' | 'tierGrantErrors'>,
  transitions: ScoreTotalTransition[],
  {
    grantsRequireFlag = CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG,
    now = new Date(),
    onCancel,
  }: {
    grantsRequireFlag?: boolean;
    now?: Date;
    onCancel?: (cancel: () => Promise<void>) => void;
  } = {}
) {
  let crossings: ScoreTierCrossing[];
  let audience: Set<number>;
  try {
    audience = await creatorJourneyAudience(
      ctx.pg,
      transitions.map((t) => t.userId)
    );
    const grantable = grantsRequireFlag
      ? transitions.filter((t) => audience.has(t.userId))
      : transitions;
    crossings = await grantScoreTierMilestones(ctx.pg, grantable, onCancel);
  } catch (e) {
    log('tier grant failed for batch', e);
    ctx.tierGrantErrors.push(e);
    return;
  }
  const audienceCrossings = crossings.filter((crossing) => audience.has(crossing.userId));
  const [announced, silenced] = partition(audienceCrossings, (crossing) =>
    isMilestoneAnnounced(crossing.milestoneKey, now)
  );
  try {
    await markMilestonesSeen(ctx.pg, silenced, onCancel);
  } catch (e) {
    log('marking silent tier grants seen failed for batch', e);
    ctx.tierGrantErrors.push(e);
  }
  // Notified here rather than after the run: a re-run's ON CONFLICT never returns these again.
  await notifyScoreTierCrossings(announced, ctx.tierUnlocks);
  // Staff hear about every alerted crossing, including one whose user-facing announcement is silenced.
  await alertNewLegends(audienceCrossings).catch((e) => log('new-legend alert failed', e));
}

// total = sum of `CREATOR_SCORE_CATEGORIES`: the supplied value if present, else the stored
// one, so a category this run did not fetch (`staffAwarded`) is carried forward. Returns each
// user's total before and after; `prev` is a self-join, so it reads the pre-update row.
export async function applyUserScoreUpdates(
  pg: AugmentedPool,
  records: [string, Partial<Record<ScoreCategory, number>>][],
  onCancel?: (cancel: () => Promise<void>) => void,
  options: { stamp?: ScoreStamp } = {}
): Promise<ScoreTotalTransition[]> {
  if (!records.length) return [];

  const updateQuery = await pg.cancellableQuery<UserScoreUpdateRow>(
    userScoreUpdateSql(records, options)
  );
  onCancel?.(updateQuery.cancel);
  return toScoreTotalTransitions(await updateQuery.result());
}

export type UserScoreUpdateRow = {
  userId: number;
  oldTotal: unknown;
  newTotal: unknown;
};

export function toScoreTotalTransitions(rows: UserScoreUpdateRow[]): ScoreTotalTransition[] {
  return rows.map((row) => ({
    userId: row.userId,
    oldTotal: row.oldTotal == null ? null : Number(row.oldTotal),
    newTotal: Number(row.newTotal),
  }));
}

const totalSql = (scores: string) =>
  CREATOR_SCORE_CATEGORIES.map(
    (category) =>
      `COALESCE((${scores}->>'${category}')::numeric, (u.meta->'scores'->>'${category}')::numeric, 0)`
  ).join(' + ');

/** `meta.scores` keys set to one timestamp in the same statement as a score write. */
export type ScoreStamp = { keys: readonly string[]; at: Date };

function stampSql(stamp: ScoreStamp | undefined) {
  if (!stamp) return '';
  const at = stamp.at.toISOString();
  return ` || jsonb_build_object(${stamp.keys
    .map((key) => {
      if (!/^[A-Za-z]+$/.test(key)) throw new Error(`invalid score stamp key: ${key}`);
      return `'${key}', '${at}'`;
    })
    .join(', ')})`;
}

// Interpolated into SQL: records must hold only numeric scores.
export function userScoreUpdateSql(
  records: [string, Partial<Record<ScoreCategory, number>>][],
  { stamp }: { stamp?: ScoreStamp } = {}
) {
  const dataJson = JSON.stringify(records.map(([id, scores]) => ({ id: +id, scores })));
  return `
    WITH scores AS (SELECT * FROM jsonb_to_recordset('${dataJson}') AS x("id" int, "scores" jsonb))
    UPDATE "User" u
      SET meta = jsonb_set(COALESCE(u.meta, '{}'), '{scores}', COALESCE(u.meta->'scores', '{}') || s.scores || jsonb_build_object('total',
          ${totalSql('s.scores')}
        )${stampSql(stamp)}
      )
    FROM scores s
    JOIN "User" prev ON prev.id = s.id
    WHERE s.id = u.id
    RETURNING
      u.id AS "userId",
      (prev.meta->'scores'->>'total')::numeric AS "oldTotal",
      (u.meta->'scores'->>'total')::numeric AS "newTotal";
  `;
}

/**
 * Takes `points` off each owner's `images` score (never below zero) and stamps `stampKey`, skipping
 * owners already stamped. The score is read from the row being updated, so a write that lands
 * between a caller's read and this one is kept, and two runs cannot both subtract.
 */
export async function subtractImagesScores(
  pg: AugmentedPool,
  rows: [number, number][],
  stamp: { key: string; at: Date }
): Promise<ScoreTotalTransition[]> {
  if (!rows.length) return [];
  const dataJson = JSON.stringify(rows.map(([id, points]) => ({ id: +id, points: +points })));
  const stampKey = stamp.key;
  if (!/^[A-Za-z]+$/.test(stampKey)) throw new Error(`invalid score stamp key: ${stampKey}`);
  const scores = `jsonb_build_object('images', GREATEST(COALESCE((u.meta->'scores'->>'images')::numeric, 0) - d.points, 0))`;
  const query = await pg.cancellableQuery<UserScoreUpdateRow>(`
    WITH d AS (SELECT * FROM jsonb_to_recordset('${dataJson}') AS x("id" int, "points" numeric))
    UPDATE "User" u
      SET meta = jsonb_set(COALESCE(u.meta, '{}'), '{scores}', COALESCE(u.meta->'scores', '{}') || ${scores} || jsonb_build_object('total',
          ${totalSql(scores)}
        )${stampSql({ keys: [stampKey], at: stamp.at })}
      )
    FROM d
    JOIN "User" prev ON prev.id = d.id
    WHERE d.id = u.id AND (u.meta->'scores'->>'${stampKey}') IS NULL
    RETURNING
      u.id AS "userId",
      (prev.meta->'scores'->>'total')::numeric AS "oldTotal",
      (u.meta->'scores'->>'total')::numeric AS "newTotal";
  `);
  return toScoreTotalTransitions(await query.result());
}

// #region [helpers]
type ScoreMultipliers = {
  models: {
    reviews: number;
    downloads: number;
    generations: number;
  };
  articles: {
    views: number;
    comments: number;
    reactions: number;
  };
  images: {
    views: number;
    comments: number;
    reactions: number;
  };
  users: {
    followers: number;
  };
  reportsActioned: number;
  reportsAgainst: number;
};
export type ScoreCategory = keyof ScoreMultipliers | 'staffAwarded' | 'total';

// The multipliers live in the `system:user-score-multipliers` key, stored both
// in sysRedis (legacy/hot-override) and PG `KeyValue` (durable). Same key string
// for both stores.
const USER_SCORE_MULTIPLIERS_KEY = REDIS_SYS_KEYS.SYSTEM.USER_SCORE_MULTIPLIERS;

// Hardcoded last-resort default. Recovered 2026-06-22 after the sysRedis instance
// was wiped ~2026-05-14, which dropped the only copy of these values and silently
// killed this job for ~39 nights (it threw on the missing key before any category
// ran). Reverse-engineered from frozen `User.meta.scores`: 5/6 categories exact;
// articles.comments/reactions are a best-estimate (~5% noise). Prefer the values
// in redis/KeyValue over these once re-seeded.
const DEFAULT_SCORE_MULTIPLIERS: ScoreMultipliers = {
  models: { reviews: 10, downloads: 1, generations: 1 },
  articles: { views: 1, comments: 25, reactions: 10 },
  images: { views: 0, comments: 20, reactions: 10 },
  users: { followers: 50 },
  reportsActioned: 50,
  reportsAgainst: -1000,
};

// Defense in depth so a single wiped/offline store can never freeze all user
// scores again: sysRedis (hot override) -> PG KeyValue (durable) -> hardcoded
// default. Each read is guarded so an ERROR (e.g. redis client offline), not just
// a miss, falls through to the next source.
export async function getScoreMultipliers(): Promise<ScoreMultipliers> {
  try {
    const fromRedis = await sysRedis.packed.get<ScoreMultipliers>(USER_SCORE_MULTIPLIERS_KEY);
    if (fromRedis) return fromRedis;
  } catch (e) {
    log('score multipliers: sysRedis read failed, falling back to KeyValue', (e as Error).message);
  }

  try {
    const fromDb = await dbRead.keyValue.findUnique({ where: { key: USER_SCORE_MULTIPLIERS_KEY } });
    if (fromDb?.value) return fromDb.value as unknown as ScoreMultipliers;
  } catch (e) {
    log('score multipliers: KeyValue read failed, using default', (e as Error).message);
  }

  log('score multipliers: sysRedis + KeyValue unavailable, using hardcoded default');
  return DEFAULT_SCORE_MULTIPLIERS;
}

function getScores(ctx: Pick<Context, 'pg' | 'jobContext' | 'setScore'>, category: ScoreCategory) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<{ userId: number; score: number }>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const scores = await query.result();
    for (const { userId, score } of scores) ctx.setScore(userId, category, score);
  });
}
// #endregion
