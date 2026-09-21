/**
 * One-off: recompute the reaction columns of ArticleMetric and BountyEntryMetric for the
 * entities whose stored totals were summed before the metric jobs learned to exclude
 * metric-suppressed accounts.
 *
 * #4959 (`8113e62777`) added the filter to the jobs, and is deployed. It only corrects an
 * entity the next time that entity is affected, and these Postgres sums never decay — so
 * an entity that has stopped receiving reactions keeps its pre-exclusion total forever.
 * This is that second half, for two of the ticket's three entity types.
 *
 * A script rather than an admin endpoint because an endpoint cannot run until it is
 * merged, released and deployed, and the work here is under a second of database time:
 * the whole `ArticleReaction` id space aggregates in ~166 ms and `BountyEntryReaction` in
 * ~643 ms (prod replica, 2026-09-21). Delete it once the run is done.
 *
 * POST is deliberately NOT here. Its shape reads ~3.4 TB through a 60 GB shared_buffers
 * on the primary to change ~1M rows, because it walks all 31M post ids to discover ~1M
 * affected ones. It returns as its own change driven from the affected set, which reads
 * out of `ImageReaction_userId` in ~6 s. Tracked by the same ticket, 868m6vftv.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/backfill-reaction-metric-exclusions.ts [options]
 *
 * Options:
 *   --entity article|bountyEntry|all   Default all.
 *   --write         Actually write. WITHOUT THIS IT IS A DRY RUN — the identical scan,
 *                   issued as a SELECT, reporting what it would change.
 *   --propagate     Bust the article stat cache and queue the article search index for
 *                   the ids just written. Separate from --write so a dev run against a
 *                   dev database cannot touch the production cache or index, which the
 *                   app's own .env points at regardless of which database is configured.
 *   --batch-size n  Default 10000.
 *   --start n / --end n
 *
 * The exclusion list is read from ClickHouse with the same query the app uses. If it
 * cannot be read, or comes back empty, this exits NONZERO and writes nothing — an empty
 * list would make every sum equal its stored value and the run would report a clean
 * sweep having done nothing.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { ReviewReactions } from '~/shared/utils/prisma/enums';

const ENTITIES = ['article', 'bountyEntry'] as const;
type Entity = (typeof ENTITIES)[number];

const REACTIONS = Object.keys(ReviewReactions) as (keyof typeof ReviewReactions)[];

/**
 * AllTime-only sums, matching what `article.metrics.ts` maintains. Under the LEFT JOIN
 * these run against, an unmatched row leaves `r.reaction` NULL, so the WHEN is never true
 * and the row scores 0 — an entity whose remaining reactions are ALL excluded therefore
 * sums to zero rather than yielding no row, which is the case the jobs seed zeros for.
 */
export const allTimeReactionSums = REACTIONS.map(
  (reaction) =>
    `SUM(CASE WHEN r.reaction = '${reaction}' THEN 1 ELSE 0 END)::int AS "${reaction.toLowerCase()}Count"`
).join(',\n        ');

/**
 * The five per-timeframe windows, transcribed from `snippets.reactionTimeframes()`.
 *
 * Copied rather than imported because importing `~/server/metrics/metric-helpers` pulls
 * the Flipt client and the whole metric graph into a standalone script. The transcription
 * is pinned against the real snippet by a test, so the two cannot drift silently.
 */
export const timeframedReactionSums = REACTIONS.map((reaction) => {
  const windows = [
    `tf.timeframe = 'AllTime'`,
    `tf.timeframe = 'Year' AND r."createdAt" > (NOW() - interval '365 days')`,
    `tf.timeframe = 'Month' AND r."createdAt" > (NOW() - interval '30 days')`,
    `tf.timeframe = 'Week' AND r."createdAt" > (NOW() - interval '7 days')`,
    `tf.timeframe = 'Day' AND r."createdAt" > (NOW() - interval '1 days')`,
  ]
    .map((w) => `WHEN ${w} THEN 1`)
    .join('\n          ');
  // `IS NOT TRUE` rather than `NOT (...)`: under the LEFT JOIN an unmatched row makes the
  // condition NULL, which would otherwise fall through to the AllTime arm and count a
  // reaction that is not there.
  return `SUM(CASE
          WHEN (r.reaction = '${reaction}') IS NOT TRUE THEN 0
          ${windows}
          ELSE 0
        END)::int AS "${reaction.toLowerCase()}Count"`;
}).join(',\n        ');

