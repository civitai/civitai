# Meilisearch → OpenSearch Parity Review

**Status: Gaps Found**
**Reviewed files:**
- `src/server/services/image.service.ts` — all three search functions
- `src/server/opensearch/metrics-images.mappings.ts`
- `src/server/opensearch/query-builder.ts`
- `src/server/search-index/metrics-images.search-index.ts`
- `src/server/search-index/metrics-images--update-metrics.search-index.ts`
- `src/pages/api/mod/mark-poi-images-search.ts`
- `src/pages/api/mod/search/image-metrics-update.ts`
- `src/server/meilisearch/util.ts`
- `src/server/jobs/full-image-existence.ts`
- `src/server/opensearch/client.ts`
- `src/server/opensearch/util.ts`
- `src/server/search-index/base.search-index.ts`

---

## 1. Filter Comparison Table

The OpenSearch function (`getImagesFromOpenSearch`, line 3234) is modeled after `getImagesFromSearchPreFilter` (line 2073). The PostFilter variant (line 2624) moves some checks to client-side. Below is an exhaustive comparison of every input parameter.

| Input | PreFilter (Meili) | PostFilter (Meili) | OpenSearch | Match? |
|---|---|---|---|---|
| `isModerator` (availability) | Pre-filter: `NOT availability = Private OR userId = current` | Post-filter: client-side `hit.availability === Private && !isOwnContent` | Pre-filter: `NOT availability = Private OR userId = current` | PreFilter match |
| `isModerator` (blockedFor) | Pre-filter: `blockedFor IS NULL OR NOT EXISTS OR userId = current` | Post-filter: client-side `hit.blockedFor && !isOwnContent` | Pre-filter: `NOT exists(blockedFor) OR userId = current` | PreFilter match |
| `postId` → `postIds` merge | Merges `postId` into `postIds` array | Same | Same | OK |
| `disablePoi` | `NOT poi = true OR userId = current` | `NOT poi = true` (no owner bypass) | `NOT poi = true OR userId = current` | **PreFilter match, differs from PostFilter** |
| `disableMinor` | `NOT minor = true` | Same | Same | OK |
| `poiOnly` (mod) | `poi = true` | Same | Same | OK |
| `minorOnly` (mod) | `minor = true` | Same | Same | OK |
| `blockedFor` (mod) | `blockedFor IN [...]` | Same | `termsFilter('blockedFor', blockedFor)` | OK |
| `hidden` | DB lookup → `id IN [imageIds]` | Same | Same | OK |
| `username` → `userId` | DB lookup, sets userId; logs to Axiom | Same + logs to Axiom | DB lookup, sets userId; **no Axiom log** | **GAP: missing Axiom log** |
| `followed` | DB lookup → `userId IN [followedIds]` | Same | Same | OK |
| `browsingLevel` / NSFW | `nsfwLevel IN [...] OR (nsfwLevel = 0 AND userId = current)` | Same, but unscanned filter only when `userId === currentUserId` | Same as PreFilter: `nsfwLevel IN [...] OR (nsfwLevel = 0 AND userId = current)` | **Difference**: PreFilter allows any `currentUserId` to see unscanned (line 2223-2225), PostFilter restricts to own-user page (line 2760). OpenSearch follows PreFilter. |
| `nsfwRestrictedBaseModels` | `NOT (nsfwLevel IN nsfw AND baseModel IN restricted)` | Same | `mustNot: AND(termsFilter(nsfw), termsFilter(baseModel))` | OK |
| `modelVersionId` | `postedToId = X OR modelVersionIds IN [X] OR modelVersionIdsManual IN [X]` (conditional on hideAutoResources/hideManualResources) | Same | Same | OK |
| `remixOfId` | `remixOfId = X` | Same | Same | OK |
| `remixesOnly` | `remixOfId >= 0` | Same | `rangeFilter('remixOfId', 'gte', 0)` | OK |
| `nonRemixesOnly` | `remixOfId NOT EXISTS` | Same | `mustNot: existsFilter('remixOfId')` | OK |
| `excludedTagIds` | `tagIds NOT IN [...]` | Same | `mustNot: termsFilter('tagIds', excludedTagIds)` | OK |
| `withMeta` | `hasMeta = true` | Same | Same | OK |
| `requiringMeta` | `blockedFor = AiNotVerified` | Same | `termFilter('blockedFor', AiNotVerified)` | OK |
| `fromPlatform` | `onSite = true` | Same | Same | OK |
| `notPublished` (mod) | `publishedAtUnix NOT EXISTS` | Same | `mustNot: existsFilter('publishedAtUnix')` | OK |
| `scheduled` (mod) | `publishedAtUnix > now` | Same | `rangeFilter('publishedAtUnix', 'gt', now)` | OK |
| Published (non-mod) | PreFilter: `publishedAtUnix <= snapToInterval(now) OR userId = current` | PostFilter: different logic for `userId` page vs general feed (lines 2849-2859) | `publishedAtUnix <= snapToInterval(now) OR userId = current` | **PreFilter match. Does not replicate PostFilter's userId-page optimization** |
| `types` | `type IN [...]` | Same | `termsFilter('type', types)` | OK |
| `tags` | `tagIds IN [...]` | Same | `termsFilter('tagIds', tags)` | OK |
| `tools` | `toolIds IN [...]` | Same | Same | OK |
| `techniques` | `techniqueIds IN [...]` | Same | Same | OK |
| `postIds` | `postId IN [...]` | Same | Same | OK |
| `baseModels` | `baseModel IN [strArray()]` | Same | `termsFilter('baseModel', baseModels)` | OK |
| `userId` | `userId = X` | Same | Same | OK |
| `excludedUserIds` | `userId NOT IN [...]` | Same | `mustNot: termsFilter('userId', excludedUserIds)` | OK |
| `period` → `afterDate` | `sortAtUnix > snapToInterval(afterDate)` | Same | `rangeFilter('sortAtUnix', 'gt', snapToInterval(...))` | OK |
| `entry` (cursor) | Only on default sort (desc): `sortAtUnix <= snapToInterval(entry)` | **Not used in PostFilter** (PostFilter uses offset-based pagination) | `sortAtUnix <= snapToInterval(entry)` | PreFilter match |
| `reviewId` | Logged as unsupported (Axiom) | Same | **Not logged** | **GAP: missing Axiom unsupported-field log** |
| `modelId` | Logged as unsupported (Axiom) | Same | **Not logged** | **GAP: missing Axiom unsupported-field log** |
| `prioritizedUserIds` | Commented-out block; logged as unsupported | Same | **Not logged** | **GAP: missing Axiom unsupported-field log** |
| `useCombinedNsfwLevel` | Switches to `combinedNsfwLevel` field | Same | Same | OK |

