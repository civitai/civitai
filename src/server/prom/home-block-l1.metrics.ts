// Counters for the home block per-process L1 (`~/server/services/home-block-cache.service`).
// Imported from `@civitai/telemetry/client` directly, like `cluster-cache-guard.metrics.ts`, so the
// cache does not pull `~/server/prom/client`'s pool gauges into every module that reads it. Hits and
// misses go on the shared `cache_hit_total` / `cache_miss_total` series under this cache's name, the
// series every other in-process LRU reports on; evictions have no shared series, so they get one.
import {
  cacheHitCounter,
  cacheMissCounter,
  registerCounterWithLabels,
} from '@civitai/telemetry/client';

export const HOME_BLOCK_L1_CACHE_NAME = 'home-block-l1';
export const HOME_BLOCK_L1_CACHE_TYPE = 'lruCache';

export const homeBlockL1EvictionCounter = registerCounterWithLabels({
  name: 'home_block_l1_evictions_total',
  help: 'Home block L1 entries evicted for room (entry or byte cap) before their TTL ran out',
  labelNames: ['cache_name'] as const,
});

const labels = { cache_name: HOME_BLOCK_L1_CACHE_NAME, cache_type: HOME_BLOCK_L1_CACHE_TYPE };

export function countHomeBlockL1Hit() {
  cacheHitCounter.inc(labels);
}

export function countHomeBlockL1Miss() {
  cacheMissCounter.inc(labels);
}

export function countHomeBlockL1Eviction() {
  homeBlockL1EvictionCounter.inc({ cache_name: HOME_BLOCK_L1_CACHE_NAME });
}

// The per-process copy of the HomeBlock row `getHomeBlockById` reads, on the same shared series.
export const HOME_BLOCK_ROW_CACHE_NAME = 'home-block-row';

const rowLabels = { cache_name: HOME_BLOCK_ROW_CACHE_NAME, cache_type: HOME_BLOCK_L1_CACHE_TYPE };

export function countHomeBlockRowHit() {
  cacheHitCounter.inc(rowLabels);
}

export function countHomeBlockRowMiss() {
  cacheMissCounter.inc(rowLabels);
}
