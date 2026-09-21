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
 *   entity=article       Recompute ArticleMetric AllTime rows.
 *   entity=bountyEntry   Recompute BountyEntryMetric, every timeframe.
 *   entity=post          Recompute PostMetric AllTime rows. Much the largest of the
 *                        three, and the one that wants a real batch budget.
 *   entity=all           All three, cheapest first, post last.
 *
 * Params: dryRun (default TRUE), batchSize, concurrency, start, end. `batchSize`
 * defaults per entity and an explicit value overrides it — see the post spec for why
 * that default is not one number. `dryRun` defaults to a dry run because the shortest
 * possible call is the endpoint and a token, and that should not be a production write.
 *
 * Each entity's timeframe coverage matches what its job maintains TODAY: post and
 * article `AllTime` only, bountyEntry every timeframe. Two consequences worth stating
 * rather than leaving to be rediscovered:
 *
 *   - `PostMetric` Day/Week/Month/Year rows still hold pre-exclusion totals and this
 *     does not correct them. Measured on prod 2026-09-21 over a 1,000-post window, they
 *     last moved on 2026-08-12 while AllTime moved that day — no post job writes them
 *     any more, under either arm of the `simplified-post-metrics` flag. Correcting them
 *     would write rows nothing maintains.
 *   - For bountyEntry, `rowsChanged` is NOT a measure of exclusion damage. Its
 *     non-AllTime windows are relative to `NOW()` while the stored value is frozen at
 *     the job's last write, so most of those rows differ for reasons unrelated to the
 *     exclusion list. Measured on prod 2026-09-21 across 1,204 affected entries,
 *     heartCount differing: AllTime 489, Year 492, Month 118, Week 79, Day 30. Read
 *     the AllTime figure as the damage; the rest is window catch-up.
 *
 * The exclusion list grows over time (557 -> 571 between this being drafted and first
 * run), so a run's numbers only mean something next to the list it used. The response
 * reports that list's size and a digest of it, and echoes each entity's resolved
 * `start`/`end` — a transposed slice issues zero batches and would otherwise answer
 * `rowsChanged: 0`, which reads exactly like a slice that was already correct.
 *
 * Post is far too big for one request: ~31M ids at 1,000 per batch is hours of held-open
 * HTTP, which no proxy in front of this will allow. Run it in slices with `start`/`end`
 * and keep the response for each.
 *
 * Interrupted runs are safe to repeat: each batch is a single statement, and the
 * `IS DISTINCT FROM` predicate makes a second pass a no-op over rows already correct.
 * That same idempotency is why a non-zero `propagationErrors` cannot be repaired by
 * re-running — see the propagation catch below.
 */
import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { snippets } from '~/server/metrics/metric-helpers';
import { articleStatCache, postStatCache } from '~/server/redis/caches';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ReviewReactions } from '~/shared/utils/prisma/enums';

const ENTITIES = ['article', 'bountyEntry', 'post'] as const;
type Entity = (typeof ENTITIES)[number];

