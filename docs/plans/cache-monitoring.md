# Cache Hit Rate Monitoring with Prometheus

## Executive Summary

Implement comprehensive cache monitoring across all Redis cache systems to track hit rates, performance, and identify optimization opportunities.

## Current State

- Multiple cache systems in use (entity metrics, user sessions, etc.)
- No centralized monitoring of cache performance
- Unable to identify cache optimization opportunities
- No alerting for cache degradation

## Proposed Solution

### Prometheus Metrics Integration

**Metric Types to Track:**
- `cache_hits_total`: Counter of successful cache hits
- `cache_misses_total`: Counter of cache misses
- `cache_hit_rate`: Gauge showing current hit rate percentage
- `cache_operation_duration_seconds`: Histogram of cache operation latency
- `cache_evictions_total`: Counter of cache evictions
- `cache_memory_bytes`: Gauge of memory usage per cache

### Implementation

**File: `src/server/utils/cache-metrics.ts`** (NEW)
```typescript
class CacheMetrics {
  // Increment hit counter
  recordHit(cacheName: string, key: string): void

  // Increment miss counter
  recordMiss(cacheName: string, key: string): void

  // Record operation duration
  recordDuration(cacheName: string, operation: string, duration: number): void

  // Calculate and update hit rate gauge
  updateHitRate(cacheName: string): void
}
```

**File: `src/server/utils/cache-wrapper.ts`** (NEW)
- Wrapper around Redis operations to automatically track metrics
- Transparent to existing code
- Minimal performance overhead

### Integration Points

**Update these existing cache implementations:**

1. **Entity Metrics Cache** (`entity-metric.redis.ts`)
   - Track hits/misses on metric lookups
   - Monitor bulk operation performance

2. **User Session Cache**
   - Track session lookup performance
   - Monitor session expiration rates

3. **Feed Caches**
   - Track feed query cache performance
   - Monitor invalidation frequency

4. **Image Metadata Cache**
   - Track image data lookups
   - Monitor cache warming effectiveness

## Monitoring Dashboard

### Grafana Dashboard Panels

1. **Overall Cache Performance**
   - Combined hit rate across all caches
   - Total operations per second
   - Average latency

2. **Per-Cache Metrics**
   - Individual hit rates
   - Memory usage
   - Top missed keys

3. **Alerts Configuration**
   - Hit rate < 80%: Warning
   - Hit rate < 60%: Critical
   - Latency > 100ms: Warning
   - Memory > 80% limit: Warning

### Key Metrics Queries

```promql
# Overall hit rate
sum(rate(cache_hits_total[5m])) /
(sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m]))) * 100

# Per-cache hit rate
rate(cache_hits_total{cache="entity_metrics"}[5m]) /
(rate(cache_hits_total{cache="entity_metrics"}[5m]) +
 rate(cache_misses_total{cache="entity_metrics"}[5m])) * 100

# Cache operation latency (p99)
histogram_quantile(0.99,
  rate(cache_operation_duration_seconds_bucket[5m]))

# Memory usage trend
cache_memory_bytes{cache="entity_metrics"}
```

## Implementation Steps

### Phase 1: Metrics Library (Day 1)
- [ ] Create cache-metrics.ts with Prometheus client
- [ ] Create cache-wrapper.ts for automatic tracking
- [ ] Add environment configuration for metrics endpoint

### Phase 2: Integration (Day 2)
- [ ] Update entity-metric.redis.ts to use wrapper
- [ ] Update other cache implementations
- [ ] Test metrics collection locally

### Phase 3: Dashboard Setup (Day 3)
- [ ] Create Grafana dashboard JSON
- [ ] Configure alerts in AlertManager
- [ ] Document dashboard usage

### Phase 4: Optimization (Ongoing)
- [ ] Identify low hit-rate caches
- [ ] Analyze miss patterns
- [ ] Implement cache warming where beneficial

## Configuration

**Environment Variables:**
```env
METRICS_ENABLED=true
METRICS_PORT=9090
METRICS_PATH=/metrics
CACHE_METRICS_DETAILED=false  # Enable per-key tracking (high overhead)
```

## Performance Considerations

- Metric collection adds ~1-2μs per operation
- Use sampling for high-volume caches if needed
- Aggregate metrics before sending to Prometheus
- Keep cardinality low (don't track individual keys by default)

## Success Criteria

1. All major caches instrumented
2. Dashboard showing real-time metrics
3. Alerts configured and tested
4. < 1% performance overhead from monitoring
5. Identified at least 3 cache optimization opportunities

## Future Enhancements

1. **Cache Key Analysis**
   - Track most frequently missed keys
   - Identify patterns in cache misses
   - Auto-tune TTLs based on access patterns

2. **Predictive Warming**
   - Use ML to predict cache needs
   - Pre-warm caches during low traffic
   - Optimize memory allocation

3. **Multi-Region Monitoring**
   - Track cache performance per region
   - Identify geographic patterns
   - Optimize cache distribution

@dev: This monitoring will give us visibility into all cache systems and help identify optimization opportunities. The Prometheus integration is lightweight and won't impact performance.