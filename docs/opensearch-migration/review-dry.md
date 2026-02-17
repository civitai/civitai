# DRY & Code Quality Review: Meilisearch-to-OpenSearch Migration

## Summary

The migration introduces dual-write plumbing across ~12 files to keep Meilisearch and OpenSearch in sync behind a Flipt feature flag. While the individual implementations are correct, the approach has produced significant duplication in five areas: (1) a repeated flag-gate pattern copy-pasted into every write site, (2) duplicated index mappings between the TypeScript source of truth and the standalone migration script, (3) two nearly-identical bulk operation functions in `client.ts`, (4) two overlapping delete-by-ID functions, and (5) a large copy-paste of the entire query/filter-building logic between the Meilisearch and OpenSearch read paths. These should be consolidated before the flag is removed and OpenSearch becomes the sole backend.

---

## Findings

### 1. Repeated Flipt flag-gate pattern (High)

**Description:** The pattern `if (openSearchClient && (await isFlipt('feed-opensearch')))` is repeated verbatim in **6 locations** across 5 files. Each call site independently checks the client and the flag, then calls the appropriate bulk operation. This makes it easy to forget a site when changing behavior, and couples every consumer to Flipt internals.

**Locations:**
- `src/server/search-index/metrics-images.search-index.ts:509`
- `src/server/search-index/metrics-images--update-metrics.search-index.ts:100`
- `src/pages/api/mod/mark-poi-images-search.ts:106`
- `src/pages/api/mod/search/image-metrics-update.ts:101` (appears 3 times: lines 101, 172, 206)
- `src/server/jobs/full-image-existence.ts:58`
- `src/server/meilisearch/util.ts:258`

**Severity:** High

**Recommendation:** Extract a helper like `syncToOpenSearch({ operation: 'index' | 'update' | 'delete', indexName, documents, batchSize, jobContext? })` in `src/server/opensearch/sync.ts`. This function owns the flag check and delegates to `bulkIndexDocs`, `bulkUpdateDocs`, or `deleteDocsById`. All 6 call sites collapse to a single function call. When the migration is complete, this single function becomes the only place to remove the Meilisearch path.

---

### 2. Duplicated index mappings (High)

**Description:** The `metricsImagesMappings` object and `metricsImagesSettings` are defined identically in two places: the canonical TypeScript module and the standalone migration script. The comment in the script explicitly acknowledges this: `// ─── Index mappings (copied from metrics-images.mappings.ts)`.

**Locations:**
- `src/server/opensearch/metrics-images.mappings.ts:8-54` (canonical)
- `scripts/migrate-meili-to-opensearch.mjs:161-212` (copy)

**Severity:** High

**Recommendation:** The migration script should import from the canonical source. Since the script is an `.mjs` file, options include:
- Convert the script to `.mts` and use `tsx` to run it
- Have the script dynamically import the compiled output
- Extract the mappings to a shared `.json` file that both import

If any of these are impractical for a one-shot script, add a comment linking to the canonical source and a note that the script mappings are frozen at migration time. But ideally, single source of truth.

---

### 3. Duplicate delete-by-ID functions (Medium)

**Description:** Two separate functions delete documents by ID from OpenSearch using the exact same bulk API pattern:

- `deleteDocsById` in `client.ts:136-150` -- takes `{ indexName, ids: number[] }`, builds bulk delete body, calls `openSearchClient.bulk()`
- `deleteDocuments` in `util.ts:77-92` -- takes `(indexName, ids: number[])`, builds the same bulk delete body, calls `openSearchClient.bulk()`

The only differences are: (a) function signature style (object vs positional args), (b) `deleteDocuments` adds `console.log` calls, (c) neither is called by the other.

**Locations:**
- `src/server/opensearch/client.ts:136-150`
- `src/server/opensearch/util.ts:77-92`

**Severity:** Medium

**Recommendation:** Remove `deleteDocuments` from `util.ts` entirely. Update any call sites to use `deleteDocsById` from `client.ts` (or vice versa -- pick one). Currently `deleteDocuments` doesn't appear to be imported anywhere, so it may already be dead code.

---

### 4. Nearly-identical `bulkIndexDocs` and `bulkUpdateDocs` (Medium)

**Description:** These two functions in `client.ts` share ~90% of their code. The only difference is:
- `bulkIndexDocs` builds `{ index: { _index, _id } }` action lines and maps `doc` directly
- `bulkUpdateDocs` builds `{ update: { _index, _id } }` action lines and wraps as `{ doc: fields }`
- Error filtering checks `item.index?.error` vs `item.update?.error`

The retry logic, batching, error logging, and overall structure are identical.

**Locations:**
- `src/server/opensearch/client.ts:26-79` (`bulkIndexDocs`)
- `src/server/opensearch/client.ts:81-134` (`bulkUpdateDocs`)

**Severity:** Medium

**Recommendation:** Extract a shared `bulkOperation` function parameterized by the action type. The operation-specific logic (building action lines) can be a callback or a simple `mode: 'index' | 'update'` parameter. This cuts the file nearly in half and ensures retry/batching behavior stays consistent.