---

## 2. Sort Comparison Table

| Sort Mode | PreFilter (Meili) | PostFilter (Meili) | OpenSearch | Match? |
|---|---|---|---|---|
| `MostComments` | `commentCount:desc` | Same | `{ commentCount: { order: 'desc' } }` | OK |
| `MostReactions` | `reactionCount:desc` | Same | `{ reactionCount: { order: 'desc' } }` | OK |
| `MostCollected` | `collectedCount:desc` | Same | `{ collectedCount: { order: 'desc' } }` | OK |
| `Oldest` | `sortAt:asc` | Same | `{ sortAt: { order: 'asc' } }` | OK |
| Default (Newest) | `sortAt:desc` | Same | `{ sortAt: { order: 'desc' } }` | OK |
| Secondary sort (id) | Commented out (`//sorts.push(id:desc)`) | Same | Not present | OK (both commented out) |

---

## 3. Pagination Comparison

| Aspect | PreFilter (Meili) | PostFilter (Meili) | OpenSearch | Match? |
|---|---|---|---|---|
| **Mechanism** | `limit + 1` overfetch; `offset` param; `entry`-based cursor | Iterative batch fetching with adaptive sizing (`MAX_ITERATIONS=10`, post-filter loop) | `limit + 1` overfetch; `offset` param; `entry`-based cursor | **Matches PreFilter** |
| **nextCursor** | `results[0]?.sortAtUnix` if first request, else `entry` | Based on accumulated hits after iterative fetching | `results[0]?.sortAtUnix` if first request, else `entry` | **Matches PreFilter** |
| **entry filter** | Applied only on default desc sort: `sortAtUnix <= snapToInterval(entry)` | Not used (offset-based) | Same as PreFilter | OK |
| **Adaptive batch sizing** | No | Yes (doubles batch if >80% filtered) | No | **Matches PreFilter; lacks PostFilter's adaptive approach** |