const schema = z.object({
  entity: z.enum([...ENTITIES, 'all']).default('all'),
  dryRun: z.enum(['true', 'false']).default('true'),
  concurrency: z.coerce.number().min(1).max(50).optional().default(4),
  batchSize: z.coerce.number().min(1).optional(),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

const REACTIONS = Object.keys(ReviewReactions) as (keyof typeof ReviewReactions)[];

/**
 * AllTime-only sums, for the two jobs that maintain only that timeframe. Under the LEFT
 * JOIN these run against, an unmatched row leaves `r.reaction` NULL, so the WHEN is
 * never true and the row scores 0 — an entity whose remaining reactions are all
 * excluded therefore sums to zero rather than yielding no row at all.
 *
 * The timeframed case uses `snippets.reactionTimeframes()` directly, so bountyEntry's
 * five windows have one definition shared with the job that maintains them.
 */
const allTimeReactionSums = REACTIONS.map(
  (reaction) =>
    `SUM(CASE WHEN r.reaction = '${reaction}' THEN 1 ELSE 0 END)::int AS "${reaction.toLowerCase()}Count"`
).join(',\n        ');

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
  /**
   * Per entity because the post scan has a batch-size cliff and the other two do not.
   * See the note on the post spec.
   */
  defaultBatchSize: number;
  /** Emits `affected` (id) and `sums` (id, the reaction columns, timeframe if timeframed). */
  ctes: (args: { start: number; end: number; excluded: string }) => string;
  timeframed: boolean;
  /**
   * Everything downstream of the metric row that has to learn about the new value.
   * The metric JOB is the reference for what belongs here — a surface the job refreshes
   * and this does not keeps its pre-exclusion number forever, because the entities this
   * endpoint targets are by definition ones the job will never revisit.
   */
  propagate?: (ids: number[]) => Promise<void>;
};

const specs: Record<Entity, EntitySpec> = {
  article: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "Article"',
    metricTable: 'ArticleMetric',
    defaultBatchSize: 10000,
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
        ${allTimeReactionSums}
        FROM affected a
        LEFT JOIN "ArticleReaction" r
          ON r."articleId" = a.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id
      )`,
    // Both halves, because `article.metrics.ts` does both: the search index stores the
    // AllTime reaction counts verbatim, and a search card reads the document, not the
    // stat cache.
    propagate: async (ids) => {
      const { articlesSearchIndex } = await import('~/server/search-index');
      await articlesSearchIndex.queueUpdate(
        ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
      await articleStatCache.bust(ids);
    },
  },
  /**
   * 1,000 because the post scan has a cliff between 1,000 and 10,000 ids, not a slope.
   * At 1,000 the planner loops `Image (postId_covered_idx)` into
   * `ImageReaction_imageId_createdAt`; at 10,000 it flips to a hash join whose probe
   * side is a whole-index scan of `ImageReaction`, and the batch stops finishing.
   * Measured on the prod replica 2026-09-21: 1,000 ids in ~1.1s, 10,000 ids still
   * running at the pooler's ~60s ceiling.
   */
  post: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "Post"',
    metricTable: 'PostMetric',
    defaultBatchSize: 1000,
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
        ${allTimeReactionSums}
        FROM affected a
        JOIN "Image" i ON i."postId" = a.id
        LEFT JOIN "ImageReaction" r
          ON r."imageId" = i.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id
      )`,
    propagate: (ids) => postStatCache.bust(ids),
  },
  bountyEntry: {
    maxIdSql: 'SELECT MAX(id) AS max FROM "BountyEntry"',
    metricTable: 'BountyEntryMetric',
    defaultBatchSize: 10000,
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
        ${snippets.reactionTimeframes()}
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
  // The list this run used, so a later re-run that reports a different residual can be
  // told apart from a list that grew in between. Order-independent: the service does not
  // promise one.
  const excludedUsersDigest = createHash('sha256')
    .update([...excludedIds].sort((a, b) => a - b).join(','))
    .digest('hex')
    .slice(0, 16);
  // Built here rather than via the metrics helper: that one emits the whole
  // `AND r."userId" NOT IN (...)` clause for a fixed alias, and this needs the bare
  // list for an `IN` as well. Same integer guard, because this also builds SQL text.
  for (const id of excludedIds) {
    if (!Number.isInteger(id)) throw new Error(`non-integer excluded user id: ${id}`);
  }
  const excluded = excludedIds.join(',');

  const targets = params.entity === 'all' ? [...ENTITIES] : [params.entity as Entity];
  const results: Record<
    string,
    {
      rowsChanged: number;
      batchErrors: number;
      propagationErrors: number;
      batchSize: number;
      batches: number;
      start: number;
      end: number;
    }
  > = {};

  for (const entity of targets) {
    const spec = specs[entity];
    const batchSize = params.batchSize ?? spec.defaultBatchSize;
    let rowsChanged = 0;
    let batchErrors = 0;
    let propagationErrors = 0;
    let batches = 0;

    // Resolved here rather than left to `dataProcessor`'s `rangeFetcher`, so the range
    // can be echoed back. The documented way to run post is a series of start/end slices
    // kept as the record that the space was covered, and that record is only checkable
    // if each response says what it actually walked.
    const rangeStart = params.start;
    const [{ max }] = await dbWrite.$queryRawUnsafe<{ max: number | null }[]>(spec.maxIdSql);
    const rangeEnd = params.end ?? max ?? 0;

    await dataProcessor({
      params: { ...params, batchSize, start: rangeStart, end: rangeEnd },
      runContext: res,
      rangeFetcher: async () => ({ start: rangeStart, end: rangeEnd }),
      processor: async ({ start, end, cancelFns }) => {
        batches++;
        const sql = buildSql(spec, { start, end, excluded });
        let changed: number[];
        try {
          const query = await pgDbWrite.cancellableQuery<{ id: number }>(
            dryRun ? sql.dry : sql.write
          );
          cancelFns.push(query.cancel);
          const rows = await query.result();

          rowsChanged += rows.length;
          changed = [...new Set(rows.map((r) => r.id))];
          console.log(`[${entity}] ${start} - ${end}: ${rows.length} rows`);
        } catch (e) {
          // Counted rather than rethrown: `dataProcessor` catches and logs a throwing
          // processor, so a failed batch would otherwise leave a run that reports a
          // low row count and no indication that anything went wrong.
          batchErrors++;
          console.error(`[${entity}] ${start} - ${end} FAILED: ${(e as Error).message}`);
          return;
        }

        if (dryRun || !changed.length) return;
        // Counted apart from the scan's failures because the two need different remedies
        // and one number cannot say which happened. A failed SCAN wrote nothing, so a
        // re-run repairs it. A failed PROPAGATION happens after the rows are committed,
        // so `IS DISTINCT FROM` will never select them again and a re-run CANNOT repair
        // it — which is why the ids are logged rather than only counted.
        try {
          await spec.propagate?.(changed);
        } catch (e) {
          propagationErrors++;
          console.error(
            `[${entity}] ${start} - ${end} PROPAGATION FAILED, rows are written but ` +
              `downstream is stale, replay these ids: ${changed.join(',')} :: ${
                (e as Error).message
              }`
          );
        }
      },
    });

    results[entity] = {
      rowsChanged,
      batchErrors,
      propagationErrors,
      batchSize,
      batches,
      start: rangeStart,
      end: rangeEnd,
    };
  }

  res.status(200).json({
    finished: true,
    dryRun,
    excludedUsers: excludedIds.length,
    excludedUsersDigest,
    results,
  });
});