```ts
type BulkMode = 'index' | 'update';
async function bulkOperation({ mode, indexName, documents, batchSize, jobContext }: {
  mode: BulkMode;
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}) { /* shared retry + batching + error logging */ }
```

---

### 5. Large duplication between `getImagesFromSearchPreFilter` and `getImagesFromOpenSearch` (High)

**Description:** `getImagesFromOpenSearch` (starting at `image.service.ts:3234`) is a near-complete copy of `getImagesFromSearchPreFilter` (starting at line 2073). Both functions:
1. Destructure the same `ImageSearchInput`
2. Apply the same business logic filters (privacy, blocked, POI, minor, NSFW levels, model versions, remixes, tags, tools, techniques, period, published date, sort)
3. Post-process results identically (cursor logic, `filteredHits` filter, DB existence check, metrics hydration)

The only difference is the filter DSL: Meilisearch uses string filters (`makeMeiliImageSearchFilter`) while OpenSearch uses the query-builder helpers (`termFilter`, `termsFilter`, etc.).

**Locations:**
- `src/server/services/image.service.ts:2073-2457` (Meilisearch version, ~385 lines)
- `src/server/services/image.service.ts:3234-3554` (OpenSearch version, ~320 lines)

**Severity:** High

**Recommendation:** Extract the shared business logic into a backend-agnostic function. One approach:
- Define a `SearchBackend` interface with methods like `addFilter`, `addMustNot`, `setSort`, `execute`, etc.
- Implement `MeiliSearchBackend` and `OpenSearchBackend`
- The shared function builds filters through the interface, and the backend translates to the appropriate DSL

Alternatively, build a common "filter intent" representation (e.g., `{ field, op, value }` tuples) and convert to Meilisearch string filters or OpenSearch DSL at the end. This would also make it trivial to remove the Meilisearch path later.

---

### 6. Hardcoded index name string in migration script (Low)

**Description:** The migration script hardcodes `'metrics_images_v1'` as the default index name (line 92), while the canonical constant is `OPENSEARCH_METRICS_IMAGES_INDEX` in `metrics-images.mappings.ts:1`. If the index name changes, the script won't pick it up.

**Locations:**
- `scripts/migrate-meili-to-opensearch.mjs:92`
- `src/server/opensearch/metrics-images.mappings.ts:1`

**Severity:** Low

**Recommendation:** Import or reference the canonical constant. Same solution path as finding #2 -- the script should share the source of truth.

---

### 7. Inconsistent `openSearchClient` null checks (Low)

**Description:** The null check pattern varies. Most functions in `client.ts` start with `if (!openSearchClient) return;`, which is correct. But the dual-write call sites check `openSearchClient && (await isFlipt(...))` -- meaning the null check is done at the call site, not encapsulated. If the sync helper (finding #1) is introduced, this becomes moot.

**Locations:** All 6 dual-write sites listed in finding #1.

**Severity:** Low

**Recommendation:** Addressed by finding #1's recommendation. The sync helper should own the null check internally.

---

### 8. `ensureIndex` in `util.ts` duplicates logic in migration script's `osEnsureIndex` (Low)

**Description:** Both `ensureIndex()` in `util.ts:6-33` and `osEnsureIndex()` in `migrate-meili-to-opensearch.mjs:271-286` implement the same create-or-update-mappings logic. The migration script uses raw fetch while `util.ts` uses the SDK client.

**Locations:**
- `src/server/opensearch/util.ts:6-33`
- `scripts/migrate-meili-to-opensearch.mjs:271-286`

**Severity:** Low

**Recommendation:** If the migration script imports from the app (per finding #2), it can reuse `ensureIndex` directly. If not, this is acceptable duplication for a one-shot script.

---

### 9. Import organization inconsistency (Low)

**Description:** OpenSearch imports are scattered and inconsistent across files:
- Some files import `openSearchClient` from `~/server/opensearch/client` alongside `bulkIndexDocs` or `bulkUpdateDocs`
- Some import `deleteDocsByQuery` from client but `deleteDocuments` from util (different files for same concept)
- The `OPENSEARCH_METRICS_IMAGES_INDEX` constant is imported in every dual-write file individually

**Locations:** All files with OpenSearch dual-write code.

**Severity:** Low

**Recommendation:** Create a barrel export (`src/server/opensearch/index.ts`) that re-exports the public API. If the sync helper from finding #1 is created, most files only need `import { syncToOpenSearch } from '~/server/opensearch'`.

---

## Prioritized Action Plan

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Extract `syncToOpenSearch` helper to centralize flag-gate pattern | Small | Eliminates 6 duplicate blocks, single point for migration cutover |
| 2 | Unify `getImagesFromSearchPreFilter` / `getImagesFromOpenSearch` with backend abstraction | Large | Eliminates ~300 lines of duplication, prevents filter logic drift |
| 3 | Share index mappings between migration script and TypeScript source | Small | Single source of truth for schema |
| 4 | Merge `bulkIndexDocs` / `bulkUpdateDocs` into parameterized `bulkOperation` | Small | Cuts client.ts in half, ensures consistent retry behavior |
| 5 | Remove duplicate `deleteDocuments` from `util.ts` | Trivial | Dead code removal |
| 6 | Add barrel export for `src/server/opensearch/` | Trivial | Cleaner imports |
