/**
 * Recompute the reaction columns of PostMetric / ArticleMetric / BountyEntryMetric
 * for the entities whose stored totals were summed before the metric jobs learned to
 * exclude suppressed accounts.
 *
 * Adding the filter to the jobs only corrects an entity the next time it is affected,
 * and the Postgres sums never decay — so an entity that has stopped receiving
 * reactions keeps its pre-exclusion total indefinitely. This walks the id space and
 * rewrites only the rows that actually disagree with the filtered sum.
 *
 * Actions (all GET, `?token=$WEBHOOK_TOKEN`):
 *   entity=article       Recompute ArticleMetric AllTime rows. ~594 affected.
 *   entity=bountyEntry   Recompute BountyEntryMetric, every timeframe. ~1,154 affected.
 *   entity=post          Recompute PostMetric AllTime rows. Between 133,961 and
 *                        2,004,279 affected; never sized exactly, so it is the one
 *                        that wants a real batch budget.
 *   entity=all           All three, in that order.
 *
 * Params: dryRun (default false), batchSize, concurrency, start, end.
 *
 * Each entity's timeframe coverage matches what its job maintains, so the backfill
 * cannot leave behind a row the job will never touch again: post and article write
 * `AllTime` only, bountyEntry writes every timeframe.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { articleStatCache, postStatCache } from '~/server/redis/caches';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const ENTITIES = ['post', 'article', 'bountyEntry'] as const;
type Entity = (typeof ENTITIES)[number];

const schema = z.object({
  entity: z.enum([...ENTITIES, 'all']).default('all'),
  dryRun: z.enum(['true', 'false']).default('false'),
  concurrency: z.coerce.number().min(1).max(50).optional().default(4),
  batchSize: z.coerce.number().min(1).optional().default(10000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

const REACTIONS = ['Heart', 'Like', 'Dislike', 'Laugh', 'Cry'] as const;

/**
 * The job's own per-timeframe sum, rewritten so a NULL `r` row contributes 0.
 *
 * NOTE for whoever picks this up: the sibling PR made `timeframeSum` NULL-safe
 * (`WHEN (cond) IS NOT TRUE THEN 0`), so `snippets.reactionTimeframes()` IS now safe
 * under the LEFT JOIN this uses, and these hand-rolled sums can be replaced by it.
 * Left as they are only because they were written before that change landed.
 */
function reactionSums(timeframed: boolean) {
  const window = (alias: string) =>
    timeframed
      ? `AND (
          tf.timeframe = 'AllTime'
          OR (tf.timeframe = 'Year' AND ${alias}."createdAt" > NOW() - interval '365 days')
          OR (tf.timeframe = 'Month' AND ${alias}."createdAt" > NOW() - interval '30 days')
          OR (tf.timeframe = 'Week' AND ${alias}."createdAt" > NOW() - interval '7 days')
          OR (tf.timeframe = 'Day' AND ${alias}."createdAt" > NOW() - interval '1 days')
        )`
      : '';
  return REACTIONS.map(
    (reaction) =>
      `SUM(CASE WHEN r.reaction = '${reaction}' ${window(
        'r'
      )} THEN 1 ELSE 0 END)::int AS "${reaction.toLowerCase()}Count"`
  ).join(',\n        ');
}

const reactionAssignments = REACTIONS.map(
  (r) => `"${r.toLowerCase()}Count" = s."${r.toLowerCase()}Count"`
).join(',\n        ');

/**
 * `IS DISTINCT FROM` rather than `!=` so a NULL column still counts as a difference,
 * and the predicate at all so a row already carrying the filtered total is left
 * untouched — that is what makes the reported row count a measure of what was wrong
 * rather than of how many rows the scan visited.
 */
const reactionDiffers = REACTIONS.map(
  (r) => `m."${r.toLowerCase()}Count" IS DISTINCT FROM s."${r.toLowerCase()}Count"`
).join('\n          OR ');

type EntitySpec = {
  maxIdSql: string;
  metricTable: string;
  idColumn: string;
  /** Emits `affected` (id) and `sums` (id, the reaction columns, timeframe if timeframed). */
  ctes: (args: { start: number; end: number; excluded: string }) => string;
  timeframed: boolean;
  bustCache?: (ids: number[]) => Promise<void>;
};

