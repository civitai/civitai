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
 * Two measurements from the post arm, kept here because the repo squash-merges and they
 * would otherwise survive only in a commit body that the squash discards:
 *   - The post scan has a batch-size CLIFF, not a slope. Measured on the prod replica
 *     2026-09-21: at 1,000 ids the planner loops `Image (postId_covered_idx)` into
 *     `ImageReaction_imageId_createdAt` and takes ~0.9 s; at 10,000 it flips to a hash
 *     join whose probe side is a whole-index scan of `ImageReaction` (est. 6.9M rows) and
 *     does not finish inside the pooler's ~60 s ceiling. The flip bisects to 3,700-3,800.
 *     A growing exclusion list and a growing `ImageReaction` both move it LATER.
 *   - Article and bountyEntry have no cliff to find: their entire id spaces aggregate in
 *     166 ms and 643 ms. That is why this file has one batch size and no concurrency knob
 *     — both existed for post, and left with it.
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
import { excludedReactorFilter } from '~/shared/utils/excluded-reactor-filter';
import { ReviewReactions } from '~/shared/utils/prisma/enums';

const ENTITIES = ['article', 'bountyEntry'] as const;
type Entity = (typeof ENTITIES)[number];

/** The endpoint caps `entityIds` at 1000; this must not exceed it. */
const SEARCH_INDEX_BATCH = 1000;

/** Pinned against this file's own name by a test — see the entrypoint guard at the end. */
const SCRIPT_BASENAME = 'backfill-reaction-metric-exclusions';

/** Issues one statement and returns its rows. Injected so a test can see what a run sends. */
export type Executor = (sql: string) => Promise<{ id: number }[]>;

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

