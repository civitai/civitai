# Collection AI Review

Automated moderation of collection items sitting in `CollectionItem.status = 'REVIEW'`. A cron
classifies pending items with a vision model and applies accept/reject through the existing
`updateCollectionItemsStatus` service.

Config lives in `KeyValue` under `collection-ai-review:<collectionId>`, written only through
`collection.setAiReview` (`moderatorProcedure` + the `collectionAiReview` Flipt flag).

It is deliberately **not** on `Collection.metadata`: the `Collection_contests` index is a covering
index that `INCLUDE`s `metadata`, so a Contest collection's entire metadata must fit the btree row
limit (~2704 bytes). The prompt alone is larger, and writing it there fails with SQLSTATE 54000.
Contest metadata in prod currently runs ~204 bytes average, 708 max — there is no room to grow into.

## Design

The prompt itself is **not in this repository**. It lives in `KeyValue` under `collection-ai-review:default`
(the seed the moderation dialog offers) and per collection under `collection-ai-review:<id>`,
readable only through the moderator-gated `collection.getAiReview*` procedures.

The model reports **observations only**. `decideFromObservations()` in `src/server/services/ai/collection-review.service.ts` turns
those into `approve | reject | escalate`. Keeping the rules out of the model means the policy is
auditable, can be retuned without reclassifying, and a hedging model cannot approve something the
rules forbid.

Violations are a **closed enum**. Rejection copy is resolved from that enum (overridable per collection via `reasonCopy`) and never from model output,
so no submitter is shown generated text.

## Audit table

Decisions are written to ClickHouse **before** the status write. `collection-game-processing`
hard-deletes rejected Buzz Beggars Board rows within the hour, so a decision that is not recorded
here leaves no trace of what the model did or why.

Apply manually — we do not auto-run ClickHouse DDL. The tracker route must exist too. If it does
not, `send` gets a 4xx and logs to Axiom rather than failing the job, so confirm provisioning after
the first dry run with:

```
['civitai-prod'] | where name == 'Failed to track (4xx)' and details.table == 'collectionAiReviewEvents'
```

An empty result plus rows in ClickHouse means the audit trail is live.

```sql
CREATE TABLE IF NOT EXISTS default.collectionAiReviewEvents (
  createdAt         DateTime64(3) DEFAULT now64(3),
  collectionId      Int32,
  collectionItemId  Int64,
  entityId          Int64,                  -- the reviewed image
  userId            Int32,                  -- always -1 (system); kept for Tracker parity
  model             LowCardinality(String), -- e.g. 'xiaomi/mimo-v2.6-flash'
  decision          LowCardinality(String), -- what the rules concluded
  appliedAction     LowCardinality(String), -- what was actually done: accept | reject | stamp | none
  violations        Array(LowCardinality(String)),
  escalations       Array(String),          -- may contain model-authored text; never user-facing
  reason            String CODEC(ZSTD(3)),  -- the model's own wording, for auditing only
  applied           UInt8,                  -- 0 when the collection is in dry run
  promptTokens      UInt32,
  completionTokens  UInt32,
  -- added by src/server/clickhouse/migrations/2026-11-11-collection-ai-review-observations.sql
  nsfwLevel         UInt8 DEFAULT 0,        -- the image's level at decision time; 0 on older rows
  minorUncertain    Int8 DEFAULT -1,        -- model observations: 1 / 0, -1 = no readable answer
  depictsMinor      Int8 DEFAULT -1,
  isPhotorealistic  Int8 DEFAULT -1,
  suggestiveStyling Int8 DEFAULT -1,
  sexualContent     Int8 DEFAULT -1
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(createdAt)
ORDER BY (collectionId, collectionItemId, createdAt);
```

`ReplacingMergeTree` because the tracker delivers at-least-once: it retries on 5xx, and a NATS ack
timeout means the row landed _and_ got retried. `createdAt` is stamped in JS, so a redelivery is
byte-identical and collapses on merge. Add `FINAL` when a query must not see a duplicate before the
next merge.

`collectionId` leads the sort key, so both expected reads — "what did the model do on collection X"
and "what did it do recently" — stay prefix scans.
`escalations` is `Array(String)` rather than `LowCardinality` because unrecognized-category entries
interpolate model output and are unbounded.

### Useful queries