export const reactionAssignments = REACTIONS.map(
  (r) => `"${r.toLowerCase()}Count" = s."${r.toLowerCase()}Count"`
).join(',\n        ');

/**
 * `IS DISTINCT FROM` rather than `!=` so a NULL column still counts as a difference, and
 * the predicate at all so a row already carrying the filtered total is left untouched —
 * that is what makes the reported count a measure of what was WRONG rather than of how
 * many rows the scan visited.
 */
export const reactionDiffers = REACTIONS.map(
  (r) => `m."${r.toLowerCase()}Count" IS DISTINCT FROM s."${r.toLowerCase()}Count"`
).join('\n          OR ');

type EntitySpec = {
  maxIdSql: string;
  metricTable: string;
  idColumn: string;
  timeframed: boolean;
  ctes: (args: { start: number; end: number; excluded: string }) => string;
};

export const specs: Record<Entity, EntitySpec> = {
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
        ${allTimeReactionSums}
        FROM affected a
        LEFT JOIN "ArticleReaction" r
          ON r."articleId" = a.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id
      )`,
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
        ${timeframedReactionSums}
        FROM affected a
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        LEFT JOIN "BountyEntryReaction" r
          ON r."bountyEntryId" = a.id AND r."userId" NOT IN (${excluded})
        GROUP BY a.id, tf.timeframe
      )`,
  },
};

