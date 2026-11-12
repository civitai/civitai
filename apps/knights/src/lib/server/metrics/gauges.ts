import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import { Gauge, type Registry } from 'prom-client';
import { REFERENCE_POOL } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';
import { votePartitionName } from '../queue/vote-partition';
import { YESNO_SOURCE } from '../yesno/keys';

/** Yes/no questions are served apart from the stage feed, so they are their own stage here. */
export const QUEUE_STAGES = [...KNIGHTS_STAGE_RANKS, 'yesno'] as const;
/** The producers named in `CLAUDE.md` "Sources"; anything else counts as `other`. */
export const QUEUE_SOURCES = ['scan-sample', 'owner-rating', YESNO_SOURCE, 'other'] as const;
export const REFERENCE_POOLS = Object.values(REFERENCE_POOL);

const STUCK_AFTER_MS = 15 * 60_000;
const OVERDUE_AFTER_MS = 15 * 60_000;
const FAILED_GRANT_WINDOW_MS = 24 * 3_600_000;
/** The newest-item gauge reads only this many of the newest queue rows: there is no index on `source`. */
const NEWEST_ITEMS_WINDOW = 50_000;
const STATEMENT_TIMEOUT_MS = 5_000;
export const GAUGE_TTL_MS = 60_000;

export type GaugeSnapshot = {
  open: Record<string, { count: number; oldestAgeSeconds: number }>;
  newestAgeSeconds: Partial<Record<string, number>>;
  overdue: number;
  inquisitor: number;
  writebackPending: number;
  buzzGrantsStuck: { failed: number; pending: number };
  shopPurchasesStuck: number;
  referencePool: Record<string, number>;
  harvestLastRun: Date | null;
  notifyLastSend: Date | null;
  nextPartitionReady: boolean;
};

const ago = (now: Date, ms: number) => utc(new Date(now.getTime() - ms));
const ageSeconds = (now: Date, at: Date) => Math.max(0, (now.getTime() - at.getTime()) / 1000);