---

## 4. Post-Query Filtering (Client-Side)

| Filter Step | PreFilter (Meili) | PostFilter (Meili) | OpenSearch | Match? |
|---|---|---|---|---|
| `!hit.url` | Filtered out | Same | Same | OK |
| `hit.acceptableMinor` | Only owner or mod | Same | Same | OK |
| `hit.nsfwLevel === 0` (unscanned) | Not a separate check (covered by NSFW pre-filter) | Separate check: `hit.nsfwLevel === 0 && !isOwnContent → false` | Not a separate check (matches PreFilter) | **Matches PreFilter** |
| `NsfwLevel.Blocked + needsReview` | `![0, Blocked].includes(nsfw) && !needsReview → true; else owner/mod` | Same | Same | OK |
| `hit.availability === Private` | Pre-filtered (not post-checked) | Post-checked: `Private && !isOwnContent → false` | Pre-filtered | Matches PreFilter |
| `hit.blockedFor` | Pre-filtered | Post-checked: `blockedFor && !isOwnContent → false` | Pre-filtered | Matches PreFilter |
| Published check post-filter | Not post-checked | Post-checked: `(!publishedAtUnix || > now) && !isOwnContent → false` | Not post-checked | Matches PreFilter |
| **DB existence check** | Yes + Flipt-gated smart cache | Yes + Flipt-gated smart cache | **Basic DB check only (no Flipt/smart cache)** | **GAP: no feature-flagged smart cache** |

---

## 5. `existedAtUnix` Check

**Status: Not an issue**

Both Meili functions have this block commented out:
```typescript
// nb: commenting this out while we try checking existence in the db
// const lastExistedAt = await redis.get(REDIS_KEYS.INDEX_UPDATES.IMAGE_METRIC);
// if (lastExistedAt) {
//   filters.push(makeMeiliImageSearchFilter('existedAtUnix', `>= ${lastExistedAt}`));
// }
```

The OpenSearch version correctly omits this. The `existedAtUnix` field IS in the OpenSearch mapping (for the `full-image-existence` job), which is correct.

---

## 6. Axiom Logging Comparison

| Event | PreFilter | PostFilter | OpenSearch | Match? |
|---|---|---|---|---|
| Username lookup fallback | `logToAxiom({ type: 'info', message: 'Using username...' })` | Same | **Missing** | **GAP** |
| Unsupported fields (reviewId, modelId, prioritizedUserIds) | `logToAxiom({ type: 'info', input: missingKeys })` | Same | **Missing** | **GAP** |
| Search error catch block | `logToAxiom({ type: 'search-error', ... })` | Same | Logs with `type: 'opensearch-error'` (different type) | OK (intentionally different type) |
| Prometheus metrics (`requestDurationSeconds`, `requestTotal`) | Yes | Yes | Yes | OK |
| Prometheus: `ffRequestsTotal`, `cacheHitRequestsTotal`, `droppedIdsTotal` | Yes (for Flipt-gated existence check) | Yes | **Missing** (no Flipt-gated cache) | **GAP** (follows from missing smart cache) |

---

## 7. `snapToInterval` Usage

| Context | PreFilter | PostFilter | OpenSearch | Match? |
|---|---|---|---|---|
| Published date (non-mod) | `snapToInterval(Math.round(Date.now()))` | `snapToInterval(Date.now())` (no Math.round) | `snapToInterval(Math.round(Date.now()))` | Matches PreFilter |
| Period filter (`afterDate`) | `snapToInterval(Math.round(afterDate.getTime()))` | `snapToInterval(afterDate.getTime())` (no Math.round) | `snapToInterval(Math.round(afterDate.getTime()))` | Matches PreFilter |
| `entry` cursor | `snapToInterval(Math.round(entry))` | N/A (not used) | `snapToInterval(Math.round(entry))` | Matches PreFilter |

The `Math.round` difference between PreFilter and PostFilter is a pre-existing inconsistency. OpenSearch correctly matches PreFilter.

---

## 8. Index Schema Completeness

**OpenSearch mappings** (`metrics-images.mappings.ts`) vs fields used in queries:

