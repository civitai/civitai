import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { applyDiscordLeaderboardRoles } from '~/server/jobs/apply-discord-roles';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import {
  getUnpopulatedLeaderboards,
  isLeaderboardPopulated,
} from '~/server/services/leaderboard.service';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { leaderboardPopulatedKey } from '~/server/services/new-creators.service';
import { updateLeaderboardRank } from '~/server/services/user.service';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import { insertSorted } from '~/utils/array-helpers';
import { createLogger } from '~/utils/logging';
import type { JobContext } from './job';
import { createJob, getJobDate } from './job';

const log = createLogger('leaderboard', 'blue');

// Accounts that must never appear on any leaderboard, regardless of the board's query.
// Applied uniformly across every population path so exclusion lives at the system level, not per-query.
// Mutes only count once confirmed by a moderator (mutedAt set); an unconfirmed `muted` flag does not exclude.
// Unlike `leaderboardExcludedSql`, metric exclusion has no non-public-board waiver.
const eligibleAccountSql = (excludedUserIds: number[], alias = 'u') =>
  `${alias}."deletedAt" IS NULL AND ${alias}."bannedAt" IS NULL AND ${alias}."mutedAt" IS NULL
    AND ${alias}.id <> ALL(${intArrayLiteral(excludedUserIds)})`;

// Moderators are excluded by role, not the flag: the flag also bars event earnings, which moderators keep.
// `isModerator` is nullable: `IS TRUE` keeps a NULL from excluding the account.
const leaderboardExcludedSql = (alias = 'u') =>
  `(${alias}."excludeFromLeaderboards" OR ${alias}."isModerator" IS TRUE)`;

function intArrayLiteral(ids: number[]) {
  if (!ids.every(Number.isSafeInteger)) throw new Error('excluded user ids must be integers');
  return `'{${ids.join(',')}}'::int[]`;
}

/** Must run before the board is sliced, or an excluded account costs the board a slot. */
function withoutExcluded<T extends { userId: number }>(rows: T[], excludedUserIds: number[]) {
  const excluded = new Set(excludedUserIds);
  return rows.filter((row) => !excluded.has(row.userId));
}

const EXCLUSION_RETRY_MS = 30_000;

/**
 * Fails open after retries: readers serve today's date only, so failing closed would leave every board empty
 * until the next run, a bigger break than listed accounts ranking for one more day.
 */
async function getExcludedUserIdsOrUnfiltered() {
  try {
    return await withRetries(getMetricExcludedUserIdsOrThrow, 3, EXCLUSION_RETRY_MS);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'leaderboard-metric-exclusion-unavailable',
      message: (e as Error).message,
    }).catch();
    return [];
  }
}

