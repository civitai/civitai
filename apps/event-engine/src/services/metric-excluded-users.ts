import { SimpleClickhouse } from '@/common/utils/query-utils';
import { logger } from '@/utils/logger';
import { excludedUsersMetrics } from '@/metrics';

/**
 * The reaction-farm suppression list, cached in memory.
 *
 * `metricExcludedUsers` is written by `/api/admin/reaction-abuse` and filtered by
 * the ClickHouse aggregate the metric cache repopulates from (those view
 * definitions live in ClickHouse, not in this repo). The Redis increment path did
 * not filter it, so `metrics:<type>:<id>` counted suppressed reactions until its
 * 12h TTL lapsed, and the value a user saw depended on cache age.
 *
 * Excluded accounts are NOT banned, deleted or muted: this list suppresses
 * metrics only, so nothing else in the pipeline drops their rows.
 */
export interface ExcludedUserLookup {
  has(userId?: number | string | null): boolean;
}

const REFRESH_QUERY = `SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1`;
const MIN_REFRESH_MS = 1000;

export class MetricExcludedUsers implements ExcludedUserLookup {
  private ch: SimpleClickhouse;
  private ids: Set<number> = new Set();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(chClient: ConstructorParameters<typeof SimpleClickhouse>[0], intervalMs: number) {
    this.ch = new SimpleClickhouse(chClient);
    // parseInt('5m') is 5 and parseInt('abc') is NaN, which setInterval clamps to 1ms —
    // a ClickHouse query loop from every pod, silent because refresh() swallows its errors.
    this.intervalMs = Number.isFinite(intervalMs)
      ? Math.max(MIN_REFRESH_MS, intervalMs)
      : MIN_REFRESH_MS;
  }

  /**
   * Loads once, then on an interval. Never throws: a ClickHouse failure at boot leaves
   * the set empty — the pre-fix behaviour of counting everything. Failing closed would
   * drop every increment and freeze every displayed count.
   */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        excludedUsersMetrics.refreshErrors.inc({ cause: 'unexpected' });
        logger.error({ err }, 'Metric exclusion refresh threw unexpectedly');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info(
      `Metric exclusion list started (${this.ids.size} users, refresh ${Math.round(
        this.intervalMs / 1000
      )}s)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    try {
      // Iterating INSIDE the try is load-bearing: SimpleClickhouse casts `response?.json()`
      // to T[] through an optional chain, so a nullish response is typed as an array and is
      // not one — iterating outside would throw out of the void'ed interval callback.
      const rows = await this.ch.query<{ userId: number | string }>(REFRESH_QUERY);

      const next = new Set<number>();
      for (const row of rows) {
        const id = Number(row.userId);
        // `Number(null)` and `Number('')` are 0, not NaN, so isFinite alone admits junk
        // rows as 0 — the same id update-compensation writes on its model-earnings rows.
        if (Number.isFinite(id) && id > 0) next.add(id);
      }

      // Do NOT re-add a guard that keeps the previous set on an empty result. `unexclude`
      // takes up to 5000 ids in one call, so an empty list is a real state; keeping the old
      // set would suppress those users with no TTL until a pod restart.
      if (next.size === 0 && this.ids.size > 0) {
        logger.warn(
          { previousSize: this.ids.size },
          'Metric exclusion list is now empty; nothing will be suppressed'
        );
      }

      this.ids = next;
      this.loaded = true;
      excludedUsersMetrics.size.set(next.size);
    } catch (err) {
      excludedUsersMetrics.refreshErrors.inc({ cause: 'query' });
      logger.error({ err }, 'Failed to refresh metric exclusion list; keeping previous set');
    }
  }

  /**
   * Coerces: callers' `userId` is typed by assertion, not validation — handlers read it
   * off an untyped Debezium record, and update-compensation casts raw ClickHouse rows to
   * CacheUpdate, where 64-bit columns arrive as strings. `Set<number>.has('6680940')` is
   * false, so without this a farm user is counted and every test still passes.
   */
  has(userId?: number | string | null): boolean {
    if (userId == null || userId === '') return false;
    const id = Number(userId);
    return Number.isFinite(id) && this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