export type EntitySpec = {
  maxIdSql: string;
  metricTable: string;
  idColumn: string;
  timeframed: boolean;
  ctes: (args: { start: number; end: number; excluded: string }) => string;
  /**
   * Everything downstream of the metric row that has to learn the new value. The metric
   * JOB is the reference for what belongs here. bountyEntry has none: `bountyEntry.metrics.ts`
   * busts no cache and queues no index, so there is nothing downstream to tell.
   */
  propagate?: (ids: number[]) => Promise<void>;
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
    // Article is the only entity with anything downstream. Carried on the spec rather
    // than as an `entity === 'article'` test in the loop: that condition sat in `main`,
    // where dropping it would have POSTed bountyEntry ids as article ids to a production
    // reindex with nothing going red.
    propagate: (ids) => propagateArticles(ids),
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

/** The discovery half on its own — entities carrying a reaction from an excluded account. */
export function affectedSql(
  spec: EntitySpec,
  args: { start: number; end: number; excluded: string }
) {
  return `
      WITH ${spec.ctes(args)}
      SELECT id FROM affected`;
}

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

/**
 * Which database this run is about to write to, printed before it writes. There is no
 * `--prod` / `--dev` flag here — the target is whatever `DATABASE_URL` happens to name,
 * and in a worktree that is usually the dev snapshot while every other credential in the
 * same `.env` points at production. "I thought it was pointed at dev" is not a thing that
 * can be checked after the fact, so it is stated before.
 *
 * Never includes the password: this line ends up in logs and in reports.
 */
export function describeTarget(url: string | undefined) {
  if (!url) return 'DATABASE_URL is not set';
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return 'DATABASE_URL is set but unparseable';
  }
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

  // Every numeric option is validated rather than coerced. `--end abc` is `NaN`, which
  // `planRanges` turns into ZERO batches and a `0 row(s) would change` report — a typo
  // and a clean sweep are then the same output, which is the failure this script exists
  // to remove. `--end` with no value reads as undefined, i.e. the whole table, which
  // differs from `--end 100` by one missing token.
  const num = (name: string, fallback?: number) => {
    const raw = val(name);
    if (raw === undefined || raw.startsWith('--')) {
      if (fallback !== undefined) return fallback;
      if (raw === undefined) return undefined;
      throw new Error(`--${name} needs a value`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${raw}`);
    return n;
  };

  const batchSize = num('batch-size', 10000) as number;
  // `planRanges` advances by batchSize, so anything below 1 is a synchronous loop that
  // never terminates — an out-of-memory crash, not a failure anyone can read.
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error(`--batch-size must be a positive integer, got ${batchSize}`);

  const write = has('write');
  const propagate = has('propagate') && write;
  // Checked here rather than inside the propagation itself, which runs AFTER the whole
  // table is written: a missing token would otherwise fail a run that had already done
  // all of its work.
  if (propagate) propagationTarget();

  return {
    write,
    // Gated on `write` here rather than at the call site, so there is one place to read
    // and one place to test. Propagation busts the production article cache and queues a
    // production reindex, and the app's .env points both at production whichever database
    // is configured — so a dry run must not reach them even if asked.
    propagate,
    entities: entityArg === 'all' ? [...ENTITIES] : [entityArg as Entity],
    batchSize,
    start: num('start'),
    end: num('end'),
  };
}

/**
 * Where propagation sends its requests, and the token it uses.
 *
 * `INTERNAL_BASE_URL` has NO default. Propagation is always a production action — it
 * flushes the production article cache and queues a production reindex — and the hazard
 * is running it during what feels like a dev rehearsal, because `DATABASE_URL` pointing
 * at the dev snapshot does not move either of those. Requiring the variable means
 * propagation cannot happen unless somebody consciously aimed it.
 */
export function propagationTarget() {
  const base = process.env.INTERNAL_BASE_URL;
  const token = process.env.WEBHOOK_TOKEN;
  if (!base)
    throw new Error(
      'INTERNAL_BASE_URL must be set explicitly to propagate — it has no default, ' +
        'because propagation hits production regardless of which database you wrote to'
    );
  if (!token) throw new Error('WEBHOOK_TOKEN must be set to propagate');
  return { base, token };
}

/**
 * The per-entity run, with the statement executor INJECTED.
 *
 * This is its own exported function because `main` is unreachable from a test, and the
 * decisions that live in a loop body turn out to be the ones that matter. An earlier
 * round moved the dry/write choice into `sqlFor` so a test could reach it — and the CALL
 * SITE passing `write` stayed in `main`, where mutating it to a literal `true` still
 * passed every assertion. Extraction relocates an untested boundary; it does not remove
 * one. With the executor injected a fake can assert which statements a run actually
 * issues, which is the property itself rather than a proxy for it.
 */
export async function runEntity(args: {
  exec: Executor;
  spec: EntitySpec;
  excluded: string;
  write: boolean;
  ranges: Array<[number, number]>;
}) {
  const { exec, spec, excluded, write, ranges } = args;
  const changed: number[] = [];
  const failures: Array<{ range: [number, number]; message: string }> = [];

  for (const [lo, hi] of ranges) {
    try {
      const rows = await exec(sqlFor(spec, { start: lo, end: hi, excluded }, write));
      for (const row of rows) changed.push(row.id);
    } catch (e) {
      // Counted and carried rather than thrown: the batches before this one are already
      // committed, and letting the error escape discards the id list. The brief asked for
      // this counter, an earlier revision had it, and it was lost in the move to a script.
      failures.push({ range: [lo, hi], message: (e as Error).message });
    }
  }

  // Both numbers, because for bountyEntry they differ by a factor of five and each
  // answers a different question. `rows` is the blast radius — the count of metric rows
  // rewritten, which is what a reviewer wants. `ids` is the propagation set, which is
  // per entity. Reporting one under the other's name understates bountyEntry's write by
  // 5x, which is exactly what happened when this returned only the deduplicated ids.
  return { rows: changed.length, ids: [...new Set(changed)], failures };
}

/**
 * Ids carrying a reaction from an excluded account, whether or not this run changed them.
 *
 * Propagation reads from HERE rather than from the rows a run happened to write, because
 * the two diverge in the ordinary case. The natural operator flow is `--write`, read the
 * numbers, then `--write --propagate` — and by the second run `IS DISTINCT FROM` matches
 * nothing, so a propagation driven by "what changed this time" would queue nothing at
 * all. Same after an interrupted run: those rows are committed, never selected again,
 * and their ids would be gone for good. Re-queueing an article that was already correct
 * costs one reindex and is otherwise a no-op, which is the cheap side of the trade.
 */
export async function collectAffected(args: {
  exec: Executor;
  spec: EntitySpec;
  excluded: string;
  ranges: Array<[number, number]>;
}) {
  const { exec, spec, excluded, ranges } = args;
  const ids: number[] = [];
  for (const [lo, hi] of ranges) {
    const rows = await exec(affectedSql(spec, { start: lo, end: hi, excluded }));
    for (const row of rows) ids.push(row.id);
  }
  return [...new Set(ids)];
}

async function main() {
  const opts = parseArgs(process.argv);
  const { write, propagate, entities, batchSize } = opts;

  const excludedIds = await fetchExcludedUserIds();
  // Validated by the shared module, which already throws on a non-integer and is covered
  // by the existing suite. The hand-rolled copy that used to sit here was the only guard
  // on interpolated SQL text, and it lived in this unreachable function.
  const notIn = excludedReactorFilter(excludedIds);
  if (!notIn) throw new Error('exclusion list produced no filter — refusing to run');
  const excluded = excludedIds.join(',');

  console.log(
    `target: ${describeTarget(process.env.DATABASE_URL)}` +
      `\nexclusion list: ${excludedIds.length} ids, digest ${digestOf(excludedIds)}` +
      `\nmode: ${write ? 'WRITE' : 'dry run'}${
        propagate ? ' + propagate (PRODUCTION cache + index)' : ''
      }`
  );

  const prisma = new PrismaClient();
  const exec: Executor = (sql) => prisma.$queryRawUnsafe<{ id: number }[]>(sql);
  let failed = false;

  try {
    for (const entity of entities) {
      const spec = specs[entity];
      const [{ max }] = await prisma.$queryRawUnsafe<{ max: number | null }[]>(spec.maxIdSql);
      const start = opts.start ?? 0;
      const end = opts.end ?? Number(max ?? 0);
      const ranges = planRanges(start, end, batchSize);

      const { rows, ids, failures } = await runEntity({ exec, spec, excluded, write, ranges });

      console.log(
        `[${entity}] ${start}-${end} in ${ranges.length} batch(es): ` +
          `${rows} row(s) ${write ? 'written' : 'would change'} across ${ids.length} ${entity}(s)` +
          `${failures.length ? `, ${failures.length} FAILED batch(es)` : ''}`
      );
      for (const f of failures) {
        failed = true;
        console.error(`[${entity}] ${f.range[0]}-${f.range[1]} FAILED: ${f.message}`);
      }

      if (propagate && spec.propagate) {
        const affected = await collectAffected({ exec, spec, excluded, ranges });
        console.log(`[${entity}] propagating ${affected.length} affected id(s)`);
        await spec.propagate(affected);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  // A run with a failed batch wrote some rows and not others. Repeating it is safe —
  // `IS DISTINCT FROM` makes the second pass a no-op over what landed — but it must not
  // exit 0, or the failure is invisible to whoever reads the exit code.
  if (failed) throw new Error('one or more batches failed; re-run to converge');
}

/**
 * Queue the article search index and clear the article stat cache.
 *
 * Both halves, because `article.metrics.ts` does both after writing the same rows: the
 * Meilisearch document carries the AllTime reaction counts verbatim, and these are by
 * definition rows the job will never revisit, so an unqueued document is wrong
 * permanently rather than merely stale.
 *
 * Routed through the DEPLOYED internal endpoint rather than the app's own `queueUpdate`,
 * which goes through `addToQueue` and FAILS OPEN in a standalone script: `sysRedis` is
 * never connected, every enqueue is skipped, and the script prints success and exits 0.
 * Measured 2026-08-31 — 332 ids "queued", 0 of them in the queue. Do not simplify this
 * back to `queueUpdate`.
 */
export async function propagateArticles(ids: number[], fetchImpl: typeof fetch = fetch) {
  if (!ids.length) return;
  const { base, token } = propagationTarget();

  for (let i = 0; i < ids.length; i += SEARCH_INDEX_BATCH) {
    const batch = ids.slice(i, i + SEARCH_INDEX_BATCH);
    const res = await fetchImpl(`${base}/api/internal/search-index-update?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityType: 'article', entityIds: batch, action: 'update' }),
    });
    if (!res.ok) throw new Error(`search-index-update ${res.status}: ${await res.text()}`);
    console.log(`[article] queued ${batch.length} id(s) for reindex`);
  }

  const res = await fetchImpl(
    `${base}/api/admin/clear-cache-by-pattern?token=${token}&pattern=packed:caches:article-stats`
  );
  if (!res.ok) throw new Error(`clear-cache-by-pattern ${res.status}: ${await res.text()}`);
  // 🔴 This evicts the stats of EVERY article on the site, not only the ids just written:
  // `packed:caches:article-stats` is one packed hash keyed by articleId, and the endpoint
  // takes a pattern rather than fields. Every article stat read then falls through to
  // ArticleMetric until the hash refills. There is no per-field route through this
  // endpoint, so it is a constraint of going over HTTP rather than a slip — run off-peak.
  console.log('[article] article-stats cache cleared (whole hash, site-wide)');
}

// Only when run as a script — importing the builders above must not execute a run. The
// basename is asserted against this file's own name by a test, because a rename would
// otherwise make this an import-only no-op that exits 0 having done nothing.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