const prepareLeaderboard = createJob('prepare-leaderboard', '0 23 * * *', async (jobContext) => {
  const [lastRun, setLastRun] = await getJobDate('prepare-leaderboard');

  log('Leaderboard job start');

  const excludedUserIds = await getExcludedUserIdsOrUnfiltered();

  await setCoverImageNsfwLevelOrLog();

  const leaderboards = await dbWrite.leaderboard.findMany({
    where: {
      active: true,
      query: { not: '' },
    },
    select: {
      id: true,
      query: true,
    },
  });

  // Get latest results for date
  const addDays = dayjs().utc().hour() >= 23 ? 1 : 0;
  let imageRange: [number, number] | undefined;
  log('Leaderboards - Starting');
  const tasks = leaderboards.map(
    ({ id, query }) =>
      () =>
        withRetries(async () => {
          // jobContext.checkIfCanceled();
          if (id === 'images-rater') return; // Temporarily disable images-rater leaderboard

          const hasDataQuery = await pgDbWrite.query<{ count: number }>(`
            SELECT COUNT(*) as count FROM "LeaderboardResult"
            WHERE "leaderboardId" = '${id}' AND date = current_date + interval '${addDays} days'
          `);
          const hasData = hasDataQuery.rows[0].count > 0;
          if (hasData) {
            log(`Leaderboard ${id} - Previously completed`);
            return;
          }

          const includesCTE = query.includes('WITH ');
          const context = { jobContext, id, query, includesCTE, addDays, excludedUserIds };

          const start = Date.now();
          log(`Leaderboard ${id} - Starting`);
          logToAxiom({
            type: 'leaderboard-start',
            id,
          }).catch();

          const populated = await populateLeaderboard(context, async () => {
            if (!imageRange) imageRange = await getImageRange();
            return imageRange;
          });
          if (!populated) return;

          log(`Leaderboard ${id} - Done - ${(Date.now() - start) / 1000}s`);
          logToAxiom({
            type: 'leaderboard-done',
            id,
            duration: Date.now() - start,
          }).catch();
        }, 3)
  );
  try {
    await limitConcurrency(tasks, 3);
    log('Leaderboards - Done');
    await updateLegendsBoardResults(excludedUserIds);
    await setLastRun();
    // The routers cache these boards for a day. Without this, a board read before the job
    // finished (a late or re-run job) keeps serving that read until clear-leaderboard-cache
    // runs at midnight: on 2026-10-19 that was an empty board, all day.
    await redis.purgeTags('leaderboard');
  } catch (e) {
    const error = e as Error;
    logToAxiom({ type: 'leaderboard-error', message: error.message }).catch();
    throw error;
  }
});

/**
 * Populate one board and mark it populated. Resolves `false` when the board was skipped.
 * `getRange` is only called for image-score boards.
 */
export async function populateLeaderboard(
  context: LeaderboardContext,
  getRange: () => Promise<[number, number]>
): Promise<boolean> {
  const { id, query, includesCTE, addDays = 0 } = context;
  let skipped = false;
  try {
    if (includesCTE && query.includes('clickhouse_')) {
      skipped = (await clickhouseLeaderboardPopulation(context)) === false;
    } else if (includesCTE && query.includes('image_scores AS')) {
      skipped = (await imageLeaderboardPopulation(context, await getRange())) === false;
    } else {
      if (includesCTE && !query.includes('scores'))
        throw new Error('Query must include scores CTE');
      await defaultLeadboardPopulation(context);
    }
  } catch (e) {
    const error = e as Error;
    logToAxiom({ type: 'leaderboard-error', id, message: error.message }).catch();
    throw e;
  }

  // A skipped board has no rows; marking it would pass the populated gate and let
  // cosmetic revocation strip every holder.
  if (skipped) {
    log(`Leaderboard ${id} - Skipped, ClickHouse unavailable`);
    logToAxiom({ type: 'leaderboard-skipped', id }).catch();
    return false;
  }

  await markLeaderboardPopulated(id, addDays);
  return true;
}

/**
 * Record that a board finished populating, and for which date.
 *
 * Readers cannot infer this from the rows. The ClickHouse path assigns
 * `position = positionStart + row_number()` per batch, where `positionStart` is the
 * batch's offset in the PRE-filter array — so every user dropped by the eligibility
 * join leaves a permanent hole, and a completed board is neither gapless nor of
 * predictable size (prod: `generators` has 978 rows spanning 992 positions). Batches
 * also land out of order, so a row count proves nothing about which slice is present.
 * Only the job knows when it is done.
 *
 * Written AFTER the population call returns, so a crash mid-populate leaves the
 * previous date marked and readers keep serving the last complete board. The
 * `hasData` early return above deliberately skips this: a retry that finds a
 * half-written board must not bless it.
 *
 * Re-evaluates `current_date + interval` rather than reusing the value the INSERTs
 * used, so a run spanning midnight UTC would mark a date its rows aren't on. The job
 * currently finishes ~2 minutes after its 23:00 cron (measured across four nights),
 * leaving ~58 minutes of margin — fixing it properly means threading one date through
 * every population path, which is a change to shared cron behavior for all 34 boards.
 */
