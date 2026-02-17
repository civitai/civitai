# OpenSearch Migration: Dev Task Breakdown

Parallelized task breakdown derived from `implementation-plan.md` and four code reviews.

---

## Agent Work Streams

### Stream A: Write-Path Infrastructure (sync helper + bulk operations)

Focus: Centralize the Flipt flag-gate pattern, unify bulk operations, fix retry logic, add deletion to cleanup path.

**Files owned:**
- `src/server/opensearch/client.ts` (heavy edits)
- `src/server/opensearch/sync.ts` (new file)
- `src/server/search-index/metrics-images.search-index.ts` (lines ~499-520 only)
- `src/server/search-index/metrics-images--update-metrics.search-index.ts` (lines ~88-107 only)
- `src/pages/api/mod/mark-poi-images-search.ts` (lines ~95-112 only)
- `src/pages/api/mod/search/image-metrics-update.ts` (lines ~95-210 only)
- `src/server/jobs/full-image-existence.ts` (lines ~48-65 only)
- `src/server/meilisearch/util.ts` (lines ~96-148 + ~257-271 only)
- `src/server/opensearch/util.ts` (delete dead code)

**Tasks (sequential):**

#### T1. Merge `bulkIndexDocs` and `bulkUpdateDocs` + fix retry logic [C3 prereq, I2, I4]
**Complexity:** S | **Priority:** Critical (foundation for T2)

Create a single `bulkOperation` function in `client.ts` that replaces both functions:

```ts
export async function bulkOperation({ mode, indexName, documents, batchSize, jobContext }: {
  mode: 'index' | 'update';
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void>
```

Key changes:
1. Parameterize action line builder: `mode === 'index'` uses `{ index: { _index, _id } }` + full doc; `mode === 'update'` uses `{ update: { _index, _id } }` + `{ doc: fields }`
2. Parameterize error field check: `item[mode]?.error`
3. **Move retry inside the per-batch loop** (I4): Each batch retries independently instead of restarting from batch 0
4. Keep `bulkIndexDocs` and `bulkUpdateDocs` as thin wrappers that call `bulkOperation` with the correct mode (to avoid a huge caller diff)
5. Integrate `deleteDocsById` into `bulkOperation` as `mode: 'delete'` or keep it separate (it has no retry/batching, so separate is fine)

**Files:** `src/server/opensearch/client.ts`

---

#### T2. Create `syncToOpenSearch` helper [C3]
**Complexity:** M | **Priority:** Critical

Create `src/server/opensearch/sync.ts` with:

```ts
import { openSearchClient } from './client';
import { bulkOperation } from './client';
import { deleteDocsById, deleteDocsByQuery } from './client';
import { OPENSEARCH_METRICS_IMAGES_INDEX } from './metrics-images.mappings';
import { isFlipt } from '~/server/flipt/featureFlags';

export async function syncToOpenSearch({ operation, indexName, documents, batchSize, jobContext }: {
  operation: 'index' | 'update' | 'delete';
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void> {
  if (!openSearchClient) return;
  if (!(await isFlipt('feed-opensearch'))) return;

  if (operation === 'delete') {
    await deleteDocsById({ indexName, ids: documents.map(d => d.id) });
  } else {
    await bulkOperation({ mode: operation, indexName, documents, batchSize, jobContext });
  }
}
```

Also add `syncDeleteByQuery` for the user content removal case:
```ts
export async function syncDeleteByQuery({ indexName, query }: {
  indexName: string;
  query: Record<string, unknown>;
}): Promise<void> {
  if (!openSearchClient) return;
  if (!(await isFlipt('feed-opensearch'))) return;
  await deleteDocsByQuery({ indexName, query });
}
```

**Files:** `src/server/opensearch/sync.ts` (new)

---

#### T3. Replace all 6+ flag-gate call sites with `syncToOpenSearch` [C3]
**Complexity:** S | **Priority:** Critical

Replace the inline `if (openSearchClient && (await isFlipt('feed-opensearch')))` pattern in all these locations:

1. `src/server/search-index/metrics-images.search-index.ts:509-516` -- `syncToOpenSearch({ operation: 'index', ... })`
2. `src/server/search-index/metrics-images--update-metrics.search-index.ts:100-106` -- `syncToOpenSearch({ operation: 'update', ... })`
3. `src/pages/api/mod/mark-poi-images-search.ts:106-112` -- `syncToOpenSearch({ operation: 'update', ... })`
4. `src/pages/api/mod/search/image-metrics-update.ts:101-103` -- `syncToOpenSearch({ operation: 'index', ... })`
5. `src/pages/api/mod/search/image-metrics-update.ts:172-174` -- `syncToOpenSearch({ operation: 'index', ... })`
6. `src/pages/api/mod/search/image-metrics-update.ts:206-208` -- `syncToOpenSearch({ operation: 'index', ... })`
7. `src/server/jobs/full-image-existence.ts:58-64` -- `syncToOpenSearch({ operation: 'update', ... })`
8. `src/server/meilisearch/util.ts:257-271` -- `syncDeleteByQuery({ ... })`

