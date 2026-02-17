# Performance Review: Meilisearch to OpenSearch Migration

## Executive Summary

The OpenSearch migration is functionally sound but has several performance issues that need attention before production traffic. The highest-impact findings are:

1. **DB existence check on every query** (High) -- a Postgres `SELECT id WHERE id IN (...)` runs on every image feed request, adding ~10-50ms per query depending on result set size.
2. **Offset-based pagination** (High) -- `from` pagination degrades linearly with depth; at page 100+ with 100 results per page, OpenSearch must evaluate 10,000+ docs.
3. **Client-side post-filtering shrinks result sets** (Medium) -- fetching `limit + 1` then filtering can return far fewer than `limit` results.
4. **Synchronous dual-write** (Medium) -- writing to both Meilisearch and OpenSearch in sequence doubles write latency during the transition period.
5. **Single shard / zero replicas** (Medium) -- fine for dev, not for production at this index size.

**Estimated production readiness**: Needs 3-5 of the items below addressed before it can handle full traffic.

---

## Findings

### 1. DB Existence Check on Every Search Query

**Impact: HIGH**

**Current behavior** (`image.service.ts:3507-3517`):
After every OpenSearch query, the code fetches all returned image IDs from Postgres to verify they still exist:

```ts
const dbIdResp = await dbRead.image.findMany({
  where: { id: { in: filteredHitIds } },
  select: { id: true },
});
const idSet = new Set(dbIdResp.map((r) => r.id));
const filtered = filteredHits.filter((h) => idSet.has(h.id));
```

This adds a DB round-trip to every single search request. For a feed that serves thousands of requests per second, this is a significant overhead.

**Why it exists**: The search index can contain stale documents for images that have been deleted. The Meilisearch version has the same pattern (line 2460-2469), suggesting this is a known data consistency issue.

**Recommended improvements**:
- **Short term**: Add a Redis-based existence cache (bloom filter or LRU set) populated by a background job. The Meilisearch code already has a feature flag `FEED_IMAGE_EXISTENCE` for a cache-based approach -- reuse it.
- **Medium term**: Ensure deletions are propagated to OpenSearch in near-real-time (they already go through `deleteDocsById`). If deletion propagation is reliable, the DB check becomes unnecessary.
- **Long term**: Use OpenSearch's `_delete_by_query` as part of the image deletion pipeline and trust the index is authoritative.

---

### 2. Offset-Based Pagination (`from`) Degrades at Depth

**Impact: HIGH**

**Current behavior** (`query-builder.ts:40-65`, `image.service.ts:3470-3476`):
The `buildSearchBody` function uses `from` (offset) for pagination:

```ts
const body = buildSearchBody({
  filters,
  mustNot,
  sort: osSort,
  size: limit + 1,
  from: offset,
});
```

OpenSearch (like Elasticsearch) has a hard limit of `index.max_result_window` (default 10,000) for `from + size`. Beyond that, queries fail. Even before that limit, performance degrades because OpenSearch must evaluate `from + size` documents on each shard before discarding the first `from`.

**Note**: The Meilisearch version has the same `offset` pattern, so this is an inherited issue. However, OpenSearch's `search_after` API is purpose-built for this.

**Recommended improvements**:
- **Use `search_after` cursor-based pagination** instead of `from`. The sort fields (`sortAt`, `id`) are already unique enough to serve as cursor values. The function already computes `nextCursor` from `sortAtUnix` -- extend this to pass `search_after: [sortAtUnix, id]` on subsequent pages.
- **If `from` must be kept for backward compat**, set `index.max_result_window` explicitly and document the limit. The current default (10,000) may be hit on popular feeds.

---

### 3. Client-Side Post-Filtering Reduces Result Set Below `limit`

**Impact: MEDIUM**

**Current behavior** (`image.service.ts:3500-3517`):
The code fetches `limit + 1` results, then applies two rounds of client-side filtering:

1. **Post-filter** (lines 3500-3505): Removes results based on `acceptableMinor`, `nsfwLevel`, `needsReview`, and `url` presence.
2. **DB existence check** (lines 3507-3517): Removes results for images that no longer exist in Postgres.

If 30% of results are filtered out, a request for 100 images returns ~70. The UI receives fewer items than expected, causing a poor user experience (short pages, extra fetches).

**Why it's not in the search filter**: Some of these checks depend on per-request context (`currentUserId`, `isModerator`) combined with document fields in ways that are hard to express as pure index filters. The `url` null check and `acceptableMinor` logic could potentially be moved into the OpenSearch query.