export async function markLeaderboardPopulated(id: string, addDays: number) {
  const { rows } = await pgDbWrite.query<{ date: string }>(
    `SELECT (current_date + interval '${addDays} days')::date::text as date`
  );
  await dbWrite.keyValue.upsert({
    where: { key: leaderboardPopulatedKey(id) },
    create: { key: leaderboardPopulatedKey(id), value: rows[0].date },
    update: { value: rows[0].date },
  });
}

type LegendsBoardResult = {
  userId: number;
  leaderboardId: string;
  score: number;
  metrics: Record<string, number>;
  position: number; // 1-1000
};
async function updateLegendsBoardResults(excludedUserIds: number[]) {
  log('Legacy Board - Fetching');
  const legendsBoardDataRes = await pgDbReadLong.cancellableQuery<LegendsBoardResult>(`
    WITH scores AS (
      SELECT
        "userId",
        "leaderboardId",
        SUM(CASE
          WHEN position <= 1 THEN ${constants.leaderboard.legendScoring.diamond}
          WHEN position <= 3 THEN ${constants.leaderboard.legendScoring.gold}
          WHEN position <= 10 THEN ${constants.leaderboard.legendScoring.silver}
          WHEN position <= 100 THEN ${constants.leaderboard.legendScoring.bronze}
        END) * 100 score,
        jsonb_build_object(
          'diamond', SUM(IIF(position<=1, 1, 0)),
          'gold', SUM(IIF(position BETWEEN 2 AND 3, 1, 0)),
          'silver', SUM(IIF(position BETWEEN 4 AND 10, 1, 0)),
          'bronze', SUM(IIF(position BETWEEN 11 AND 100, 1, 0))
        ) metrics
      FROM "LeaderboardResult" lr
      JOIN "User" u ON u.id = lr."userId"
      WHERE date <= now()
        AND position <= 100
        AND (
          NOT ${leaderboardExcludedSql()}
          OR EXISTS (SELECT 1 FROM "Leaderboard" l WHERE l.id = lr."leaderboardId" AND NOT l.public)
        )
        AND ${eligibleAccountSql(excludedUserIds)}
      GROUP BY "userId", "leaderboardId"
    ), positions AS (
      SELECT
        *,
        cast(row_number() OVER (PARTITION BY "leaderboardId" ORDER BY score DESC) as int) position
      FROM scores
    )
    SELECT
    *
    FROM positions
    WHERE position <= 1000
  `);
  const legendsBoardData = await legendsBoardDataRes.result();

  log('Legacy Board - Truncating');
  await dbWrite.$executeRaw`TRUNCATE "LegendsBoardResult"`;
  log('Legacy Board - Populating');
  const tasks = chunk(legendsBoardData, 500).map((batch) => async () => {
    const batchJson = JSON.stringify(batch);
    await dbWrite.$executeRaw`
      INSERT INTO "LegendsBoardResult"("userId", "leaderboardId", "score", "metrics", "position")
      SELECT * FROM jsonb_to_recordset(${batchJson}::jsonb) AS s("userId" int, "leaderboardId" text, score int, metrics jsonb, position int);
    `;
  });
  await limitConcurrency(tasks, 2);
  log('Legacy Board - Done');
}

type LeaderboardContext = {
  jobContext: JobContext;
  id: string;
  query: string;
  includesCTE: boolean;
  addDays?: number;
  excludedUserIds: number[];
};

const updateUserLeaderboardRank = createJob(
  'update-user-leaderboard-rank',
  '1 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');
    await updateLeaderboardRank();
  }
);