**Files:** All 6 files listed above (surgical edits -- replace the `if` block with a single function call)

---

#### T4. Parallelize dual-writes with `Promise.all` [I5]
**Complexity:** S | **Priority:** Important

After T3, the two main pushData functions can run Meili + OS writes in parallel. The `syncToOpenSearch` call is now a single awaitable call:

1. `metrics-images.search-index.ts:499-517`: Wrap `updateDocs(...)` and `syncToOpenSearch(...)` in `Promise.all`
2. `metrics-images--update-metrics.search-index.ts:88-107`: Same pattern

**Files:** `src/server/search-index/metrics-images.search-index.ts`, `src/server/search-index/metrics-images--update-metrics.search-index.ts`

---

#### T5. Add OpenSearch deletion to `onSearchIndexDocumentsCleanup` [C1]
**Complexity:** S | **Priority:** Critical

In `src/server/meilisearch/util.ts`, function `onSearchIndexDocumentsCleanup` (lines 96-148):

After the Meilisearch `index.deleteDocuments(ids)` call, add:
```ts
if (indexName === METRICS_IMAGES_SEARCH_INDEX) {
  await syncToOpenSearch({
    operation: 'delete',
    indexName: OPENSEARCH_METRICS_IMAGES_INDEX,
    documents: ids.map(id => ({ id })),
  });
}
```

Do this for both code paths (direct `ids` parameter at line 119 and queued items at line 146).

**Files:** `src/server/meilisearch/util.ts`

---

#### T6. Remove dead `deleteDocuments` from `util.ts` [I3]
**Complexity:** S (trivial) | **Priority:** Important

1. Verify `deleteDocuments` from `src/server/opensearch/util.ts:77-92` has no callers (grep for imports)
2. Delete the function

**Files:** `src/server/opensearch/util.ts`

---

### Stream B: Read-Path Improvements (smart cache, pagination, filters, logging)

Focus: Port the smart cache, add `search_after` pagination, move post-filters into query, add missing logging.

**Files owned:**
- `src/server/services/image.service.ts` (lines 3234-3554: the OpenSearch read function)
- `src/server/opensearch/query-builder.ts`

**Tasks (sequential within stream, but T7 and T8 can run in parallel):**

#### T7. Port smart cache existence check to OpenSearch [C2]
**Complexity:** M | **Priority:** Critical

Copy the Flipt-gated smart cache logic from `getImagesFromSearchPreFilter` (lines 2447-2576) into `getImagesFromOpenSearch` (replacing lines 3507-3517).

Steps:
1. Import `FliptSingleton`, `FLIPT_FEATURE_FLAGS`, `sysRedis`, `REDIS_SYS_KEYS` (same imports as PreFilter)
2. Add the `ffRequestsTotal`, `cacheHitRequestsTotal`, `droppedIdsTotal` Prometheus counters (these already exist as imports in the file for the PreFilter function)
3. Replace the basic DB check block (lines 3507-3517) with the flag-gated smart cache logic:
   - If `FEED_IMAGE_EXISTENCE` flag is off: basic DB check (current behavior) + emit metrics
   - If flag is on: Redis cache check -> DB fallback for misses -> cache update -> filter
4. Update the `filtered` variable to use the result of the existence check

The reference implementation is at `image.service.ts:2447-2576`. Copy the `checkImageExistence` inner function and the flag evaluation preceding it.

**Files:** `src/server/services/image.service.ts` (only the OpenSearch function, lines ~3507-3517)

---

#### T8. Add missing Axiom logging [I9]
**Complexity:** S (trivial) | **Priority:** Important

Two missing log calls in `getImagesFromOpenSearch`:

1. **Username fallback** (~line 3351-3354): After the `dbRead.user.findFirst` lookup, add:
   ```ts
   logToAxiom({
     type: 'info',
     name: 'opensearch-username-fallback',
     message: `Using username "${username}" to find userId`,
   }, 'temp-search').catch();
   ```

