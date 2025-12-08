# Testing ImagesFeed.createDocuments

**Created**: 2025-11-04
**Status**: Ready for Testing

## Overview

Created testing infrastructure for `ImagesFeed.createDocuments` including:
1. Mock helpers for unit testing
2. Dev API endpoints for live testing
3. Comparison endpoint (feed vs legacy)

## Files Created

### 1. Mock Helper
**Location**: `test/helpers/mock-feed-context.ts`

**Purpose**: Create mock `FeedContext` for unit testing without hitting real databases

**Functions**:
- `createMockFeedContext(mockData)` - Create mock context with test data
- `createMockImage(overrides)` - Generate mock SearchBaseImage
- `createMockMetrics(overrides)` - Generate mock metrics

### 2. Document Generation Endpoint
**Location**: `src/pages/api/dev-local/test-feed-documents.ts`

**Purpose**: Generate documents using ImagesFeed.createDocuments

**Endpoints**:
```bash
# Generate documents from real data
GET /api/dev-local/test-feed-documents?ids=1,2,3&type=full

# Generate only metrics
GET /api/dev-local/test-feed-documents?ids=1,2,3&type=metrics

# Use mocked data
GET /api/dev-local/test-feed-documents?ids=1,2,3&mock=true
```

**Response**:
```json
{
  "success": true,
  "config": {
    "ids": [1, 2, 3],
    "type": "full",
    "usedMock": false
  },
  "results": {
    "documentCount": 3,
    "durationMs": 145,
    "avgTimePerDoc": 48
  },
  "documents": [...],
  "sample": {
    "id": 1,
    "baseModel": "SD 1.5",
    "modelVersionIds": [200, 201],
    "reactionCount": 10,
    "commentCount": 5,
    "tagIds": [1, 2, 3, 4, 5],
    "sortAtUnix": 1704067200000
  }
}
```

### 3. Comparison Endpoint
**Location**: `src/pages/api/dev-local/compare-feed-legacy.ts`

**Purpose**: Compare feed implementation vs legacy transformData

**Endpoints**:
```bash
# Compare up to 10 IDs
GET /api/dev-local/compare-feed-legacy?ids=1,2,3
```

**Response**:
```json
{
  "success": true,
  "summary": {
    "totalCompared": 3,
    "matches": 3,
    "differences": 0,
    "missing": 0,
    "allMatch": true
  },
  "performance": {
    "feedDurationMs": 120,
    "legacyDurationMs": 150,
    "feedFaster": true,
    "speedupPercent": 20
  },
  "comparisons": [
    {
      "id": 1,
      "status": "match",
      "differences": []
    },
    {
      "id": 2,
      "status": "diff",
      "differences": [
        "doc[2].baseModel: 'SD 1.5' !== 'SDXL 1.0'"
      ],
      "feedDoc": {...},
      "legacyDoc": {...}
    }
  ]
}
```

### 4. Export Update
**Location**: `event-engine-common/feeds/images.feed.ts`

**Change**: Exported `createDocuments` function for testing
```typescript
export { createDocuments };
```

## Testing Workflow

### Step 1: Test with Mocked Data

```bash
# Quick test with fake data
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=1,2,3&mock=true"
```

**Expected**: Should return 3 documents with mocked data, no database hits

### Step 2: Test with Real Data

```bash
# Find some real image IDs first
# Then test document generation
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=123456,123457,123458&type=full"
```

**Expected**: Should return real documents from database

### Step 3: Compare with Legacy

```bash
# Compare same IDs against legacy implementation
curl "http://localhost:3000/api/dev-local/compare-feed-legacy?ids=123456,123457,123458"
```

**Expected**:
- `allMatch: true` if implementations are identical
- Performance metrics showing speed comparison
- Detailed diff if there are any differences

### Step 4: Test Metrics-Only

```bash
# Test lightweight metrics-only update
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=123456&type=metrics"
```

**Expected**: Document with only id, reactionCount, commentCount, collectedCount

## Expected Results

### What Should Match

When comparing feed vs legacy, these fields should be **identical**:

- `id`, `index`, `postId`, `userId`, `url`, `hash`, `width`, `height`, `type`
- `nsfwLevel`, `aiNsfwLevel`, `combinedNsfwLevel`
- `baseModel`, `modelVersionIds`, `modelVersionIdsManual`
- `toolIds`, `techniqueIds`, `tagIds`
- `reactionCount`, `commentCount`, `collectedCount`
- `sortAtUnix`, `publishedAtUnix`
- `poi`, `minor`, `acceptableMinor`, `blockedFor`, `availability`
- `hasMeta`, `hasPositivePrompt`, `hideMeta`, `onSite`, `needsReview`
- `postedToId`, `remixOfId`
- `flags.promptNsfw` (if present)

### What May Differ

- `existedAtUnix` - Always differs (current timestamp)
- Field order (doesn't matter for functionality)

### Performance Expectations

**Feed Implementation** should be:
- **Similar or faster** than legacy (target: within 10%)
- **More consistent** (no multi-step accumulation)
- **Easier to debug** (single function, clear data flow)

## Troubleshooting

### Error: "Cannot find module createDocuments"

**Fix**: Verify `createDocuments` is exported from `images.feed.ts`
```typescript
export { createDocuments };
```

### Error: "Missing ids parameter"

**Fix**: Provide comma-separated IDs in query string
```bash
?ids=1,2,3
```

### Error: "Failed to generate documents"

**Check**:
1. Database connections are working
2. Image IDs exist and have posts
3. Check server logs for detailed error

### Comparison shows differences

**Investigate**:
1. Check which fields differ
2. Verify data hasn't changed between calls
3. Check if legacy has bugs (feed might be correct!)
4. Review transformation logic in both implementations

## Next Steps

### Immediate
- [ ] Test mock endpoint to verify infrastructure works
- [ ] Find real image IDs to test with
- [ ] Run comparison on real data
- [ ] Verify 100% parity

### Follow-up
- [ ] Write Jest unit tests using mock helpers
- [ ] Test edge cases (missing data, null values, large batches)
- [ ] Performance benchmarks (1k, 10k, 100k IDs)
- [ ] Document any intentional differences
- [ ] Get approval for production use

## Usage Examples

### Quick Sanity Check
```bash
# Test with mocked data
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=1,2,3&mock=true" | jq '.sample'
```

### Verify Real Data
```bash
# Generate documents for specific images
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=9567088,9567089&type=full" | jq '.results'
```

### Check Parity
```bash
# Compare implementations
curl "http://localhost:3000/api/dev-local/compare-feed-legacy?ids=9567088,9567089" | jq '.summary'
```

### Performance Test
```bash
# Time document generation
time curl -s "http://localhost:3000/api/dev-local/test-feed-documents?ids=1,2,3,4,5,6,7,8,9,10&type=full" | jq '.results.durationMs'
```

## Notes

- Endpoints are dev-only (under `/api/dev-local/`)
- Comparison limited to 10 IDs to prevent overwhelming the server
- Mock mode useful for testing infrastructure without DB dependencies
- All timestamps are in milliseconds (Unix epoch)

---

**Ready to test!** Start with the mock endpoint, then move to real data comparison.