const updateUserDiscordLeaderboardRoles = createJob(
  'update-user-discord-leaderboard-roles',
  '10 0 * * *',
  async () => {
    // Roles are driven by UserRank, not by any single board, so an unpopulated board only means the ranks may
    // lag a day. Skipping the run instead costs the whole day's role sync, with no retry.
    const unpopulated = await getUnpopulatedLeaderboards();
    if (unpopulated.length)
      logToAxiom({
        type: 'warn',
        name: 'leaderboard-partially-populated',
        // civitai-prod is at its column cap, so `error` is the only top-level container new fields can go in.
        error: { unpopulated },
      });

    await applyDiscordLeaderboardRoles();
  }
);

type LeaderboardResult = {
  userId: number;
  score: number;
  metrics: Record<string, number>;
  position: number;
};
/** Board SQL placeholder for the metric-excluded user ids, which live in ClickHouse and so cannot be joined in Postgres. */
export const METRIC_EXCLUDED_USERS_TOKEN = '{{metricExcludedUserIds}}';

async function defaultLeadboardPopulation(ctx: LeaderboardContext) {
  const query = ctx.query.replaceAll(
    METRIC_EXCLUDED_USERS_TOKEN,
    intArrayLiteral(ctx.excludedUserIds)
  );
  const leaderboardScoreQuery = await pgDbReadLong.cancellableQuery<LeaderboardResult>(`
    ${ctx.includesCTE ? query : `WITH scores AS (${query})`}
    SELECT
      s."userId",
      ROUND(s.score)::int as score,
      s.metrics,
      row_number() OVER (ORDER BY score DESC) as position
    FROM scores s
    JOIN "User" u ON u.id = s."userId"
    WHERE (
      NOT ${leaderboardExcludedSql()}
      OR EXISTS (SELECT 1 FROM "Leaderboard" l WHERE l.id = '${ctx.id}' AND NOT l.public)
    )
      AND ${eligibleAccountSql(ctx.excludedUserIds)}
    ORDER BY score DESC
    LIMIT 1000
  `);

  const scores = await leaderboardScoreQuery.result();
  const tasks = chunk(scores, 500).map((batch, i) => async () => {
    const batchJson = JSON.stringify(batch);
    log(`Leaderboard ${ctx.id} - Inserting ${i + 1} of ${tasks.length}`);
    const leaderboardUpdateQuery = await pgDbWrite.cancellableQuery(`
      INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
      SELECT
        '${ctx.id}' as "leaderboardId",
        current_date + interval '${ctx.addDays} days' as date,
        s.*
      FROM jsonb_to_recordset('${batchJson}'::jsonb) AS s("userId" int, score int, metrics jsonb, position int)
    `);
    await leaderboardUpdateQuery.result();
  });
  await limitConcurrency(tasks, 2);
}

async function getImageRange() {
  const {
    rows: [{ min, max }],
  } = await pgDbReadLong.query<{ min: number; max: number }>(`
    WITH dates AS (
      SELECT MIN("createdAt") as start, MAX("createdAt") as end FROM "Image" WHERE "createdAt" > now() - interval '30 days'
    )
    SELECT MIN(id) as min, MAX(id) as max
    FROM "Image" i
    JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
  `);
  return [min, max] as [number, number];
}

function appendScore(userScores: Record<number, UserScoreKeeper>, toAdd: ImageScores[]) {
  for (const score of toAdd) {
    if (!userScores[score.userId])
      userScores[score.userId] = { score: 0, scores: [], metrics: { imageCount: 0 } };

    // Increment image count
    userScores[score.userId].metrics.imageCount++;

    // Append score
    insertSorted(userScores[score.userId].scores!, score.score >= 0 ? score.score : 0, 'desc');

    // Remove lowest score if over limit
    if (userScores[score.userId].scores!.length > IMAGE_SCORE_FALLOFF)
      userScores[score.userId].scores!.pop();

    // Add up metrics
    for (const metric in score.metrics) {
      if (!userScores[score.userId].metrics[metric]) userScores[score.userId].metrics[metric] = 0;
      userScores[score.userId].metrics[metric] += score.metrics[metric];
    }
  }
}