2. **Unsupported fields** (~line 3265+): After destructuring, check for `reviewId`, `modelId`, `prioritizedUserIds` and log:
   ```ts
   const unsupportedFields = { reviewId, modelId, prioritizedUserIds };
   const missingKeys = Object.entries(unsupportedFields)
     .filter(([, v]) => v !== undefined)
     .map(([k]) => k);
   if (missingKeys.length > 0) {
     logToAxiom({
       type: 'info',
       name: 'opensearch-unsupported-fields',
       input: missingKeys,
     }, 'temp-search').catch();
   }
   ```

**Files:** `src/server/services/image.service.ts` (only inside `getImagesFromOpenSearch`)

---

#### T9. Move post-filter checks into OpenSearch query [I7]
**Complexity:** S | **Priority:** Important

In `getImagesFromOpenSearch`, move two client-side checks into the query DSL (lines ~3400-3470 filter construction area):

1. Add `existsFilter('url')` to the `filters` array (replaces the `!hit.url` check in the post-filter at line 3501)
2. Add `mustNot: termFilter('acceptableMinor', true)` when `!isModerator && currentUserId !== userId` (replaces the `hit.acceptableMinor` check at line 3502)
3. Remove the corresponding client-side checks from the post-filter block (lines 3500-3505). Keep the `nsfwLevel` / `needsReview` check since it has complex conditional logic that benefits from client-side handling.

**Files:** `src/server/services/image.service.ts` (only inside `getImagesFromOpenSearch`)

---

#### T10. Replace offset pagination with `search_after` [I6]
**Complexity:** M | **Priority:** Important

1. In `query-builder.ts`, add `searchAfter` parameter to `buildSearchBody`:
   ```ts
   export function buildSearchBody(opts: {
     filters: FilterClause[];
     mustNot?: FilterClause[];
     sort: Array<Record<string, { order: 'asc' | 'desc' }>>;
     size: number;
     from?: number;
     searchAfter?: Array<number | string>;
   }): Record<string, any> {
     // ... existing code ...
     if (opts.searchAfter) {
       body.search_after = opts.searchAfter;
     } else if (from !== undefined) {
       body.from = from;
     }
     return body;
   }
   ```

2. In `getImagesFromOpenSearch` (image.service.ts ~line 3470-3476):
   - When `entry` is provided and sort is default (desc), pass `searchAfter: [entry, 0]` instead of relying solely on the range filter
   - Keep `from` as fallback for explicit offset-based requests (when `offset` is provided without `entry`)
   - Add `{ _id: 'desc' }` as a tiebreaker to the sort array for deterministic ordering with `search_after`

**Files:** `src/server/opensearch/query-builder.ts`, `src/server/services/image.service.ts`

---

### Stream C: Config & Infrastructure (independent quick fixes)

Focus: SSL config, health check, shard settings, env vars. All independent, all small.

**Files owned:**
- `src/server/opensearch/client.ts` (line 20 only -- SSL)
- `src/env/server-schema.ts` (add env vars)
- `src/server/opensearch/metrics-images.mappings.ts` (settings)
- `src/pages/api/health.ts` (lines 104-114)

**Tasks (all independent, can be done in any order):**

#### T11. Make SSL `rejectUnauthorized` configurable [C4]
**Complexity:** S | **Priority:** Critical

1. In `src/env/server-schema.ts`, add:
   ```ts
   OPENSEARCH_SSL_VERIFY: z.enum(['true', 'false']).default('true').optional(),
   ```

2. In `src/server/opensearch/client.ts:20`, change:
   ```ts
   ssl: { rejectUnauthorized: env.OPENSEARCH_SSL_VERIFY !== 'false' },
   ```

**Files:** `src/env/server-schema.ts`, `src/server/opensearch/client.ts`

---

#### T12. Make shard/replica counts configurable [C5]
**Complexity:** S | **Priority:** Critical

1. In `src/env/server-schema.ts`, add:
   ```ts
   OPENSEARCH_SHARDS: z.coerce.number().default(1).optional(),
   OPENSEARCH_REPLICAS: z.coerce.number().default(0).optional(),
   ```

2. In `src/server/opensearch/metrics-images.mappings.ts`, change:
   ```ts
   import { env } from '~/env/server';

   export const metricsImagesSettings = {
     number_of_shards: env.OPENSEARCH_SHARDS ?? 1,
     number_of_replicas: env.OPENSEARCH_REPLICAS ?? 0,
   };
   ```

   Note: If this causes import issues at module level (env not ready), use a function instead:
   ```ts
   export function getMetricsImagesSettings() {
     return {
       number_of_shards: env.OPENSEARCH_SHARDS ?? 1,
       number_of_replicas: env.OPENSEARCH_REPLICAS ?? 0,
     };
   }
   ```
   And update the caller in `metrics-images.search-index.ts` `onIndexSetup`.

