# Architecture & Design Review: Meilisearch to OpenSearch Migration

## Executive Summary

The migration introduces a dual-write strategy gated by a Flipt feature flag (`feed-opensearch`), allowing gradual rollout of OpenSearch as a replacement for the metrics-images Meilisearch index. The OpenSearch layer is structured across four new files (`client.ts`, `util.ts`, `query-builder.ts`, `metrics-images.mappings.ts`), a standalone migration script, and modifications to ~8 existing files for dual-write support.

**Overall assessment**: The architecture is functional and pragmatically structured for an incremental migration. There are several areas where the design can be tightened — particularly around duplicated delete operations between `client.ts` and `util.ts`, scattered feature flag checks, error handling in the read path, and the migration script duplicating mappings. None of these are blockers, but addressing them before the flag goes to 100% will reduce operational risk.

---

## Findings

### 1. Client Layer: Overlapping Responsibilities Between `client.ts` and `util.ts`

**Description**: `client.ts` exports `deleteDocsById()` (line 136) and `util.ts` exports `deleteDocuments()` (line 77). Both do the same thing: bulk delete by ID using `openSearchClient.bulk()`. Similarly, `ensureIndex` in `util.ts` handles index creation/mapping updates, but the migration script reimplements the same logic via raw HTTP (`osEnsureIndex()`).