type UserScoreKeeper = {
  score: number;
  scores?: number[];
  metrics: Record<string, number>;
};
type ImageScores = {
  userId: number;
  score: number;
  metrics: Record<string, number>;
};
const IMAGE_SCORE_BATCH_SIZE = 100000;
const IMAGE_SCORE_FALLOFF = 120;
const IMAGE_SCORE_MULTIPLIER = 100;
async function imageLeaderboardPopulation(
  ctx: LeaderboardContext,
  [min, max]: [number, number]
): Promise<boolean> {
  if (ctx.query.includes('ch_image_scores') && !clickhouse) return false;
  // Fetch Scores
  const userScores: Record<number, UserScoreKeeper> = {};
  const tasks: Task[] = [];
  const numTasks = Math.ceil((max - min) / IMAGE_SCORE_BATCH_SIZE);
  log(`Leaderboard ${ctx.id} - Fetching scores - ${numTasks} tasks`);
  for (let i = 0; i < numTasks; i++) {
    const startIndex = min + i * IMAGE_SCORE_BATCH_SIZE;
    const endIndex = Math.min(startIndex + IMAGE_SCORE_BATCH_SIZE - 1, max);

    tasks.push(async () => {
      // ctx.jobContext.checkIfCanceled();
      const key = `Leaderboard ${ctx.id} - Fetching scores - ${startIndex} to ${endIndex}`;
      log(key);
      const isClickhouseQuery = ctx.query.includes('ch_image_scores');
      if (isClickhouseQuery) {
        if (!clickhouse) return;

        const response = await clickhouse.query({
          query: ctx.query,
          query_params: { from: startIndex, to: endIndex },
          format: 'JSONEachRow',
        });

        const scores = (await response?.json<ImageScores & { metrics: string }>()).map((s) => ({
          ...s,
          metrics: JSON.parse(s.metrics) as Record<string, number>,
        }));

        appendScore(userScores, scores);
      } else {
        const batchScores = await pgDbReadLong.query<ImageScores>(
          `${ctx.query} SELECT * FROM image_scores`,
          [startIndex, endIndex]
        );
        appendScore(userScores, batchScores.rows);
      }
    });
  }

  await limitConcurrency(tasks, 2);

  // Add up scores
  log(`Leaderboard ${ctx.id} - Adding up scores`);
  for (const user of Object.values(userScores)) {
    // Add up scores with quantity multipliers
    user.scores!.forEach((score, rank) => {
      const quantityMultiplier = Math.max(0, 1 - Math.pow(rank / IMAGE_SCORE_FALLOFF, 0.5));
      user.score += score * quantityMultiplier;
    });
    delete user.scores;
  }

  // Apply multipliers and sqrt
  for (const userId in userScores) {
    userScores[userId].score = Math.round(
      Math.sqrt(userScores[userId].score) * IMAGE_SCORE_MULTIPLIER
    );
  }

  // Rank
  const userScoresArray = withoutExcluded(
    Object.entries(userScores).map(([userId, score]) => ({
      userId: parseInt(userId),
      ...score,
    })),
    ctx.excludedUserIds
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, 1100); // Overfetch to account for deleted users

  // Insert into leaderboard
  log(`Leaderboard ${ctx.id} - Inserting into leaderboard`);
  const userScoresJson = JSON.stringify(userScoresArray);
  const leaderboardUpdateQuery = await pgDbWrite.cancellableQuery(`
    INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
    SELECT
      '${ctx.id}' as "leaderboardId",
      current_date + interval '${ctx.addDays} days' as date,
      (s->>'userId')::int,
      (s->>'score')::int,
      (s->>'metrics')::jsonb,
      row_number() OVER (ORDER BY (s->>'score')::int DESC) as position
    FROM jsonb_array_elements('${userScoresJson}'::jsonb) s
    JOIN "User" u ON u.id = (s->>'userId')::int
    WHERE ${eligibleAccountSql(ctx.excludedUserIds)} AND u.id > 0
      AND NOT ${leaderboardExcludedSql()}
    ORDER BY (s->>'score')::int DESC
    LIMIT 1000
  `);
  // ctx.jobContext.on('cancel', leaderboardUpdateQuery.cancel);
  await leaderboardUpdateQuery.result();
  return true;
}