**Recommended improvements**:
- **Move filterable checks into the OpenSearch query** where possible:
  - `url` existence: Add `existsFilter('url')` to the filter list
  - `acceptableMinor` for non-moderators: Add `must_not: termFilter('acceptableMinor', true)` when `!isModerator && currentUserId !== userId`
- **Over-fetch with a multiplier**: Instead of `limit + 1`, fetch `limit * 1.3` (or a configurable multiplier), then trim to `limit`. This compensates for post-filtering without requiring a second query.
- **Track filter-out rate** in metrics to tune the multiplier.

---

### 4. Synchronous Dual-Write Doubles Write Latency

**Impact: MEDIUM**

**Current behavior** (`metrics-images.search-index.ts:499-517`):
The `pushData` function writes to Meilisearch first, then to OpenSearch, both synchronously:

```ts
await updateDocs({ indexName, documents: data, batchSize, client });

if (openSearchClient && (await isFlipt('feed-opensearch'))) {
  await bulkIndexDocs({ indexName: OPENSEARCH_METRICS_IMAGES_INDEX, documents: data, batchSize, jobContext });
}
```

During the migration period, every indexing job takes roughly 2x as long (Meili write + OS write).

**Recommended improvements**:
- **Run writes in parallel** using `Promise.all` since the two writes are independent:
  ```ts
  await Promise.all([
    updateDocs({ indexName, documents: data, batchSize, client }),
    openSearchClient && (await isFlipt('feed-opensearch'))
      ? bulkIndexDocs({ indexName: OPENSEARCH_METRICS_IMAGES_INDEX, documents: data, batchSize, jobContext })
      : Promise.resolve(),
  ]);
  ```
  Note: The `isFlipt` call makes this slightly awkward with `Promise.all` since it's async. Evaluate the flag once before the write block.
- **After migration completes**, remove the Meilisearch write entirely to eliminate this overhead.

The same pattern applies to `metrics-images--update-metrics.search-index.ts:88-106`.

---

### 5. Index Settings: Single Shard, Zero Replicas

**Impact: MEDIUM**

**Current behavior** (`metrics-images.mappings.ts:3-6`):

```ts
export const metricsImagesSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
};
```

**Issues**:
- **`number_of_replicas: 0`**: No fault tolerance. If the single node fails, data is lost until re-indexed. For a high-traffic feed, this means downtime.
- **`number_of_shards: 1`**: Limits query parallelism to one shard. For a small dataset this is fine, but the metrics-images index will likely grow to millions of documents. A single shard over ~30-50GB hits diminishing returns.

**Recommended improvements**:
- **Production**: Set `number_of_replicas: 1` minimum for HA. With a multi-node cluster, this is standard.
- **Sharding**: Estimate final index size. If >20M docs or >10GB, consider 2-3 primary shards. If <5M docs, single shard is fine.
- **Use environment-aware settings**: Keep `0 replicas, 1 shard` for dev/docker but override for production via config or index templates.

---

### 6. Bulk Indexing Retry Logic Restarts Entire Batch

**Impact: MEDIUM**

**Current behavior** (`client.ts:39-78`):
The retry loop wraps the entire batch iteration. If the 999th batch of 1000 fails with a network error, the retry starts from batch 0 again:

```ts
while (true) {
  try {
    for (let i = 0; i < documents.length; i += batchSize) {
      // ... process batch
    }
    return;
  } catch (err) {
    retryCount++;
    // ... retry from the beginning
  }
}
```

For large indexing jobs (100k+ documents), this means potentially re-indexing documents that were already successfully indexed.

**Recommended improvement**:
Move the retry logic inside the batch loop so only the failing batch is retried:

```ts
for (let i = 0; i < documents.length; i += batchSize) {
  let retryCount = 0;
  while (true) {
    try {
      // ... process single batch
      break;
    } catch (err) {
      retryCount++;
      if (retryCount >= RETRY_LIMIT) throw err;
      await sleep(5000 * (1 + retryCount));
    }
  }
}
```

---

### 7. Migration Script Concurrency Model Has Race Condition

**Impact: MEDIUM**

**Current behavior** (`migrate-meili-to-opensearch.mjs:377-440`):
The script uses a shared `pushBuffer` array across concurrent sub-range processors. Multiple `processSubRange` coroutines push to and flush from the same buffer without synchronization:

```js
// Multiple concurrent coroutines do this:
pushBuffer.push(...docs);
if (pushBuffer.length >= opts.pushBatch) {
  await flushBuffer();
}
```

Since JavaScript is single-threaded and these are async coroutines (not threads), this is *mostly* safe, but `flushBuffer` uses `splice(0, pushBatch)` which modifies the array while another coroutine might be checking `.length`. This can lead to lost documents or duplicate pushes if the scheduler interleaves at the wrong point.