const specs: Record<Entity, EntitySpec> = {
  article: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "Article"',
    metricTable: 'ArticleMetric',
    idColumn: 'articleId',
    timeframed: false,
    ctes: ({ start, end, excluded }) => `
      affected AS (
        SELECT DISTINCT r."articleId" AS id
        FROM "ArticleReaction" r
        WHERE r."articleId" >= ${start} AND r."articleId" <= ${end}
          AND r."userId" IN (${excluded})
      ), sums AS (
        SELECT a.id,
        ${reactionSums(false)}
        FROM affected a
        LEFT JOIN "ArticleReaction" r
          ON r."articleId" = a.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id
      )`,
    bustCache: (ids) => articleStatCache.bust(ids),
  },
  post: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "Post"',
    metricTable: 'PostMetric',
    idColumn: 'postId',
    timeframed: false,
    ctes: ({ start, end, excluded }) => `
      affected AS (
        SELECT DISTINCT i."postId" AS id
        FROM "ImageReaction" r
        JOIN "Image" i ON i.id = r."imageId"
        WHERE i."postId" >= ${start} AND i."postId" <= ${end}
          AND r."userId" IN (${excluded})
      ), sums AS (
        SELECT a.id,
        ${reactionSums(false)}
        FROM affected a
        JOIN "Image" i ON i."postId" = a.id
        LEFT JOIN "ImageReaction" r
          ON r."imageId" = i.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id
      )`,
    bustCache: (ids) => postStatCache.bust(ids),
  },
  bountyEntry: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "BountyEntry"',
    metricTable: 'BountyEntryMetric',
    idColumn: 'bountyEntryId',
    timeframed: true,
    ctes: ({ start, end, excluded }) => `
      affected AS (
        SELECT DISTINCT r."bountyEntryId" AS id
        FROM "BountyEntryReaction" r
        WHERE r."bountyEntryId" >= ${start} AND r."bountyEntryId" <= ${end}
          AND r."userId" IN (${excluded})
      ), sums AS (
        SELECT a.id, tf.timeframe,
        ${reactionSums(true)}
        FROM affected a
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        LEFT JOIN "BountyEntryReaction" r
          ON r."bountyEntryId" = a.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id, tf.timeframe
      )`,
  },
};

function buildSql(spec: EntitySpec, args: { start: number; end: number; excluded: string }) {
  const timeframeMatch = spec.timeframed ? 'm.timeframe = s.timeframe' : "m.timeframe = 'AllTime'";
  const match = `m."${spec.idColumn}" = s.id AND ${timeframeMatch} AND (${reactionDiffers})`;
  return {
    // A dry run has to run the same scan — the point is to learn how many rows would
    // change, and a skipped query cannot say. Only the write differs.
    dry: `
      WITH ${spec.ctes(args)}
      SELECT m."${spec.idColumn}" AS id
      FROM "${spec.metricTable}" m
      JOIN sums s ON ${match}`,
    write: `
      WITH ${spec.ctes(args)}
      UPDATE "${spec.metricTable}" m
      SET ${reactionAssignments},
          "updatedAt" = NOW()
      FROM sums s
      WHERE ${match}
      RETURNING m."${spec.idColumn}" AS id`,
  };
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const params = schema.parse(req.query);
  const dryRun = params.dryRun === 'true';

  const excludedIds = await getMetricExcludedUserIdsOrThrow();
  if (!excludedIds.length) {
    res.status(200).json({ finished: true, excludedUsers: 0, note: 'nothing to correct' });
    return;
  }
  // Built here rather than via the metrics helper: that one emits the whole
  // `AND r."userId" NOT IN (...)` clause for a fixed alias, and this needs the bare
  // list for an `IN` as well. Same integer guard, because this also builds SQL text.
  for (const id of excludedIds) {
    if (!Number.isInteger(id)) throw new Error(`non-integer excluded user id: ${id}`);
  }
  const excluded = excludedIds.join(',');

  const targets = params.entity === 'all' ? [...ENTITIES] : [params.entity as Entity];
  const results: Record<string, { rowsChanged: number; batchErrors: number }> = {};

  for (const entity of targets) {
    const spec = specs[entity];
    let rowsChanged = 0;
    let batchErrors = 0;

    await dataProcessor({
      params,
      runContext: res,
      rangeFetcher: async (context) => {
        const [{ max }] = await dbWrite.$queryRawUnsafe<{ max: number | null }[]>(spec.maxIdSql);
        return { start: context.start, end: max ?? 0 };
      },
      processor: async ({ start, end, cancelFns }) => {
        const sql = buildSql(spec, { start, end, excluded });
        try {
          const query = await pgDbWrite.cancellableQuery<{ id: number }>(
            dryRun ? sql.dry : sql.write
          );
          cancelFns.push(query.cancel);
          const rows = await query.result();

          rowsChanged += rows.length;
          if (!dryRun && rows.length && spec.bustCache) {
            await spec.bustCache([...new Set(rows.map((r) => r.id))]);
          }
          console.log(`[${entity}] ${start} - ${end}: ${rows.length} rows`);
        } catch (e) {
          // Counted rather than rethrown: `dataProcessor` catches and logs a throwing
          // processor, so a failed batch would otherwise leave a run that reports a
          // low row count and no indication that anything went wrong.
          batchErrors++;
          console.error(`[${entity}] ${start} - ${end} FAILED: ${(e as Error).message}`);
        }
      },
    });

    results[entity] = { rowsChanged, batchErrors };
  }

  res.status(200).json({ finished: true, dryRun, excludedUsers: excludedIds.length, results });
});