**Files:** `src/env/server-schema.ts`, `src/server/opensearch/metrics-images.mappings.ts`

---

#### T13. Improve health check [I8]
**Complexity:** S | **Priority:** Important

In `src/pages/api/health.ts:104-114`, change:

```ts
async openSearch(signal: AbortSignal) {
  if (signal.aborted) return false;
  if (!env.OPENSEARCH_HOST) return true;          // Not configured, skip
  if (openSearchClient === null) return false;     // Configured but failed to connect
  try {
    const { body } = await openSearchClient.cluster.health();
    return body.status === 'green' || body.status === 'yellow';
  } catch (e) {
    logError({ error: e as Error, name: 'openSearch', details: null });
    return false;
  }
},
```

**Files:** `src/pages/api/health.ts`

---

### Stream D: Cleanup & Polish (deferred, after Streams A-C)

Focus: Barrel export, migration script fixes, documentation. Low priority.

#### T14. Create barrel export for `src/server/opensearch/` [N2]
**Complexity:** S | **Priority:** Nice-to-have

Create `src/server/opensearch/index.ts` re-exporting the public API:
```ts
export { openSearchClient } from './client';
export { bulkOperation, deleteDocsById, deleteDocsByQuery } from './client';
export { syncToOpenSearch, syncDeleteByQuery } from './sync';
export { ensureIndex, swapIndex } from './util';
export { OPENSEARCH_METRICS_IMAGES_INDEX, metricsImagesMappings, metricsImagesSettings } from './metrics-images.mappings';
export * from './query-builder';
```