type NsfwLevelRow = {
  id: number;
  nsfw: string;
  metaType: string | null;
};

/**
 * Fails open: the boards only read the levels this writes, so a failure leaves them a day stale, while
 * throwing here builds no board at all.
 */
export async function setCoverImageNsfwLevelOrLog() {
  try {
    await setCoverImageNsfwLevel();
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'leaderboard-cover-nsfw-level-failed',
      message: (e as Error).message,
    }).catch();
  }
}

/**
 * `jsonb_set` throws on a meta that is not an object, failing its whole chunk. On 2026-10-18 four
 * array-shaped `Model.meta` rows did that and no board was built for the next day.
 * SQL NULL counts as malformed on purpose: `meta` is NOT NULL on both tables, so one cannot occur.
 */
function withoutMalformedMeta(rows: NsfwLevelRow[], table: 'Model' | 'ModelVersion') {
  const isWritable = (row: NsfwLevelRow) => row.metaType === 'object' || row.metaType === 'null';
  const malformed = rows.filter((row) => !isWritable(row));
  if (malformed.length)
    logToAxiom({
      type: 'error',
      name: 'leaderboard-malformed-meta',
      // civitai-prod is at its column cap, so `error` is the only top-level container new fields can go in.
      error: { table, count: malformed.length, ids: malformed.slice(0, 100).map((row) => row.id) },
    }).catch();
  return rows.filter(isWritable);
}

export async function setCoverImageNsfwLevel() {
  log('Setting cover image nsfw level - version');
  const { rows: versionLevels } = await pgDbReadLong.query<NsfwLevelRow>(`
    -- get version nsfw image level based on post nsfw level
    WITH model_version_nsfw_level AS (
      SELECT DISTINCT ON (mv.id) mv.id, p.metadata->>'imageNsfwLevel' nsfw
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
      WHERE mv.status = 'Published'
      ORDER BY mv.id, mv.index, p.id
    )
    SELECT level.*, jsonb_typeof(mv.meta) "metaType"
    FROM model_version_nsfw_level level
    JOIN "ModelVersion" mv ON mv.id = level.id
    WHERE
      level.nsfw IS NOT NULL AND (
        jsonb_typeof(mv.meta) = 'undefined'
        OR (mv.meta->>'imageNsfwLevel' IS DISTINCT FROM level.nsfw)
      );
  `);
  const tasks = chunk(withoutMalformedMeta(versionLevels, 'ModelVersion'), 500).map(
    (level) => async () => {
      const levelJson = JSON.stringify(level);
      log('Setting cover image nsfw level - version');
      const query = await pgDbWrite.cancellableQuery(`
      -- set version nsfw image level based on post nsfw level
      WITH model_version_nsfw_level AS (
        SELECT * FROM jsonb_to_recordset('${levelJson}'::jsonb) AS s(id int, nsfw int)
      )
      UPDATE "ModelVersion" mv
      SET
        meta = jsonb_set(IIF(jsonb_typeof(meta) = 'null' OR meta IS NULL, '{}', meta), '{imageNsfwLevel}', to_jsonb(COALESCE(level.nsfw, 1)))
      FROM model_version_nsfw_level level
      WHERE level.id = mv.id AND jsonb_typeof(mv.meta) IN ('object', 'null');
    `);
      await query.result();
    }
  );
  await limitConcurrency(tasks, 2);

  log('Setting cover image nsfw level - model');
  const { rows: modelLevels } = await pgDbReadLong.query<NsfwLevelRow>(`
    -- get version nsfw image level based on post nsfw level
    WITH model_nsfw_level AS (
      SELECT DISTINCT ON (mv."modelId")
        mv."modelId" as "id",
        mv.meta->>'imageNsfwLevel' nsfw
      FROM "ModelVersion" mv
      ORDER BY mv."modelId", mv.index
    )
    SELECT level.*, jsonb_typeof(m.meta) "metaType"
    FROM model_nsfw_level level
    JOIN "Model" m ON m.id = level.id
    WHERE
      level.nsfw IS NOT NULL AND (
        jsonb_typeof(m.meta) = 'undefined'
        OR (m.meta->>'imageNsfwLevel' IS DISTINCT FROM level.nsfw)
      );
  `);
  const modelTasks = chunk(withoutMalformedMeta(modelLevels, 'Model'), 500).map(
    (level) => async () => {
      const levelJson = JSON.stringify(level);
      log('Setting cover image nsfw level - model');
      const query = await pgDbWrite.cancellableQuery(`
      -- set model nsfw image level based on version nsfw level
      WITH model_nsfw_level AS (
        SELECT * FROM jsonb_to_recordset('${levelJson}'::jsonb) AS s(id int, nsfw int)
      )
      UPDATE "Model" m
      SET
        meta = jsonb_set(IIF(jsonb_typeof(meta) = 'null' OR meta IS NULL, '{}', meta), '{imageNsfwLevel}', to_jsonb(COALESCE(level.nsfw, 1)))
      FROM model_nsfw_level level
      WHERE level.id = m.id AND jsonb_typeof(m.meta) IN ('object', 'null');
    `);
      await query.result();
    }
  );
  await limitConcurrency(modelTasks, 2);
}

