# OpenSearch Migration: Implementation Plan

Synthesized from four independent code reviews:
- **DRY** = `review-dry.md` (code quality & duplication)
- **ARCH** = `review-architecture.md` (architecture & design)
- **PERF** = `review-performance.md` (performance)
- **PARITY** = `review-parity.md` (Meilisearch feature parity)

---

## Critical (must fix before production)

### C1. Missing OpenSearch deletion in `onSearchIndexDocumentsCleanup`
**Source:** PARITY #1 (Critical Gap)

The queue-based document cleanup path deletes from Meilisearch but never touches OpenSearch. Over time, deleted images will appear in OpenSearch results after Meili is removed.

**Files:**
- `src/server/meilisearch/util.ts:96-148` (add OS delete call)
- `src/server/search-index/base.search-index.ts:328, 431, 528` (callers)

**Tasks:**
1. In `onSearchIndexDocumentsCleanup`, when the index is `METRICS_IMAGES_SEARCH_INDEX` and the `feed-opensearch` flag is on, call `deleteDocsById` with the same ID list.

**Complexity:** S | **Dependencies:** Benefits from C3 (centralized flag helper)

---

### C2. Port smart cache existence check to OpenSearch read path
**Source:** PARITY #2 (Critical Gap), PERF #1

The OpenSearch function does a raw Postgres `SELECT id WHERE id IN (...)` on every query. The Meilisearch functions have a Flipt-gated Redis-based smart cache (`FEED_IMAGE_EXISTENCE`) that avoids this DB hit. Without porting it, full OpenSearch rollout will significantly increase DB load.

**Files:**
- `src/server/services/image.service.ts:3507-3517` (OpenSearch -- add smart cache)
- `src/server/services/image.service.ts:2447-2576` (PreFilter -- reference implementation)

