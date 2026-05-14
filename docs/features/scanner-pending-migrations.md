# Scanner Audit — Pending Migrations

Run these in order before the new scanner-audit code paths will work end-to-end.

## 1. ClickHouse: drop + recreate `scanner_label_results`

The audit table moves from `MergeTree` to `AggregatingMergeTree`, with the dedup key as `(contentHash, version, label)` and `version` renamed from the old `policyHash`. There's no production data to preserve, so drop + recreate is cleanest.

Run against the civitai ClickHouse cluster:

```sql
DROP TABLE IF EXISTS scanner_label_results;

CREATE TABLE scanner_label_results (
  contentHash     String,
  version         String,
  label           LowCardinality(String),
  scanner         LowCardinality(String),
  entityType      LowCardinality(String),
  labelValue      LowCardinality(String),
  modelVersion    LowCardinality(String),

  score           SimpleAggregateFunction(anyLast, Float32),
  threshold       SimpleAggregateFunction(anyLast, Nullable(Float32)),
  triggered       SimpleAggregateFunction(max, UInt8),
  -- modelReason is NOT stored in ClickHouse — resolved lazily from the workflow
  -- by scanner-content.service and snapshotted to Postgres on review.
  matchedText     SimpleAggregateFunction(anyLast, Array(String)),
  matchedPositivePrompt SimpleAggregateFunction(anyLast, Array(String)),
  matchedNegativePrompt SimpleAggregateFunction(anyLast, Array(String)),
  durationMs      SimpleAggregateFunction(anyLast, UInt32),

  firstSeenAt     SimpleAggregateFunction(min, DateTime),
  lastSeenAt      SimpleAggregateFunction(max, DateTime),
  occurrences     SimpleAggregateFunction(sum, UInt64),
  workflowIds     SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
  entityIds       SimpleAggregateFunction(groupUniqArrayArray, Array(String))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(lastSeenAt)
ORDER BY (scanner, label, contentHash, version);
```

Column semantics:

- **`version`** (per-label) — policyHash from `result.policyHash` for XGuard scans; hardcoded `'1'` for image scans until the orchestrator team surfaces per-result version info on the `mediaRating` step.
- **`modelVersion`** (workflow-level) — scanner/model version stamp, sourced from `workflow.metadata.version`. Hardcoded `'1'` everywhere today.

Both kept as separate columns so when the orchestrator starts returning per-label version info on `mediaRating`, we can populate `version` independently of `modelVersion`.

## 2. Postgres: Prisma migrations

Three migrations to apply if not already. Apply via `pnpm prisma migrate deploy` (or `migrate dev` in dev).

- [`20260513120000_add_scanner_review_tables`](../../prisma/migrations/20260513120000_add_scanner_review_tables/migration.sql) — adds the `ReviewVerdict` enum + initial `ScannerScanReview` and `ScannerReview` tables. (If this never got applied because it landed alongside the workflowId-keyed design, that's fine — the next migration drops both tables and creates the right one.)
- [`20260513130000_add_tag_source_ai_anime`](../../prisma/migrations/20260513130000_add_tag_source_ai_anime/migration.sql) — adds `AiRecognition` and `AnimeRecognition` values to the existing `TagSource` enum.
- [`20260513140000_scanner_dedupe_refactor`](../../prisma/migrations/20260513140000_scanner_dedupe_refactor/migration.sql) — drops the workflowId-keyed `ScannerScanReview` + `ScannerReview` tables and creates the new `ScannerLabelReview` keyed by `(contentHash, version, label, reviewedBy)`.

## 3. Regenerate Prisma client

After running migrations:

```bash
pnpm run db:generate
```

This makes `dbWrite.scannerLabelReview` (referenced by [scanner-review.service.ts](../../src/server/services/scanner-review.service.ts)) actually exist. TypeScript errors on that import will clear once the client is regenerated.

## 4. Restart dev server

The new Prisma client + ClickHouse schema land at process startup. After the restart:

- `/moderator/scanner-audit` loads against the new dedup-keyed schema.
- `/api/admin/test?token=$WEBHOOK_TOKEN` exercises the full Redis-less write path (orchestrator → audit log). Hit it twice with the same input → second hit should `sum(occurrences)` to 2 rather than creating a duplicate row (visible after background merge; queries get the merged view immediately via `GROUP BY`).

## Verifying end-to-end

```sql
-- Should show one logical row per (contentHash, version, label):
SELECT
  contentHash, version, label,
  sum(occurrences) AS occurrences,
  max(lastSeenAt) AS lastSeenAt,
  groupUniqArrayArray(workflowIds) AS workflowIds
FROM scanner_label_results
WHERE lastSeenAt > now() - INTERVAL 1 HOUR
GROUP BY contentHash, version, label
ORDER BY lastSeenAt DESC;
```

```sql
-- Verdicts land here:
SELECT * FROM "ScannerLabelReview" ORDER BY "reviewedAt" DESC LIMIT 10;
```