**Recommended improvement**:
- Give each sub-range its own buffer, or use a proper async queue (e.g., a producer-consumer channel).
- Alternatively, flush only after all sub-ranges complete (simpler, slightly higher memory).

---

### 8. `ssl: { rejectUnauthorized: false }` in Production Client

**Impact: LOW** (performance) / **HIGH** (security)

**Current behavior** (`client.ts:20`):

```ts
ssl: { rejectUnauthorized: false },
```

This disables TLS certificate verification. While this doesn't directly impact performance, it:
- Allows MITM attacks in production
- May indicate the cluster uses self-signed certs, which is fine for dev but not production

**Recommended improvement**:
- For production, either use properly signed certificates or provide the CA cert via `ssl.ca`.
- Make this configurable via an environment variable (`OPENSEARCH_SSL_REJECT_UNAUTHORIZED`).

---

### 9. No Connection Pooling Configuration

**Impact: LOW**

**Current behavior** (`client.ts:10-22`):
The OpenSearch client is created with default connection pool settings:

```ts
export const openSearchClient = shouldConnect
  ? new Client({
      node: env.OPENSEARCH_HOST as string,
      // ...
    })
  : null;
```

The `@opensearch-project/opensearch` client uses a connection pool internally, but the defaults may not be optimal for high-throughput workloads.

**Recommended improvements**:
- Consider configuring `maxRetries`, `requestTimeout`, and `sniffOnStart` (for multi-node clusters).
- If using multiple nodes, pass them as an array to `nodes` for automatic load balancing.
- Set `requestTimeout` to a reasonable value (e.g., 10-30 seconds) to avoid hanging requests.

---

### 10. `getImageMetricsObject` Double-Fetches Metrics Already in the Index

**Impact: LOW**

**Current behavior** (`image.service.ts:3519-3536`):
After querying OpenSearch (which already has `reactionCount`, `commentCount`, `collectedCount`), the code fetches metrics *again* from a Redis/ClickHouse cache:

```ts
const imageMetrics = await getImageMetricsObject(filtered);
const fullData = filtered.map((h) => {
  const match = imageMetrics[h.id];
  return {
    ...h,
    stats: {
      likeCountAllTime: match?.reactionLike ?? 0,
      // ...
    },
  };
});
```

The cache provides more granular breakdowns (like vs heart vs laugh vs cry) that the index doesn't store. If these breakdowns are needed, this extra fetch is necessary. But if the aggregate counts from the index would suffice, this is a redundant call.

**Recommended improvement**:
- If the detailed breakdown is needed, keep the cache fetch but consider denormalizing the individual reaction types into the OpenSearch index too.
- If only aggregates are needed, use the counts already in the OpenSearch document.

---

## Quick Wins vs Longer-Term Optimizations

### Quick Wins (can ship this sprint)
1. **Move `url` existence and `acceptableMinor` checks into OpenSearch filters** -- eliminates most post-filtering
2. **Parallelize dual-writes** with `Promise.all` -- halves write latency during transition
3. **Move retry logic inside the batch loop** in `bulkIndexDocs`/`bulkUpdateDocs` -- prevents re-indexing on late failures
4. **Set `number_of_replicas: 1`** for production index settings

### Longer-Term Optimizations
1. **Replace `from` with `search_after`** -- requires API changes to pass cursor state, but eliminates deep pagination degradation
2. **Eliminate DB existence check** -- requires confidence in deletion propagation or a Redis bloom filter cache
3. **Production shard planning** -- needs index size data to determine optimal shard count
4. **Add individual reaction types to the index** -- eliminates the `getImageMetricsObject` double-fetch

---

## Production Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| Index replicas configured | Not ready | `number_of_replicas: 0` |
| TLS cert verification | Not ready | `rejectUnauthorized: false` |
| Connection timeout configured | Not ready | Using defaults |
| Deep pagination strategy | Not ready | `from`-based, will hit 10k limit |
| Post-filter rate tracked | Not ready | No metrics on how many results are filtered out |
| Deletion propagation verified | Unknown | Need to confirm deletes reach OpenSearch reliably |
| Write latency during dual-write | Acceptable | Can be improved with `Promise.all` |
| Retry logic granularity | Needs fix | Retries restart entire batch |
| Bulk batch size tuned | OK | 1000 is a reasonable default |
| Index refresh strategy | OK | `refresh: false` is correct for bulk writes |
| Monitoring/alerting | Partial | Has Prometheus metrics (`requestDurationSeconds`, `requestTotal`) |
| Error logging | OK | Logs to Axiom on failure |
| Feature flag gating | OK | Flipt `feed-opensearch` flag controls rollout |