/** One cheap aggregate per gauge, in one read-only transaction with a statement timeout. Throws when the database does. */
export async function readGaugeSnapshot(db: Kysely<DB>, now: Date): Promise<GaugeSnapshot> {
  return db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`).execute(trx);

    // (status, minRank, priority, createdAt) index: the Open rows only.
    const open = await trx
      .selectFrom('KnightsQueueItem')
      .select([
        sql<string>`CASE WHEN "audience" IS NOT NULL THEN 'yesno' ELSE "minRank" END`.as('stage'),
        sql<number>`count(*)::int`.as('n'),
        sql<Date>`min("createdAt")`.as('oldest'),
      ])
      .where('status', '=', 'Open')
      .groupBy(sql`1`)
      .execute();

    // Backward walk of the primary key over the newest rows only.
    const newest = await trx
      .selectFrom(
        trx
          .selectFrom('KnightsQueueItem')
          .select(['source', 'createdAt'])
          .orderBy('id', 'desc')
          .limit(NEWEST_ITEMS_WINDOW)
          .as('recent')
      )
      .select(['source', sql<Date>`max("createdAt")`.as('newest')])
      .groupBy('source')
      .execute();

    const countItems = async (
      where: (eb: ExpressionBuilder<DB, 'KnightsQueueItem'>) => Expression<SqlBool>
    ) =>
      (
        await trx
          .selectFrom('KnightsQueueItem')
          .select(sql<number>`count(*)::int`.as('n'))
          .where(where)
          .executeTakeFirstOrThrow()
      ).n;
    // (status, expiresAt) index.
    const overdue = await countItems((eb) =>
      eb.and([eb('status', '=', 'Open'), eb('expiresAt', '<', ago(now, OVERDUE_AFTER_MS))])
    );
    const inquisitor = await countItems((eb) => eb('status', '=', 'Inquisitor'));
    // (status, appliedAt) index: only the unapplied Resolved rows, not every Resolved item.
    const writebackPending = await countItems((eb) =>
      eb.and([
        eb('status', '=', 'Resolved'),
        eb('appliedAt', 'is', null),
        eb('applyAttempts', '>', 0),
      ])
    );

    // (status, createdAt) index.
    const grants = await trx
      .selectFrom('KnightsGoldConversion')
      .select([
        sql<number>`count(*) FILTER (WHERE "status" = 'failed')::int`.as('failed'),
        sql<number>`count(*) FILTER (WHERE "status" = 'pending' AND "createdAt" < ${ago(
          now,
          STUCK_AFTER_MS
        )})::int`.as('pending'),
      ])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('status', '=', 'failed'),
            eb('createdAt', '>=', ago(now, FAILED_GRANT_WINDOW_MS)),
          ]),
          eb('status', '=', 'pending'),
        ])
      )
      .executeTakeFirstOrThrow();

    // Partial index on pending purchases.
    const purchases = await trx
      .selectFrom('KnightsShopPurchase')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', '=', 'pending')
      .where('createdAt', '<', ago(now, STUCK_AFTER_MS))
      .executeTakeFirstOrThrow();

    // (pool, status, source) index.
    const pools = await trx
      .selectFrom('KnightsReferenceImage')
      .select(['pool', sql<number>`count(*)::int`.as('n')])
      .where('status', '=', 'active')
      .groupBy('pool')
      .execute();

    const harvest = await trx
      .selectFrom('KnightsHarvestCursor')
      .select(sql<Date | null>`max("updatedAt")`.as('at'))
      .executeTakeFirstOrThrow();

    // No index leads with sentAt: this reads the whole table.
    const notify = await trx
      .selectFrom('KnightsNotificationSend')
      .select(sql<Date | null>`max("sentAt")`.as('at'))
      .executeTakeFirstOrThrow();

    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const partition = votePartitionName({
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
    });
    const ready = await sql<{ ready: boolean }>`
      SELECT to_regclass(${`"${partition}"`}) IS NOT NULL AS ready
    `.execute(trx);

    const newestAgeSeconds: Partial<Record<string, number>> = {};
    for (const row of newest) {
      const source = (QUEUE_SOURCES as readonly string[]).includes(row.source)
        ? row.source
        : 'other';
      const age = ageSeconds(now, row.newest);
      newestAgeSeconds[source] = Math.min(newestAgeSeconds[source] ?? Infinity, age);
    }

    return {
      open: Object.fromEntries(
        open.map((row) => [
          row.stage,
          { count: row.n, oldestAgeSeconds: ageSeconds(now, row.oldest) },
        ])
      ),
      newestAgeSeconds,
      overdue,
      inquisitor,
      writebackPending,
      buzzGrantsStuck: { failed: grants.failed, pending: grants.pending },
      shopPurchasesStuck: purchases.n,
      referencePool: Object.fromEntries(pools.map((row) => [row.pool, row.n])),
      harvestLastRun: harvest.at,
      notifyLastSend: notify.at,
      nextPartitionReady: ready.rows[0]?.ready === true,
    };
  });
}

type Load = () => Promise<GaugeSnapshot | null>;

/** Memoises one read per `ttlMs`, failures included. A failed read resolves to null instead of throwing. */
export function cachedSnapshot(
  read: () => Promise<GaugeSnapshot>,
  { ttlMs = GAUGE_TTL_MS, clock = Date.now } = {}
): Load {
  let cached: { at: number; value: Promise<GaugeSnapshot | null> } | null = null;
  return () => {
    if (!cached || clock() - cached.at >= ttlMs) {
      cached = {
        at: clock(),
        value: read().catch((error) => {
          console.error('knights: metrics gauge query failed', error);
          return null;
        }),
      };
    }
    return cached.value;
  };
}

/** The process's own database, imported on the first scrape so loading the metrics never opens it. */
export const loadGaugeSnapshot: Load = cachedSnapshot(async () => {
  const { db } = await import('../db');
  return readGaugeSnapshot(db, new Date());
});

const seconds = (at: Date) => at.getTime() / 1000;

/** Every gauge reads one shared snapshot; with none (database down), `knights_db_up` is 0 and the others are absent or NaN. */
export function registerGauges(register: Registry, load: Load) {
  const gauge = <L extends string>(
    name: string,
    help: string,
    labelNames: readonly L[],
    fill: (g: Gauge<L>, s: GaugeSnapshot) => void
  ) =>
    new Gauge<L>({
      name,
      help,
      labelNames,
      registers: [register],
      async collect() {
        const snapshot = await load();
        this.reset();
        if (snapshot) fill(this, snapshot);
        // A gauge without labels always exports a sample; NaN says "unknown" without tripping a threshold.
        else if (labelNames.length === 0) (this as Gauge<string>).set(NaN);
      },
    });

  new Gauge({
    name: 'knights_db_up',
    help: '1 when the gauge queries could read the database, 0 when they failed.',
    registers: [register],
    async collect() {
      this.set((await load()) ? 1 : 0);
    },
  });
  gauge('knights_queue_open_items', 'Open queue items by stage.', ['stage'], (g, s) => {
    for (const stage of QUEUE_STAGES) g.set({ stage }, s.open[stage]?.count ?? 0);
  });
  gauge(
    'knights_queue_oldest_open_age_seconds',
    'Age of the oldest open queue item by stage (0 when the stage is empty).',
    ['stage'],
    (g, s) => {
      for (const stage of QUEUE_STAGES) g.set({ stage }, s.open[stage]?.oldestAgeSeconds ?? 0);
    }
  );
  gauge(
    'knights_queue_newest_item_age_seconds',
    `Age of the newest queue item by source, among the newest ${NEWEST_ITEMS_WINDOW} items (absent when none).`,
    ['source'],
    (g, s) => {
      for (const source of QUEUE_SOURCES) {
        const age = s.newestAgeSeconds[source];
        if (age !== undefined) g.set({ source }, age);
      }
    }
  );
  gauge(
    'knights_queue_overdue_items',
    'Open queue items more than 15 minutes past expiresAt (the tick escalates these).',
    [],
    (g, s) => g.set(s.overdue)
  );
  gauge('knights_inquisitor_items', 'Items waiting for an Inquisitor ruling.', [], (g, s) =>
    g.set(s.inquisitor)
  );
  gauge(
    'knights_writeback_pending_items',
    'Resolved ratings not yet written to the image after at least one failed try.',
    [],
    (g, s) => g.set(s.writebackPending)
  );
  gauge(
    'knights_buzz_grants_stuck',
    'Shop Buzz grants that failed in the last 24 hours (failed) or are unconfirmed after 15 minutes (pending).',
    ['state'],
    (g, s) => {
      g.set({ state: 'failed' }, s.buzzGrantsStuck.failed);
      g.set({ state: 'pending' }, s.buzzGrantsStuck.pending);
    }
  );
  gauge(
    'knights_shop_purchases_stuck',
    'Shop purchases still pending after 15 minutes.',
    [],
    (g, s) => g.set(s.shopPurchasesStuck)
  );
  gauge('knights_reference_pool_items', 'Active reference images by pool.', ['pool'], (g, s) => {
    for (const pool of REFERENCE_POOLS) g.set({ pool }, s.referencePool[pool] ?? 0);
  });
  gauge(
    'knights_harvest_last_run_timestamp_seconds',
    'When the harvest job last moved its cursor (NaN before its first run).',
    [],
    (g, s) => {
      g.set(s.harvestLastRun ? seconds(s.harvestLastRun) : NaN);
    }
  );
  gauge(
    'knights_notify_last_send_timestamp_seconds',
    'When the notify job last sent a notification (NaN before its first send).',
    [],
    (g, s) => {
      g.set(s.notifyLastSend ? seconds(s.notifyLastSend) : NaN);
    }
  );
  gauge(
    'knights_vote_partition_next_month_ready',
    "1 when next month's KnightsVote partition exists.",
    [],
    (g, s) => g.set(s.nextPartitionReady ? 1 : 0)
  );
}