```sql
-- decision mix for a collection
SELECT decision, count() FROM collectionAiReviewEvents
WHERE collectionId = 3870938 GROUP BY decision;

-- why things were rejected
SELECT arrayJoin(violations) AS v, count() FROM collectionAiReviewEvents
WHERE collectionId = 3870938 AND decision = 'reject' GROUP BY v ORDER BY 2 DESC;

-- spend
SELECT sum(promptTokens) AS pTok, sum(completionTokens) AS cTok, count() AS calls
FROM collectionAiReviewEvents WHERE createdAt > now() - INTERVAL 1 DAY;

-- where the rules and the applied action diverge (escalations configured to reject)
SELECT decision, appliedAction, count() FROM collectionAiReviewEvents
WHERE collectionId = 3870938 GROUP BY decision, appliedAction;

-- what a dry run would have done
SELECT collectionItemId, entityId, decision, violations, reason
FROM collectionAiReviewEvents WHERE collectionId = 3870938 AND applied = 0
ORDER BY createdAt DESC LIMIT 100;
```

## Collection mode

AI review is configured independently of collection mode. A non-contest image collection can
use AI review without inheriting contest ordering or hidden reaction counts. The scheduled job
reviews pending image entries; it does not review model, post, or article entries.
`updateCollectionItemsStatus` sends acceptance/rejection notifications for both contest and
non-contest collections. Configuration remains moderator-only and feature-flag protected.

Enabling AI review does not change a collection's mode or write permissions. Submissions must
enter `REVIEW` to reach the job, so use the `Review` write configuration for a moderated board.
Existing contest collections keep their current behavior.

For the Buzz Beggars Board to show reaction counts, its operator must separately change its mode
from `Contest` to the normal collection mode (`null`), retaining its AI review configuration and
`Review` write configuration. This is a configuration change, not a schema migration.
`maxItemsPerUser` is enforced for both contest and normal collections: accepted and pending
entries consume slots, rejected entries do not, and saving an existing entry does not consume
another slot in normal collections. Single-item and bulk writes to normal collections share a
transaction lock per collection and submitter. Contest entry validation retains its existing
prechecks, including checking the quota before charging entry fees or publishing a post.
Moderators retain their quota exemption. The collection page shows the configured entry limit
in either mode.

Submission windows still depend on contest entry validation, so review those settings before
changing an existing collection's mode. The board's expiry job is independent of collection mode.

## Operational notes

- **Throughput.** A vision call is ~3s at the median but 13-20s at the tail, and each chunk is a
  barrier waiting on its slowest straggler. `CONCURRENCY = 15` with `CHUNK_SIZE = 50` measures
  ~0.78 items/s, so a 300-item batch takes ~7 minutes. Chunk size is the crash-safety granularity —
  a dying run loses at most one chunk's classifications.
- **Dry run** (`aiReview.dryRun`) classifies and logs without changing any item's status or sending
  any notification. It exercises the real wiring — config read, image URLs, model call, ClickHouse
  write — which offline calibration does not.

  It does stamp `reviewedById`, so each item is classified once. Without that the job would reselect
  the whole backlog every run and re-bill it indefinitely. To re-run a dry run after changing the
  prompt, clear the stamps:

  ```sql
  UPDATE "CollectionItem" SET "reviewedById" = NULL, "reviewedAt" = NULL
  WHERE "collectionId" = <id> AND status = 'REVIEW' AND "reviewedById" = -1;
  ```

- **Items whose image the CDN will not serve are stamped after a failure** rather than retried every
  run. Clear the stamps with the query above to retry them.
- **`nsfwLevel = 0`** means ingestion has not rated the image yet; those items are skipped, not
  rejected, and picked up on a later run.
- **`allowedNsfwLevels`** is a bitmask of `NsfwLevel` flags. Anything outside it is rejected with no
  vision call.
- **A failed or unparseable model call never rejects a submission.** A failed call is retried on later
  runs until its attempts run out; then, or at once for a response that cannot be parsed, the item
  is stamped with its status unchanged, so a moderator decides it.
- **Items a moderator has already decided are left alone.** The job claims rows only while they are
  still `REVIEW` with no reviewer, so a human decision made mid-run keeps both its outcome and its
  attribution. An accept, or a rejection for a level outside `allowedNsfwLevels`, is claimed only
  while the image still has the level it was decided on; a re-rated image is reviewed again on the
  next run.
- **`escalationAction: 'leaveForHuman'`** stamps `reviewedById` without changing status, so the job
  does not reclassify (and re-bill) the item on the next run.
- The job acts as system user `-1` via an in-process `isSystem` flag on
  `updateCollectionItemsStatus`. That flag is never accepted from a tRPC input.
