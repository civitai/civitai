import { SimpleClickhouse } from '@/common/utils/query-utils'
import { cacheKeys } from '@/common/utils/cache-keys'
import { logger } from '@/utils/logger'
import { cacheDriftMetrics } from '@/metrics'

/**
 * Cache Drift Monitor
 *
 * Periodically compares the Redis metric cache (`metrics:{type}:{id}`) against
 * the deduped ClickHouse ground truth for a sample of hot entities, and emits
 * `mew_cache_drift_ratio` (Redis / CH). 1.0 means the cache is exact.
 *
 * This is the leading indicator for the drift class of bug that this service
 * has hit before: non-idempotent Redis increments replayed on consumer
 * rebalance drifted the cache to ~2x the CH truth, and it went unnoticed
 * because nothing compared the two. If the commit-gating regresses, or the
 * populate query / metric naming diverges from what the watcher writes, the
 * ratio departs from 1.0 and an alert can fire instead of someone noticing the
 * numbers "feel wrong".
 *
 * Ground truth reads the v2 view `entityMetricDailyAgg_v2` (already FINAL, no
 * argMax) — the same source the app serves once METRICS_AGG_V2_READ is on. Reads
 * are cheap (top-N hot ids over a 1h window) and run on an interval, so every
 * replica running this adds negligible load; alerts should aggregate with max()
 * across pods.
 */

// Canonical short reaction metric names the watcher writes (CH + Redis).
const REACTION_METRICS = ['Like', 'Heart', 'Laugh', 'Cry'] as const
const ENTITY_TYPE = 'Image'
const SAMPLE_SIZE = 50
// Outside [1/THRESHOLD, THRESHOLD] counts as drifted.
const DRIFT_THRESHOLD = 1.1

interface RedisLike {
  hGetAll(key: string): Promise<Record<string, string>>
}

export class CacheDriftMonitor {
  private ch: SimpleClickhouse
  private timer: NodeJS.Timeout | null = null
  private warmupTimer: NodeJS.Timeout | null = null

  constructor(
    chClient: ConstructorParameters<typeof SimpleClickhouse>[0],
    private redis: RedisLike,
    private intervalMs: number,
  ) {
    this.ch = new SimpleClickhouse(chClient)
  }

  start(): void {
    if (this.timer) return
    // Warm-up delay so the first check doesn't race startup / a cold cache.
    this.warmupTimer = setTimeout(() => void this.runOnce(), 30_000)
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs)
    logger.info(`Cache drift monitor started (every ${Math.round(this.intervalMs / 1000)}s)`)
  }

  stop(): void {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer)
      this.warmupTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async runOnce(): Promise<void> {
    try {
      await this.check()
    } catch (err) {
      cacheDriftMetrics.checkErrors.inc()
      logger.error({ err }, 'cache drift check failed')
    }
  }

  private async check(): Promise<void> {
    // 1. Sample the hottest entities of the last hour — the ones most likely to
    //    be cached and most visible to users.
    const hot = await this.ch.query<{ id: number }>(`
      SELECT entityId AS id
      FROM entityMetricEvents_month
      WHERE entityType = '${ENTITY_TYPE}'
        AND createdAt > now() - INTERVAL 1 HOUR
      GROUP BY entityId
      ORDER BY count() DESC
      LIMIT ${SAMPLE_SIZE}
    `)
    const ids = hot.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
    if (ids.length === 0) return

    // 2. ClickHouse ground truth. Reads the v2 read view
    //    `entityMetricDailyAgg_v2` — the SAME source the app reads once
    //    METRICS_AGG_V2_READ is on. v2 is already FINAL per (entity,metric,day)
    //    (atomic-replace today MV + sealed history), so it needs no argMax dedup
    //    and has none of the churning-RMT staleness the old `entityMetricDailyAgg_new`
    //    table exhibited under load. That legacy table has been dropped from
    //    ClickHouse, so v2 is the only ground-truth source.
    const metricList = REACTION_METRICS.map((m) => `'${m}'`).join(',')
    const truthSubquery = `SELECT entityId, metricType, day, total
         FROM entityMetricDailyAgg_v2
         WHERE entityType = '${ENTITY_TYPE}'
           AND entityId IN (${ids.join(',')})
           AND metricType IN (${metricList})`
    const truthRows = await this.ch.query<{ id: number; total: number }>(`
      SELECT entityId AS id, sum(total) AS total
      FROM (
        ${truthSubquery}
      )
      GROUP BY id
    `)
    const truth = new Map(truthRows.map((r) => [Number(r.id), Number(r.total)]))

    // 3. Compare against Redis.
    const ratios: number[] = []
    let drifted = 0
    for (const id of ids) {
      const chTotal = truth.get(id) ?? 0
      if (chTotal <= 0) continue // undefined ratio / cold entity — skip

      const hash = await this.redis.hGetAll(cacheKeys.metric(ENTITY_TYPE, id))
      // Sum the canonical (watcher-written) reaction fields. Some legacy keys
      // instead carry `Reaction*`-prefixed fields from the old populate path;
      // those aren't what this monitor tracks, so if a hash holds NONE of the
      // canonical fields we skip it rather than report a false 0 ratio. (Hot
      // sampled entities are watcher-incremented and carry the canonical names.)
      let redisTotal = 0
      let hasCanonical = false
      for (const m of REACTION_METRICS) {
        const raw = hash[m]
        if (raw !== undefined) {
          redisTotal += parseInt(raw, 10) || 0
          hasCanonical = true
        }
      }
      if (!hasCanonical) continue

      const ratio = redisTotal / chTotal
      ratios.push(ratio)
      if (ratio > DRIFT_THRESHOLD || ratio < 1 / DRIFT_THRESHOLD) drifted++
    }

    if (ratios.length === 0) return
    ratios.sort((a, b) => a - b)
    const max = ratios[ratios.length - 1]
    const p95 = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))]
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length

    cacheDriftMetrics.ratio.set({ entity_type: ENTITY_TYPE, stat: 'max' }, max)
    cacheDriftMetrics.ratio.set({ entity_type: ENTITY_TYPE, stat: 'p95' }, p95)
    cacheDriftMetrics.ratio.set({ entity_type: ENTITY_TYPE, stat: 'mean' }, mean)
    cacheDriftMetrics.entitiesChecked.set({ entity_type: ENTITY_TYPE }, ratios.length)
    cacheDriftMetrics.entitiesDrifted.set({ entity_type: ENTITY_TYPE }, drifted)

    if (drifted > 0) {
      logger.warn(
        { entity_type: ENTITY_TYPE, checked: ratios.length, drifted, p95, max },
        'cache drift detected: Redis metric cache diverging from ClickHouse truth',
      )
    } else {
      logger.debug({ entity_type: ENTITY_TYPE, checked: ratios.length, p95, max }, 'cache drift check ok')
    }
  }
}