| Field | Used in Filters/Sorts? | In OS Mapping? | Match? |
|---|---|---|---|
| `id` | Filter (hidden), existence check | `integer` | OK |
| `index` | Not used in query | `integer` | OK |
| `postId` | Filter | `integer` | OK |
| `url` | Post-filter check | `keyword` | OK |
| `nsfwLevel` | Filter, post-filter | `integer` | OK |
| `aiNsfwLevel` | Not queried | `integer` | OK |
| `combinedNsfwLevel` | Filter (conditional) | `integer` | OK |
| `nsfwLevelLocked` | Not queried | `boolean` | OK |
| `width`, `height` | Not queried | `integer` | OK |
| `hash` | Not queried | `keyword` | OK |
| `hideMeta` | Not queried | `boolean` | OK |
| `sortAt` | Sort | `date` | OK |
| `sortAtUnix` | Filter (period, entry) | `long` | OK |
| `type` | Filter | `keyword` | OK |
| `userId` | Filter | `integer` | OK |
| `publishedAtUnix` | Filter | `long` | OK |
| `existedAtUnix` | Not queried (commented out) | `long` | OK |
| `hasMeta` | Filter | `boolean` | OK |
| `hasPositivePrompt` | Not queried | `boolean` | OK |
| `onSite` | Filter | `boolean` | OK |
| `postedToId` | Filter | `integer` | OK |
| `needsReview` | Post-filter check | `keyword` | OK |
| `minor` | Filter | `boolean` | OK |
| `poi` | Filter | `boolean` | OK |
| `acceptableMinor` | Post-filter check | `boolean` | OK |
| `blockedFor` | Filter | `keyword` | OK |
| `remixOfId` | Filter | `integer` | OK |
| `availability` | Filter | `keyword` | OK |
| `baseModel` | Filter | `keyword` | OK |
| `modelVersionIds` | Filter | `integer` | OK |
| `modelVersionIdsManual` | Filter | `integer` | OK |
| `toolIds` | Filter | `integer` | OK |
| `techniqueIds` | Filter | `integer` | OK |
| `tagIds` | Filter | `integer` | OK |
| `reactionCount` | Sort | `integer` | OK |
| `commentCount` | Sort | `integer` | OK |
| `collectedCount` | Sort | `integer` | OK |
| `flags.promptNsfw` | Filterable in Meili config but not currently queried | Nested `boolean` | OK |

All fields used in queries and sorts have corresponding mappings. Schema is complete.

---

## 9. Dual-Write Coverage

Every Meilisearch write path that touches `METRICS_IMAGES_SEARCH_INDEX` must also write to `OPENSEARCH_METRICS_IMAGES_INDEX`.

| Write Path | File | Meili Write? | OpenSearch Write? | Covered? |
|---|---|---|---|---|
| **Full index build** (`pushData`) | `metrics-images.search-index.ts:499-520` | `updateDocs()` | `bulkIndexDocs()` (Flipt-gated) | OK |
| **Metrics update** (`pushData`) | `metrics-images--update-metrics.search-index.ts:88-107` | `updateDocs()` | `bulkUpdateDocs()` (Flipt-gated) | OK |
| **POI marking** | `mark-poi-images-search.ts:95-112` | `updateDocs()` on both main + metrics indexes | `bulkUpdateDocs()` (Flipt-gated) | OK |
| **Image metrics update API** (`addFields`) | `image-metrics-update.ts:95-103` | `updateDocs()` | `bulkIndexDocs()` (Flipt-gated) | OK |
| **Image metrics update API** (`updateBaseModel`) | `image-metrics-update.ts:166-174` | `updateDocs()` | `bulkIndexDocs()` (Flipt-gated) | OK |
| **Image metrics update API** (`addCollections`) | `image-metrics-update.ts:200-208` | `updateDocs()` | `bulkIndexDocs()` (Flipt-gated) | OK |
| **Full image existence job** | `full-image-existence.ts:50-64` | `updateDocs()` | `bulkUpdateDocs()` (Flipt-gated) | OK |
| **User content removal** | `meilisearch/util.ts:257-271` | `deleteDocuments({ filter })` | `deleteDocsByQuery()` (Flipt-gated) | OK |
| **Queue-based delete** (`onSearchIndexDocumentsCleanup`) | `meilisearch/util.ts:96-148`, called from `base.search-index.ts:328,431,528` | `index.deleteDocuments(ids)` | **NOT written to OpenSearch** | **GAP** |
| **Reindex missing images script** | `scripts/oneoffs/reindex-missing-images.ts` | Queues for Meili update via Redis | No OpenSearch handling | **Minor GAP** (one-off script, not production) |

