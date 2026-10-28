import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import type { JobContext } from '~/server/jobs/job';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:collection-item-counts');

// Counts read straight from CollectionItem, not summed from ClickHouse events: a collect is a
// current fact with a clean Postgres source, and a per-row event sum counts a user once per
// collection holding the item (one account had one article in 503 of them).
//
// collectedCount: distinct collectors, each counted once however many of their collections hold
// it. The collector is the row's adder, or the owner of a Bookmark collection, whose rows were
// written without one for a while.
// itemCount: the collection's items.
// Both count ACCEPTED rows only: a rejected or in-review item is in no one's collection publicly.
const COUNTS = {
  Article: { column: 'articleId', metric: 'collectedCount', distinct: true },
  Model: { column: 'modelId', metric: 'collectedCount', distinct: true },
  Post: { column: 'postId', metric: 'collectedCount', distinct: true },
  Collection: { column: 'collectionId', metric: 'itemCount', distinct: false },
} as const;

export type CollectionItemCountEntity = keyof typeof COUNTS;

const COLLECTOR = `COALESCE(ci."addedById", CASE WHEN c.mode = 'Bookmark' AND c."userId" > 0 THEN c."userId" END)`;

/** $1 the entity ids; $2, for collectedCount, the metric-excluded users. */
export function collectionItemCountSql(entityType: CollectionItemCountEntity) {
  const { column, distinct } = COUNTS[entityType];
  return distinct
    ? `-- distinct collectors per ${entityType}
      SELECT ci."${column}" AS id, count(DISTINCT ${COLLECTOR})::int AS n
      FROM "CollectionItem" ci
      JOIN "Collection" c ON c.id = ci."collectionId"
      WHERE ci."${column}" = ANY($1::int[])
        AND ci.status = 'ACCEPTED'
        AND ${COLLECTOR} IS NOT NULL
        AND ${COLLECTOR} <> ALL($2::int[])
      GROUP BY 1`
    : `-- items per collection
      SELECT ci."collectionId" AS id, count(*)::int AS n
      FROM "CollectionItem" ci
      WHERE ci."collectionId" = ANY($1::int[])
        AND ci.status = 'ACCEPTED'
      GROUP BY 1`;
}

const BATCH_SIZE = 200;

// Events are stamped with their Postgres commit time and land in ClickHouse only when the event
// engine gets to them, so this looks back well past the run interval. An entity whose event
// arrives later than this is recounted only when it next changes. A recount is idempotent, so the
// overlap costs only repeated reads.
export const LOOKBACK_MS = 15 * 60 * 1000;

// The affected-entity read scans the month of raw events for the type, so it runs once per
// interval, as the ClickHouse-sum version did; queued ids are recounted on every run.
const INTERVAL_MS = 5 * 60 * 1000;
const sameInterval = (a: Date, b: Date) =>
  Math.floor(a.getTime() / INTERVAL_MS) === Math.floor(b.getTime() / INTERVAL_MS);

type Context = {
  pg: AugmentedPool;
  ch: CustomClickHouseClient;
  jobContext: JobContext;
  lastUpdate: Date;
  queue: number[];
  updates: Record<number, Record<string, number>>;
  idKey: string;
  addAffected?: (ids: number[]) => void;
};

/**
 * Tasks that recount the metric for every entity with a CollectionItem event since the last run,
 * plus the queue. The events only say which entities changed; the value comes from Postgres, so
 * an entity whose rows are all gone is written as 0.
 */
export function getCollectionItemCountTasks(ctx: Context) {
  return async function (entityType: CollectionItemCountEntity) {
    const { metric, distinct } = COUNTS[entityType];
    const since = new Date(ctx.lastUpdate.getTime() - LOOKBACK_MS);
    const events = sameInterval(ctx.lastUpdate, new Date())
      ? []
      : await ctx.ch.$query<{ entityId: number }>`
          SELECT DISTINCT entityId
          FROM entityMetricEvents_month
          WHERE entityType = '${entityType}'
            AND metricType = '${metric}'
            AND createdAt >= ${since}
        `;
    const affected = [...new Set([...events.map((x) => x.entityId), ...ctx.queue])];
    ctx.addAffected?.(affected);
    if (!affected.length) return [];

    // Read once per run, and fail the run rather than count suppressed accounts.
    const excluded = distinct ? await getMetricExcludedUserIdsOrThrow() : [];
    const sql = collectionItemCountSql(entityType);

    const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log(`${entityType} ${metric}`, i + 1, 'of', tasks.length);
      const query = await ctx.pg.cancellableQuery<{ id: number; n: number }>(
        sql,
        distinct ? [ids, excluded] : [ids]
      );
      ctx.jobContext.on('cancel', query.cancel);
      const counts = new Map((await query.result()).map((r) => [r.id, r.n]));
      for (const id of ids) {
        ctx.updates[id] ??= { [ctx.idKey]: id };
        ctx.updates[id][metric] = counts.get(id) ?? 0;
      }
    });
    return tasks;
  };
}