export function buildSql(spec: EntitySpec, args: { start: number; end: number; excluded: string }) {
  const timeframeMatch = spec.timeframed ? 'm.timeframe = s.timeframe' : "m.timeframe = 'AllTime'";
  const match = `m."${spec.idColumn}" = s.id AND ${timeframeMatch} AND (${reactionDiffers})`;
  return {
    // A dry run runs the IDENTICAL scan — the point is to learn how many rows would
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

/**
 * Inclusive at both ends and gapless. The repo's own `backfill-post-metrics.ts` template
 * bounds batches with `> start`, which skips the first id of every batch — silently,
 * because the run still reports rows.
 */
export function planRanges(start: number, end: number, batchSize: number) {
  const ranges: Array<[number, number]> = [];
  for (let lo = start; lo <= end; lo += batchSize) {
    ranges.push([lo, Math.min(lo + batchSize - 1, end)]);
  }
  return ranges;
}

export function digestOf(ids: number[]) {
  return createHash('sha256')
    .update([...ids].sort((a, b) => a - b).join(','))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Read with the app's own query, and THROW rather than degrade. An empty or unreadable
 * list makes every computed sum equal its stored value, so the run would rewrite nothing
 * and report a clean sweep — the failure mode this whole script exists to remove.
 */
export async function fetchExcludedUserIds(): Promise<number[]> {
  const host = process.env.CLICKHOUSE_HOST;
  const username = process.env.CLICKHOUSE_USERNAME;
  if (!host || !username) throw new Error('CLICKHOUSE_HOST and CLICKHOUSE_USERNAME must be set');

  const res = await fetch(`${host}/?default_format=JSONCompact`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': username,
      'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD ?? '',
    },
    body: 'SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1',
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as { data: [number][] };
  // `> 0` because `Number(null)` is 0, not NaN: a null column would otherwise enter the
  // list as user 0 and suppress whatever writes that id. Matches the app's own coercion.
  const ids = body.data.map((row) => Number(row[0])).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error('exclusion list is empty — refusing to run');
  return ids;
}

/**
 * Which statement a run issues. Extracted from `main` and exported ONLY so a test can
 * reach it: with the choice inlined, replacing it with `sql.write` left every assertion
 * green, because nothing executed the function it lived in. The one guard between a dry
 * run and a production write cannot sit in untested code.
 */
export function sqlFor(
  spec: EntitySpec,
  args: { start: number; end: number; excluded: string },
  write: boolean
) {
  const sql = buildSql(spec, args);
  return write ? sql.write : sql.dry;
}

export type RunOptions = {
  write: boolean;
  propagate: boolean;
  entities: Entity[];
  batchSize: number;
  start?: number;
  end?: number;
};

/**
 * Exported for the same reason as `sqlFor` — the defaults ARE the safety, and a default
 * nothing asserts is a default that can be flipped without anything going red.
 */
export function parseArgs(argv: string[]): RunOptions {
  const has = (name: string) => argv.includes(`--${name}`);
  const val = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const entityArg = val('entity') ?? 'all';
  if (entityArg !== 'all' && !ENTITIES.includes(entityArg as Entity))
    throw new Error(`--entity must be one of ${ENTITIES.join(', ')}, all`);

  const write = has('write');
  return {
    write,
    // Gated on `write` here rather than at the call site, so there is one place to read
    // and one place to test. Propagation busts the production article cache and queues a
    // production reindex, and the app's .env points both at production whichever database
    // is configured — so a dry run must not reach them even if asked.
    propagate: has('propagate') && write,
    entities: entityArg === 'all' ? [...ENTITIES] : [entityArg as Entity],
    batchSize: Number(val('batch-size') ?? 10000),
    start: val('start') === undefined ? undefined : Number(val('start')),
    end: val('end') === undefined ? undefined : Number(val('end')),
  };
}

async function main() {
  const {
    write,
    propagate,
    entities,
    batchSize,
    start: argStart,
    end: argEnd,
  } = parseArgs(process.argv);

  const excludedIds = await fetchExcludedUserIds();
  for (const id of excludedIds) {
    if (!Number.isInteger(id)) throw new Error(`non-integer excluded user id: ${id}`);
  }
  const excluded = excludedIds.join(',');

  console.log(
    `exclusion list: ${excludedIds.length} ids, digest ${digestOf(excludedIds)}` +
      `\nmode: ${write ? 'WRITE' : 'dry run'}${propagate ? ' + propagate' : ''}`
  );

  const prisma = new PrismaClient();
  try {
    for (const entity of entities) {
      const spec = specs[entity];
      const [{ max }] = await prisma.$queryRawUnsafe<{ max: number | null }[]>(spec.maxIdSql);
      const start = argStart ?? 0;
      const end = argEnd ?? max ?? 0;

      const changed: number[] = [];
      const ranges = planRanges(start, end, batchSize);
      for (const [lo, hi] of ranges) {
        const sql = sqlFor(spec, { start: lo, end: hi, excluded }, write);
        const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(sql);
        for (const row of rows) changed.push(row.id);
      }

      const ids = [...new Set(changed)];
      console.log(
        `[${entity}] ${start}-${end} in ${ranges.length} batch(es): ` +
          `${changed.length} row(s) ${write ? 'written' : 'would change'}, ${
            ids.length
          } distinct id(s)`
      );

      if (entity === 'article' && ids.length)
        console.log(`[article] ids: ${ids.slice(0, 50).join(',')}${ids.length > 50 ? ' …' : ''}`);

      if (propagate && entity === 'article' && ids.length) await propagateArticles(ids);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Both halves, because `article.metrics.ts` does both after writing the same rows: the
 * Meilisearch document carries the AllTime reaction counts verbatim, and these rows are
 * by definition ones the job will never revisit, so an unqueued document is wrong
 * permanently rather than merely stale.
 *
 * Routed through the deployed internal endpoint rather than calling the app's own
 * `queueUpdate`, which goes through `addToQueue` and FAILS OPEN in a standalone script:
 * `sysRedis` is never connected, every enqueue is skipped, and the script prints success
 * and exits 0. Measured here 2026-08-31 — 332 ids "queued", 0 of them in the queue.
 */
async function propagateArticles(ids: number[]) {
  const base = process.env.INTERNAL_BASE_URL ?? 'https://civitai.com';
  const token = process.env.WEBHOOK_TOKEN;
  if (!token) throw new Error('WEBHOOK_TOKEN must be set to propagate');

  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    const res = await fetch(`${base}/api/internal/search-index-update?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityType: 'article', entityIds: batch, action: 'update' }),
    });
    if (!res.ok) throw new Error(`search-index-update ${res.status}: ${await res.text()}`);
    console.log(`[article] queued ${batch.length} id(s) for reindex`);
  }

  const res = await fetch(
    `${base}/api/admin/clear-cache-by-pattern?token=${token}&pattern=packed:caches:article-stats`
  );
  if (!res.ok) throw new Error(`clear-cache-by-pattern ${res.status}: ${await res.text()}`);
  // The whole hash, not the changed fields: the endpoint is pattern-based, and article
  // stats repopulate from ArticleMetric on read. Stated because it is a wider bust than
  // the ids we changed, and somebody will ask.
  console.log('[article] article-stats cache cleared');
}

// Only when run as a script. Without this the builders below cannot be imported — a test
// that reads the SQL would execute the whole run on import, and `process.exit` inside a
// vitest worker is an unhandled rejection rather than a failed assertion.
if (process.argv[1]?.includes('backfill-reaction-metric-exclusions')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