Update imports across the codebase (this is safe to do last since it's just import path changes).

**Files:** `src/server/opensearch/index.ts` (new), all consumer files (import path updates)

---

#### T15. Document PostFilter behavior differences [N5]
**Complexity:** S | **Priority:** Nice-to-have (documentation only)

Add a section to this migration doc or create `docs/opensearch-migration/behavior-notes.md` documenting:
- OpenSearch follows PreFilter semantics
- Three behavior differences vs PostFilter: `disablePoi` owner bypass, NSFW unscanned handling, published-date logic

**Files:** Documentation only

---

## Task Dependency Graph

```
T1 (merge bulk ops) ──→ T2 (sync helper) ──→ T3 (replace call sites) ──→ T4 (Promise.all dual-writes)
                                          └──→ T5 (deletion in cleanup)
                                          └──→ T6 (remove dead code)

T7 (smart cache)     ──→ (independent, no blockers)
T8 (Axiom logging)   ──→ (independent, no blockers)
T9 (post-filters)    ──→ (independent, no blockers)
T10 (search_after)   ──→ (independent, no blockers)

T11 (SSL config)     ──→ (independent, no blockers)
T12 (shard config)   ──→ (independent, no blockers)
T13 (health check)   ──→ (independent, no blockers)

T14 (barrel export)  ──→ depends on T1, T2, T6 (API surface must be stable)
T15 (documentation)  ──→ (independent, no blockers)
```

**Cross-stream dependencies:**
```
T1 → T2 → T3 (strict chain within Stream A)
T3 → T4 (parallelize writes needs the sync helper)
T2 → T5 (cleanup path needs the sync helper)
T1+T2+T6 → T14 (barrel export needs stable API)
```

**No cross-stream dependencies for Streams B and C** -- they can start immediately in parallel with Stream A.

---

## Execution Timeline

### Phase 1: Foundation (blocks everything else in Stream A)
| Task | Stream | Complexity | Can Start |
|------|--------|-----------|-----------|
| T1: Merge bulk ops + fix retry | A | S | Immediately |
| T7: Port smart cache | B | M | Immediately |
| T8: Add Axiom logging | B | S | Immediately |
| T9: Move post-filters to query | B | S | Immediately |
| T10: `search_after` pagination | B | M | Immediately |
| T11: SSL config | C | S | Immediately |
| T12: Shard config | C | S | Immediately |
| T13: Health check | C | S | Immediately |

### Phase 2: Main implementation (after T1 completes)
| Task | Stream | Complexity | Depends On |
|------|--------|-----------|------------|
| T2: Create `syncToOpenSearch` | A | M | T1 |
| T3: Replace all call sites | A | S | T2 |
| T5: Add OS deletion to cleanup | A | S | T2 |
| T6: Remove dead code | A | S | T2 (for clean imports) |

### Phase 3: Polish (after T3 completes)
| Task | Stream | Complexity | Depends On |
|------|--------|-----------|------------|
| T4: Parallelize dual-writes | A | S | T3 |
| T14: Barrel export | D | S | T1, T2, T6 |
| T15: Behavior docs | D | S | None |

---

## Agent Count Recommendation

**3 agents** is optimal:

### Agent 1: Write-Path (Stream A)
Owns all write-path infrastructure. Sequential chain: T1 → T2 → T3 → T5 → T4 → T6.

This agent touches the most files but does surgical edits (replacing `if (openSearchClient && ...)` blocks with single function calls). The bulk of the creative work is in T1 (merge bulk ops) and T2 (sync helper); T3-T6 are mechanical.

### Agent 2: Read-Path (Stream B)
Owns `image.service.ts` (OpenSearch function only) and `query-builder.ts`. Runs T7, T8, T9, T10.

T7 (smart cache) and T8 (Axiom logging) touch different parts of the same function and can be done sequentially. T9 (post-filters) and T10 (search_after) are also in the same function. This agent works entirely within the OpenSearch read function, so no conflicts with Agent 1 who works on write paths.

**Important**: T7 and T9 both modify the post-filter block (lines 3500-3517). Do T9 first (moves filters into query, shrinking the post-filter block), then T7 (replaces the DB existence check with smart cache). This avoids merge conflicts.

Suggested order: T9 → T8 → T7 → T10.

### Agent 3: Config (Stream C)
Owns env vars, client config, health check, mappings settings. Runs T11, T12, T13, then T14.

These are all small, independent tasks in files nobody else touches. Agent 3 finishes fastest and can pick up T14 (barrel export) and T15 (docs) as stretch goals.

**Why not 4+ agents?** The bottleneck is file ownership. Adding a 4th agent would risk merge conflicts since Streams A and B already cover all the opensearch-related files. Stream C's tasks are too small to justify splitting further.

**Why not 2 agents?** Stream B work (especially T7, T10) has no dependency on Stream A, so running them in parallel saves significant wall-clock time.

---

## Decision Points for Justin

### 1. Production shard count (T12)
**Question:** How large is the `metrics_images` index expected to grow? How many OpenSearch nodes in production?
**Recommended default:** `number_of_shards: 2, number_of_replicas: 1` (safe for up to ~50M docs; can re-shard later via reindex + alias swap).
**Agent action if no response:** Use env vars with defaults of `shards=1, replicas=0` (current behavior). Production values are set via env config, not code changes.

### 2. PreFilter vs PostFilter semantics (T15)
**Question:** OpenSearch matches PreFilter behavior. Is this intentional?
**Recommended default:** Yes, PreFilter is the target. PostFilter is the legacy path being deprecated.
**Agent action if no response:** Document that OpenSearch = PreFilter and proceed. No code changes needed.

### 3. Smart cache flag strategy (T7)
**Question:** Should OpenSearch reuse the same `FEED_IMAGE_EXISTENCE` Flipt flag as the Meili functions, or get a separate flag?
**Recommended default:** Same flag. The cache is backend-agnostic (Redis-based existence check), and having one flag is simpler.
**Agent action if no response:** Use the same `FEED_IMAGE_EXISTENCE` flag.

### 4. Migration script cleanup (N1, N4)
**Question:** Will the migration script be run again?
**Recommended default:** Treat it as one-shot. Don't fix N1/N4 now.
**Agent action if no response:** Skip N1 and N4. They're not in the task list.

### 5. `search_after` cursor format (T10)
**Question:** The current API uses `entry` (a unix timestamp) as the cursor. Switching to `search_after` requires a `[sortAtUnix, id]` tuple. Should the API accept a new cursor format?
**Recommended default:** Encode `search_after` values into the existing `nextCursor` number by using a composite format, or add an optional `searchAfterCursor` param alongside `entry`. Keep backward compat.
**Agent action if no response:** Keep `entry` for backward compat, use `search_after` internally when `entry` is present, fall back to `from` for explicit offset requests.

---

## Summary

| Priority | Tasks | Total Count |
|----------|-------|-------------|
| Critical | T1, T2, T3, T5, T7, T11, T12 | 7 |
| Important | T4, T6, T8, T9, T10, T13 | 6 |
| Nice-to-have | T14, T15 | 2 |

**Estimated parallelism:** With 3 agents, all Critical and Important tasks complete in ~3 phases. Stream B and C start immediately; Stream A's T2-T6 run after T1 finishes. Total wall-clock time is gated by Stream A's sequential chain (T1→T2→T3→T4), which is the longest path.