**Tasks:**
1. Copy the Flipt-gated smart cache logic from PreFilter into `getImagesFromOpenSearch`.
2. Add the corresponding Prometheus metrics (`ffRequestsTotal`, `cacheHitRequestsTotal`, `droppedIdsTotal`) that are currently missing from the OpenSearch path (PARITY #5).

**Complexity:** M | **Dependencies:** None

---

### C3. Centralize the Flipt flag-gate pattern
**Source:** DRY #1 (High), ARCH #2 (High), DRY #7 (Low)

The pattern `if (openSearchClient && (await isFlipt('feed-opensearch')))` is copy-pasted across 6+ locations in 5 files. Each site independently checks the client and flag. This is an O(n) maintenance burden for the flag-removal phase and makes it easy to miss a site.

**Files (all call sites):**
- `src/server/search-index/metrics-images.search-index.ts:509`
- `src/server/search-index/metrics-images--update-metrics.search-index.ts:100`
- `src/pages/api/mod/mark-poi-images-search.ts:106`
- `src/pages/api/mod/search/image-metrics-update.ts:101, 172, 206`
- `src/server/jobs/full-image-existence.ts:58`
- `src/server/meilisearch/util.ts:258`

**Tasks:**
1. Create `syncToOpenSearch({ operation: 'index' | 'update' | 'delete', indexName, documents, batchSize?, jobContext? })` in a new file `src/server/opensearch/sync.ts` (or extend `util.ts`).
2. This function owns the null-client check, the Flipt flag evaluation, and delegates to the appropriate bulk function.
3. Replace all 6+ call sites with a single `syncToOpenSearch(...)` call.

**Complexity:** M | **Dependencies:** None (but simplifies C1 and many Important items)

---

### C4. SSL `rejectUnauthorized: false` must be configurable
**Source:** ARCH #10 (Medium), PERF #8 (Low perf / High security)

The OpenSearch client disables TLS certificate verification unconditionally. This is acceptable for dev but not for production on untrusted networks.

**Files:**
- `src/server/opensearch/client.ts:20`
- `src/env/server-schema.ts` (add env var)

**Tasks:**
1. Add `OPENSEARCH_SSL_VERIFY` env var (default `true`).
2. Set `ssl: { rejectUnauthorized: env.OPENSEARCH_SSL_VERIFY !== 'false' }`.

**Complexity:** S | **Dependencies:** None

---

### C5. Production index settings (shards & replicas)
**Source:** PERF #5 (Medium)

Current settings: `number_of_shards: 1, number_of_replicas: 0`. Zero replicas means no fault tolerance. Single shard limits query parallelism for large indexes.

**Files:**
- `src/server/opensearch/metrics-images.mappings.ts:3-6`

**Tasks:**
1. Make shard/replica counts configurable via environment variables or use environment-aware defaults (0 replicas for dev, 1+ for production).
2. Determine production shard count based on expected index size.

**Complexity:** S | **Decision for Justin:** What is the expected production index size? How many nodes in the production cluster? This determines optimal shard count.

---

## Important (should fix soon after launch)

### I1. Unify `getImagesFromSearchPreFilter` and `getImagesFromOpenSearch`
**Source:** DRY #5 (High)

The OpenSearch read function is a ~320-line near-copy of the ~385-line Meilisearch PreFilter function. Both apply the same business logic filters, just in different DSLs.

**Files:**
- `src/server/services/image.service.ts:2073-2457` (Meilisearch PreFilter)
- `src/server/services/image.service.ts:3234-3554` (OpenSearch)

**Tasks:**
1. Extract shared business logic into a backend-agnostic function that builds a "filter intent" (e.g., `{ field, op, value }` tuples).
2. Create `MeiliFilterBuilder` and `OpenSearchFilterBuilder` that translate intents to the appropriate DSL.
3. Both `getImagesFromSearchPreFilter` and `getImagesFromOpenSearch` call the shared function with their respective builder.

**Complexity:** L | **Dependencies:** Should be done after C2 (smart cache port) and C3 (flag centralization) since those touch overlapping code. | **Parallelizable:** No (conflicts with C2)

---

### I2. Merge `bulkIndexDocs` and `bulkUpdateDocs` into a single parameterized function
**Source:** DRY #4 (Medium)

The two functions share ~90% of their code. Only the action line format and error field differ.

**Files:**
- `src/server/opensearch/client.ts:26-79` (`bulkIndexDocs`)
- `src/server/opensearch/client.ts:81-134` (`bulkUpdateDocs`)

**Tasks:**
1. Create `bulkOperation({ mode: 'index' | 'update', indexName, documents, batchSize?, jobContext? })`.
2. Parameterize the action line builder and error field check.
3. Update all callers (the `syncToOpenSearch` helper from C3 will be the main caller).

**Complexity:** S | **Dependencies:** Best done after or with C3

---

### I3. Remove duplicate `deleteDocuments` from `util.ts`
**Source:** DRY #3 (Medium), ARCH #1 (Medium)

Two functions delete documents by ID using the same bulk API pattern: `deleteDocsById` in `client.ts:136-150` and `deleteDocuments` in `util.ts:77-92`. The `util.ts` version appears to be dead code.

**Files:**
- `src/server/opensearch/util.ts:77-92` (remove)
- `src/server/opensearch/client.ts:136-150` (keep)

**Tasks:**
1. Confirm `deleteDocuments` from `util.ts` has no callers.
2. Remove it.

**Complexity:** S (trivial) | **Dependencies:** None | **Parallelizable:** Yes (independent)

---

### I4. Move retry logic inside the batch loop
**Source:** PERF #6 (Medium)

The retry loop wraps the entire batch iteration in `bulkIndexDocs`/`bulkUpdateDocs`. If the 999th batch fails, all previous successful batches are re-sent.

**Files:**
- `src/server/opensearch/client.ts:39-78` (will become the unified `bulkOperation` from I2)

**Tasks:**
1. Move retry inside the per-batch loop so only the failing batch retries.

**Complexity:** S | **Dependencies:** Do alongside I2 (they touch the same function)

---

### I5. Parallelize dual-writes with `Promise.all`
**Source:** PERF #4 (Medium)

Meilisearch and OpenSearch writes run sequentially, doubling write latency during the transition.

**Files:**
- `src/server/search-index/metrics-images.search-index.ts:499-517`
- `src/server/search-index/metrics-images--update-metrics.search-index.ts:88-107`

**Tasks:**
1. Evaluate the Flipt flag once before the write block.
2. Run both writes in `Promise.all`.
3. If using the `syncToOpenSearch` helper from C3, this can be built into the helper itself.

**Complexity:** S | **Dependencies:** Best done after C3

---

### I6. Replace offset-based pagination with `search_after`
**Source:** PERF #2 (High), ARCH #7

`from`-based pagination degrades linearly with depth and has a hard 10,000 limit. The function already computes `nextCursor` from `sortAtUnix` -- extending to `search_after` is natural.

**Files:**
- `src/server/opensearch/query-builder.ts:40-65` (add `search_after` support)
- `src/server/services/image.service.ts:3470-3476` (pass `search_after` instead of `from`)

**Tasks:**
1. Add `searchAfter` parameter to `buildSearchBody`.
2. When a cursor is present, use `search_after: [sortAtUnix, id]` instead of `from`.
3. Keep `from` as a fallback for explicit offset-based requests.

**Complexity:** M | **Dependencies:** None | **Parallelizable:** Yes (independent of other tasks)

---

### I7. Move post-filter checks into OpenSearch query
**Source:** PERF #3 (Medium)

Fetching `limit + 1` then filtering client-side for `url` existence and `acceptableMinor` can return fewer results than requested.

**Files:**
- `src/server/services/image.service.ts:3500-3505` (post-filter block)
- `src/server/services/image.service.ts:~3400-3470` (filter construction)

**Tasks:**
1. Add `existsFilter('url')` to the filter list.
2. Add `mustNot: termFilter('acceptableMinor', true)` for non-moderator, non-owner requests.
3. Remove the corresponding client-side checks.

**Complexity:** S | **Dependencies:** None | **Parallelizable:** Yes

---

### I8. Improve health check to distinguish "not configured" from "failed to connect"
**Source:** ARCH #8

When `openSearchClient` is null but `OPENSEARCH_HOST` is set, the health check returns `true`, masking a connection failure.

**Files:**
- `src/pages/api/health.ts:104-114`
- `src/env/server-schema.ts` (reference for env var)

**Tasks:**
1. If `OPENSEARCH_HOST` is set but client is null, return `false`.
2. If `OPENSEARCH_HOST` is not set, return `true` (skip check).

**Complexity:** S | **Dependencies:** None | **Parallelizable:** Yes

---

### I9. Add missing Axiom logging
**Source:** PARITY #3 (Minor Gap)

The OpenSearch read function is missing Axiom logs for username fallback and unsupported field usage (`reviewId`, `modelId`, `prioritizedUserIds`).

**Files:**
- `src/server/services/image.service.ts:3351-3354` (username lookup)
- `src/server/services/image.service.ts:~3440+` (unsupported fields)

**Tasks:**
1. Add `logToAxiom({ type: 'info', message: 'Using username...' })` for username fallback.
2. Add `logToAxiom({ type: 'info', input: missingKeys })` for unsupported fields.

**Complexity:** S (trivial) | **Dependencies:** None | **Parallelizable:** Yes

---

## Nice-to-have (can defer)

### N1. Share mappings between migration script and TypeScript source
**Source:** DRY #2 (High), DRY #6 (Low), ARCH #5 (Medium), DRY #8 (Low)

The migration script duplicates `metricsImagesMappings`, `metricsImagesSettings`, the index name constant, and `ensureIndex` logic. Four separate duplications from a single `.mjs` vs `.ts` gap.

**Files:**
- `scripts/migrate-meili-to-opensearch.mjs:161-212, 271-286, 92`
- `src/server/opensearch/metrics-images.mappings.ts` (canonical source)
- `src/server/opensearch/util.ts:6-33` (`ensureIndex`)

**Tasks:**
1. Convert the migration script to `.mts` and run with `tsx`, OR extract mappings/settings to a shared `.json` file.
2. Import `ensureIndex` and `OPENSEARCH_METRICS_IMAGES_INDEX` from the canonical source.

**Complexity:** S-M | **Dependencies:** None | **Note:** The migration script is a one-shot tool. If it won't be rerun, adding comments linking to the canonical source is sufficient.

---

### N2. Add barrel export for `src/server/opensearch/`
**Source:** DRY #9 (Low)

OpenSearch imports are scattered and inconsistent. A barrel export would clean up imports, especially after C3 centralizes the sync helper.

**Files:**
- `src/server/opensearch/index.ts` (new)

**Tasks:**
1. Create `index.ts` re-exporting the public API.
2. Update import paths across consumer files.

**Complexity:** S | **Dependencies:** Do after C3, I2, I3 (the API surface is still changing)

---

### N3. Configure OpenSearch client connection settings
**Source:** PERF #9 (Low)

The client uses default pool settings. For high-throughput, `maxRetries`, `requestTimeout`, and multi-node support should be configured.

**Files:**
- `src/server/opensearch/client.ts:10-22`

**Tasks:**
1. Add `requestTimeout` (e.g., 30s).
2. Add `maxRetries` config.
3. If multi-node, pass `nodes` array and consider `sniffOnStart`.

**Complexity:** S | **Dependencies:** Depends on production cluster topology (single node vs multi-node)

---

### N4. Fix migration script race condition in shared buffer
**Source:** PERF #7 (Medium)

Concurrent sub-range processors share a `pushBuffer` array. While JS is single-threaded, `splice` during async interleaving can cause lost/duplicate docs.

**Files:**
- `scripts/migrate-meili-to-opensearch.mjs:377-440`

**Tasks:**
1. Give each sub-range its own buffer, or flush only after all sub-ranges complete.

**Complexity:** S | **Dependencies:** None | **Note:** One-shot script; only fix if re-running the migration.

---

### N5. Document PostFilter behavior differences
**Source:** PARITY #4 (Minor Gap)

OpenSearch matches PreFilter semantics. Users previously on PostFilter (via `FEED_POST_FILTER` flag) will see behavior changes in `disablePoi` owner bypass, NSFW unscanned handling, and published-date logic.

**Tasks:**
1. Document that OpenSearch follows PreFilter semantics.
2. Confirm with Justin that this is intentional.

**Complexity:** S (documentation only) | **Decision for Justin:** Is PreFilter the desired target behavior, or should some PostFilter semantics be preserved?

---

### N6. Add dual-write consistency monitoring
**Source:** ARCH #4 (Low)

No mechanism to detect if OpenSearch and Meilisearch diverge during the dual-write period.

**Tasks:**
1. Add a periodic job or health check endpoint that compares document counts between Meilisearch and OpenSearch.
2. Add a metric counter for failed OpenSearch writes.

**Complexity:** M | **Dependencies:** None

---

### N7. Reduce double-fetch of metrics data
**Source:** PERF #10 (Low)

After querying OpenSearch (which has `reactionCount`, `commentCount`, `collectedCount`), the code re-fetches metrics from Redis/ClickHouse for per-reaction-type breakdowns.

**Tasks:**
1. If per-reaction breakdowns are needed, denormalize them into the OpenSearch index.
2. If only aggregates are needed, use the counts from the OpenSearch document directly.

**Complexity:** M | **Dependencies:** Requires schema change and reindex

---

### N8. Docker/production documentation
**Source:** ARCH #9 (Low)

The docker-compose is dev-only with no production tuning notes.

**Tasks:**
1. Add comments noting dev-only status.
2. Document expected production shard count, replica settings, heap sizing.

**Complexity:** S | **Dependencies:** Depends on C5 decisions

---

## Parallelization Guide

Tasks are grouped into parallel work streams. Within a stream, tasks run sequentially. Across streams, tasks can run simultaneously.

```
Stream A (Flag & Write Path)        Stream B (Read Path)           Stream C (Quick Fixes)
─────────────────────────────       ──────────────────────         ─────────────────────
C3: Centralize flag helper          C2: Port smart cache           C4: SSL config
  |                                   |                           I3: Remove dead delete fn
  v                                   v                           I8: Health check fix
I2+I4: Merge bulk ops + retry       I6: search_after pagination   I9: Add Axiom logging
  |                                   |                           C5: Shard/replica config
  v                                   v
I5: Parallelize dual-writes         I7: Move post-filters to OS
  |                                   |
  v                                   v
C1: Add OS deletion to cleanup      I1: Unify PreFilter/OS fn
  |
  v
N2: Barrel export
```

Stream C tasks are all independent and can each be done in parallel with everything else.

---

## Decisions for Justin

1. **Production shard count (C5):** How large is the `metrics_images` index expected to grow? How many OpenSearch nodes in production? This determines `number_of_shards` and `number_of_replicas`.

2. **PreFilter vs PostFilter semantics (N5):** OpenSearch matches PreFilter behavior. Is this intentional, or should any PostFilter semantics (stricter `disablePoi`, NSFW unscanned handling, published-date logic) be carried over?

3. **Smart cache strategy (C2):** The existing `FEED_IMAGE_EXISTENCE` Flipt-gated Redis cache should be ported. Should it use the same Redis keys and flag, or get a separate flag for OpenSearch?

4. **Migration script reuse (N1, N4):** Will the migration script be run again? If it's truly one-shot, fixing its duplication and race condition is low priority. If it'll be reused for future indexes, it should be cleaned up.

5. **Metrics double-fetch (N7):** Does the UI need per-reaction-type breakdowns (like vs heart vs laugh)? If only aggregates are needed, the extra cache fetch can be removed.

---

## Summary

| Severity | Count | Estimated Effort |
|----------|-------|-----------------|
| Critical | 5     | ~2 S + 2 M + 1 decision |
| Important | 9   | ~5 S + 3 M + 1 L |
| Nice-to-have | 8 | ~5 S + 3 M |