**Impact**: Medium. Two delete functions with near-identical signatures creates confusion about which to call. Callers currently use `deleteDocsById` from `client.ts` nowhere (it's dead code), while `deleteDocuments` from `util.ts` is also unused by the main app (only the `meilisearch/util.ts` uses `deleteDocsByQuery`). This suggests the surface area was built speculatively.

**Recommendation**: Consolidate to a single module. Keep `client.ts` for the raw client singleton and bulk CRUD operations (`bulkIndexDocs`, `bulkUpdateDocs`, `deleteDocsById`, `deleteDocsByQuery`). Move index management (`ensureIndex`, `swapIndex`) to `util.ts`. Remove `deleteDocuments` from `util.ts` since `deleteDocsById` in `client.ts` does the same thing.

---

### 2. Feature Flag Sprawl: `isFlipt('feed-opensearch')` Scattered Across 7+ Files

**Description**: The dual-write guard `if (openSearchClient && (await isFlipt('feed-opensearch')))` appears in:
- `metrics-images.search-index.ts:509`
- `metrics-images--update-metrics.search-index.ts:100`
- `mark-poi-images-search.ts:106`
- `image-metrics-update.ts:101, 172, 206`
- `full-image-existence.ts:58`
- `meilisearch/util.ts:258`

Each call-site independently fetches the Flipt client and evaluates the flag. This is an `O(n)` maintenance burden — when the migration completes and the flag is removed, every site must be found and updated.

**Impact**: High (maintenance risk, not correctness). The pattern works today but is fragile for the flag-removal phase.

**Recommendation**: Two options, in order of preference:

**Option A — Centralized dual-write helper**: Create a `shouldWriteOpenSearch()` function (or cache the result per-request) that encapsulates both the client-null check and the flag evaluation:

```ts
// src/server/opensearch/util.ts
let _osWriteEnabled: boolean | null = null;
export async function shouldWriteOpenSearch(): Promise<boolean> {
  if (!openSearchClient) return false;
  if (_osWriteEnabled !== null) return _osWriteEnabled;
  _osWriteEnabled = await isFlipt('feed-opensearch');
  return _osWriteEnabled;
}
```

Then call-sites become `if (await shouldWriteOpenSearch()) { ... }`. When migration completes, flip one function.

**Option B — Search adapter pattern**: Abstract `MeiliSearch` and `OpenSearch` behind a common `SearchIndex` interface with `index()`, `update()`, `delete()`, `search()` methods. The adapter checks the flag once and delegates. This is the cleanest long-term solution but adds more upfront work for what may be a temporary dual-write phase.

For a migration that will end with Meilisearch being removed entirely, Option A is pragmatic and sufficient.

---

### 3. Read-Path Error Handling: Silent Fallback to Empty Results

**Description**: `getImagesFromOpenSearch()` (image.service.ts:3540-3553) catches all errors and returns `{ data: [], nextCursor: undefined }`. While it logs to Axiom, the user sees an empty feed with no indication of failure.

**Impact**: Medium. During migration this is defensible — if OpenSearch fails, the user gets no results rather than a 500. But once OpenSearch is the sole backend, returning empty results on transient errors (network blip, cluster restart) will look like data loss to users.

**Recommendation**: Keep the current behavior during dual-write. Before removing Meilisearch, add a fallback mechanism:
1. On OpenSearch failure, attempt Meilisearch as a fallback (circuit-breaker pattern).
2. Or: propagate the error and let the caller decide (e.g., return a 503 with retry-after).

The flag-check in `getImagesFromSearch()` (line 1926-1940) already catches exceptions and falls through to Meilisearch, which is a good pattern. Consider making this explicit: if OpenSearch throws, fall back to Meili rather than returning empty.

---

### 4. Dual-Write Consistency Risks

**Description**: The dual-write pattern writes to Meilisearch first, then conditionally to OpenSearch. If the OpenSearch write fails, only an error is logged (in `bulkIndexDocs`'s retry loop). This creates eventual consistency windows where Meilisearch has data that OpenSearch does not.

**Impact**: Low during migration (Meilisearch is still source of truth). High after cutover if stale data persists.

**Recommendation**:
- The current approach is fine for migration. Meilisearch is the source of truth; OpenSearch is being populated.
- Before cutover, run the migration script to do a full reconciliation pass.
- Consider adding an OpenSearch document count comparison to the health check or a periodic reconciliation job.
- The retry logic in `bulkIndexDocs` (5 retries with linear backoff) is reasonable. Consider adding a metric counter for failed OpenSearch writes so you can alert on divergence.

---

### 5. Migration Script: Duplicated Mappings and Standalone HTTP Client

**Description**: `scripts/migrate-meili-to-opensearch.mjs` duplicates the `metricsImagesMappings` and `metricsImagesSettings` objects (lines 161-212) that are already defined in `metrics-images.mappings.ts`. The script also implements its own HTTP-based OpenSearch client (`osRequest`, `osBulkIndex`, etc.) instead of using the `@opensearch-project/opensearch` SDK.

**Impact**: Medium. If mappings change in the TypeScript source, the migration script's copy will drift. The standalone HTTP client is acceptable for a one-shot script but adds maintenance surface.

**Recommendation**:
- **Mappings duplication**: Since this is a `.mjs` file that can't import `.ts`, the pragmatic fix is to add a comment referencing the source of truth, or generate the mappings as a JSON file that both can import. Alternatively, convert the script to TypeScript and run with `tsx`.
- **HTTP client vs SDK**: The fetch-based client is fine for a one-off migration script. It avoids pulling in the full SDK dependency chain. Document that this script is not intended for ongoing use.

---

### 6. Index Management: `ensureIndex` vs `swapIndex`

**Description**: `util.ts` provides both `ensureIndex` (create-or-update-mappings) and `swapIndex` (atomic alias swap). The `swapIndex` function is well-implemented with atomic alias manipulation. However, `ensureIndex` is the only one actually called (in `onIndexSetup` at metrics-images.search-index.ts:133-139). The `swapIndex` function appears unused.

**Impact**: Low. `swapIndex` is forward-looking infrastructure for zero-downtime reindexing. It's well-written but unused.

**Recommendation**: Keep `swapIndex` — it will be needed for production reindexing. Consider the following workflow:
1. `ensureIndex` for the initial setup and mapping updates.
2. For full reindexes: create a new timestamped index (e.g., `metrics_images_v2`), populate it, then `swapIndex` the alias.

The current hardcoded index name `metrics_images_v1` should eventually be an alias pointing to a versioned index. This is not urgent for initial launch.

---

### 7. Query Builder Completeness

**Description**: `query-builder.ts` provides: `termFilter`, `termsFilter`, `rangeFilter`, `existsFilter`, `notFilter`, `orFilter`, `andFilter`, and `buildSearchBody`. These cover all the filter types used in `getImagesFromOpenSearch()`.

**Impact**: Low. The builder is minimal but complete for current use.

**Recommendation**: The builder is adequate. A few observations:
- `buildSearchBody` hardcodes `_source` to return all fields. For large indexes, consider adding `_source` field filtering to reduce payload size.
- `search_after` is not supported — the current pagination uses `from`/`size` which is fine for moderate depths but degrades past ~10K results. For cursor-based pagination (which `nextCursor` suggests), `search_after` would be more efficient.
- Consider adding a `matchAll` query helper for unfiltered queries.

---

### 8. Health Check Integration

**Description**: The OpenSearch health check (health.ts:104-114) uses `cluster.health()` and accepts both `green` and `yellow` status. If the client is null, it returns `true` (healthy) to avoid blocking deployments that don't use OpenSearch.

**Impact**: Low. The implementation is correct.

**Recommendation**: Good pattern. One improvement: when `openSearchClient` is null but `OPENSEARCH_HOST` is configured (meaning connection failed), returning `true` masks a configuration error. Consider:

```ts
async openSearch(signal: AbortSignal) {
  if (signal.aborted) return false;
  if (!env.OPENSEARCH_HOST) return true; // Not configured, skip
  if (openSearchClient === null) return false; // Configured but failed to connect
  // ... existing check
}
```

---

### 9. Docker Compose Configuration

**Description**: `docker/opensearch/docker-compose.yml` defines a single-node OpenSearch 2.19.1 cluster with security disabled, 512MB heap, and an optional Dashboards container.

**Impact**: Low. This is a dev-only configuration.

**Recommendation**: Adequate for local development. Add a comment noting this is dev-only. For production, document expected shard count, replica settings, and heap sizing. The current mapping uses `number_of_shards: 1, number_of_replicas: 0` which is fine for dev but should be tuned for production data volumes.

---

### 10. SSL Configuration: `rejectUnauthorized: false`

**Description**: The OpenSearch client (client.ts:20) disables TLS certificate verification with `ssl: { rejectUnauthorized: false }`.

**Impact**: Medium (security). This is common for dev/internal clusters but should not be used in production if communicating over untrusted networks.

**Recommendation**: Make this configurable via environment variable:

```ts
ssl: {
  rejectUnauthorized: env.OPENSEARCH_SSL_VERIFY !== 'false',
}
```

Or remove it entirely if the production cluster uses a trusted CA.

---

## Architecture Diagram

```
                                 Flipt Feature Flag
                                   feed-opensearch
                                        |
                                   [enabled?]
                                   /         \
                                  no          yes
                                 /              \
                    +-----------+                +-----------+
                    | Meili     |                | OpenSearch|
                    | Search    |                | Search    |
                    | (read)    |                | (read)    |
                    +-----------+                +-----------+

  Write Path (always dual-write when flag=on):

  +------------------+     +-------------------+     +-------------------+
  | Search Index     | --> | Meilisearch       |     | OpenSearch        |
  | Update Processor |     | (always)          |     | (if flag=on)      |
  +------------------+     +-------------------+     +-------------------+
         |                                                   |
         |    Same data, same batch                          |
         +---------------------------------------------------+

  Data Flow:

  DB/ClickHouse --> pullData --> transformData --> pushData
                                                     |
                                           +---------+---------+
                                           |                   |
                                      updateDocs()       bulkIndexDocs()
                                      (Meilisearch)       (OpenSearch)

  Migration (one-shot):

  +-------------------+     fetch API     +-------------------+
  | Meilisearch       | ================> | OpenSearch        |
  | metrics_images_v1 |    (bulk copy)    | metrics_images_v1 |
  +-------------------+                   +-------------------+
```

---

## Prioritized Recommendations

| # | Priority | Finding | Action |
|---|----------|---------|--------|
| 1 | **High** | Feature flag sprawl (Finding 2) | Create `shouldWriteOpenSearch()` helper; replace 7+ inline checks |
| 2 | **Medium** | Overlapping delete functions (Finding 1) | Consolidate `deleteDocuments` and `deleteDocsById` into one |
| 3 | **Medium** | Read-path silent failure (Finding 3) | Before cutover, add Meilisearch fallback on OpenSearch error |
| 4 | **Medium** | Migration script duplicated mappings (Finding 5) | Add reference comment or convert script to TypeScript |
| 5 | **Medium** | SSL `rejectUnauthorized: false` (Finding 10) | Make configurable via env var |
| 6 | **Low** | Dual-write consistency monitoring (Finding 4) | Add document count comparison metric/job |
| 7 | **Low** | Health check null-client semantics (Finding 8) | Distinguish "not configured" from "failed to connect" |
| 8 | **Low** | Query builder: `search_after` pagination (Finding 7) | Implement before high-traffic launch |
| 9 | **Low** | Unused `swapIndex` (Finding 6) | Keep; will be needed for zero-downtime reindexing |
| 10 | **Low** | Docker config documentation (Finding 9) | Add production tuning notes |