type ClickhouseScores = {
  userId: number;
  score: number;
  metrics: string;
};
const CLICKHOUSE_INSERT_BATCH_SIZE = 500;
/** Resolves `false` when skipped for lack of a ClickHouse client. */
export async function clickhouseLeaderboardPopulation(ctx: LeaderboardContext): Promise<boolean> {
  if (!clickhouse) return false;
  log('Leaderboard', ctx.id, 'Clickhouse');
  const scores = withoutExcluded(
    (await clickhouse.$query<ClickhouseScores>(ctx.query)) ?? [],
    ctx.excludedUserIds
  )
    .slice(0, 1000)
    .map((s) => ({
      ...s,
      metrics: JSON.parse(s.metrics),
    }));
  const tasks = chunk(scores, CLICKHOUSE_INSERT_BATCH_SIZE).map((batch, i) => async () => {
    const batchJson = JSON.stringify(batch);
    const positionStart = i * CLICKHOUSE_INSERT_BATCH_SIZE;
    log('Leaderboard', ctx.id, 'Inserting', i + 1, 'of', tasks.length);
    const query = await pgDbWrite.cancellableQuery(`
      WITH scores AS (SELECT * FROM jsonb_to_recordset('${batchJson}'::jsonb) AS s("userId" int, score int, metrics jsonb))
      INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
      SELECT
        '${ctx.id}' as "leaderboardId",
        current_date + interval '${ctx.addDays} days' as date,
        s.*,
        (${positionStart} + row_number() OVER (ORDER BY score DESC)) as position
      FROM scores s
      JOIN "User" u ON u.id = s."userId" AND ${eligibleAccountSql(ctx.excludedUserIds)}
      WHERE NOT ${leaderboardExcludedSql()}
    `);
    ctx.jobContext.on('cancel', query.cancel);
    await query.result();
    log('Leaderboard', ctx.id, 'Inserted', i + 1, 'of', tasks.length);
  });
  await limitConcurrency(tasks, 5);
  return true;
}

const clearLeaderboardCache = createJob('clear-leaderboard-cache', '0 0 * * *', async () => {
  await redis.purgeTags('leaderboard');
});

export const leaderboardJobs = [
  prepareLeaderboard,
  updateUserLeaderboardRank,
  updateUserDiscordLeaderboardRoles,
  clearLeaderboardCache,
];