---

## 10. Summary of Gaps

### Critical Gaps

1. **Missing document deletion in OpenSearch** (`onSearchIndexDocumentsCleanup`)
   - **Location**: `src/server/meilisearch/util.ts:96-148`, called from `base.search-index.ts:328, 431, 528`
   - **Impact**: When documents are deleted from the Meilisearch metrics images index via the queue-based cleanup, they are NOT deleted from OpenSearch. Over time, this will cause stale/deleted images to appear in OpenSearch results but not Meilisearch results.
   - **Fix**: Add OpenSearch deletion in `onSearchIndexDocumentsCleanup` when the index is `METRICS_IMAGES_SEARCH_INDEX` and the `feed-opensearch` Flipt flag is enabled.

2. **No feature-flagged smart cache existence check**
   - **Location**: `image.service.ts:3507-3517` (OpenSearch) vs lines 2447-2576 (PreFilter) and 3046-3191 (PostFilter)
   - **Impact**: The OpenSearch version always does a basic DB existence check. The Meilisearch versions have a Flipt-gated Redis-based smart cache (`FEED_IMAGE_EXISTENCE` flag) that reduces DB load. When OpenSearch is fully rolled out, the DB will be hit on every request with no caching.
   - **Fix**: Port the smart cache existence check from PreFilter/PostFilter into `getImagesFromOpenSearch`.

### Minor Gaps

3. **Missing Axiom logs for username fallback and unsupported fields**
   - **Location**: `image.service.ts:3351-3354` (username lookup — no Axiom log), lines ~3440+ (no unsupported field logging for `reviewId`, `modelId`, `prioritizedUserIds`)
   - **Impact**: Loss of observability. These logs help track usage of unsupported query parameters.
   - **Fix**: Add the same `logToAxiom` calls.

4. **PostFilter-specific behavior not replicated**
   - The OpenSearch version matches **PreFilter** semantics. If the `FEED_POST_FILTER` flag was enabling PostFilter for some users, switching them to OpenSearch changes behavior in these areas:
     - `disablePoi`: PreFilter/OpenSearch allows owner bypass; PostFilter does not
     - NSFW unscanned: PreFilter/OpenSearch allows any logged-in user to see unscanned content with `nsfwLevel=0 AND userId=currentUserId`; PostFilter only allows it on the user's own page (`userId === currentUserId`)
     - Published date: PostFilter has special handling for userId-specific pages vs general feed; PreFilter/OpenSearch use a simpler `snappedNow OR userId = current`
     - Post-query filtering: PostFilter does additional client-side checks for availability, blockedFor, published status, and nsfwLevel that PreFilter/OpenSearch handle via pre-filtering
   - **Impact**: Behavior difference for users who were on PostFilter before being migrated to OpenSearch. This is likely intentional (OpenSearch models PreFilter), but should be documented.

5. **Missing Prometheus cache metrics in OpenSearch path**
   - `ffRequestsTotal`, `cacheHitRequestsTotal`, `droppedIdsTotal` are not emitted in the OpenSearch function because it lacks the smart cache.
   - These will be needed if/when the smart cache is ported.

---

## 11. Recommendations

1. **High priority**: Add OpenSearch document deletion to `onSearchIndexDocumentsCleanup` in `meilisearch/util.ts`. This is the only write path that is not dual-writing, and it will cause index drift over time.

2. **High priority**: Port the Flipt-gated smart cache existence check from the Meilisearch functions to OpenSearch. Without this, enabling OpenSearch for all users will significantly increase DB load.

3. **Medium priority**: Add the missing Axiom logging for username fallback and unsupported field tracking.

4. **Low priority**: Decide whether OpenSearch should match PreFilter or PostFilter semantics. Currently it matches PreFilter. If PostFilter is the desired target, the NSFW unscanned handling, `disablePoi` owner bypass, and published-date logic need adjustment.

5. **Low priority**: The `reindex-missing-images.ts` one-off script does not handle OpenSearch. If it needs to be run again, it should be updated.
