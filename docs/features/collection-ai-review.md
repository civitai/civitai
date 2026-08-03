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

The model reports **observations only** — `sexualContent`, `depictsMinor`, `hasBuzzReference` and
friends. `decideFromObservations()` in `src/server/services/ai/collection-review.service.ts` turns
those into `approve | reject | escalate`. Keeping the rules out of the model means the policy is
auditable, can be retuned without reclassifying, and a hedging model cannot approve something the
rules forbid.

Violations are a **closed enum**. During calibration every free-text category the model invented was
a false positive, so anything outside the enum escalates instead of rejecting. Rejection copy is
resolved from that enum (overridable per collection via `reasonCopy`) and never from model output,
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
  model             LowCardinality(String), -- e.g. 'xiaomi/mimo-v2.5'
  decision          LowCardinality(String), -- what the rules concluded
  appliedAction     LowCardinality(String), -- what was actually done: accept | reject | stamp | none
  violations        Array(LowCardinality(String)),
  escalations       Array(String),          -- may contain model-authored text; never user-facing
  reason            String CODEC(ZSTD(3)),  -- the model's own wording, for auditing only
  applied           UInt8,                  -- 0 when the collection is in dry run
  promptTokens      UInt32,
  completionTokens  UInt32
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(createdAt)
ORDER BY (collectionId, collectionItemId, createdAt);
```

`ReplacingMergeTree` because the tracker delivers at-least-once: it retries on 5xx, and a NATS ack
timeout means the row landed *and* got retried. `createdAt` is stamped in JS, so a redelivery is
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

## Contest collections only

`updateCollectionItemsStatus` sends its accept/reject notification only when
`collection.mode === CollectionMode.Contest`. Anywhere else the job would reject submissions
silently — and on boards where a cron deletes rejected rows, the entry disappears with no
explanation at all. `setCollectionAiReview` therefore refuses to enable AI review on a non-Contest
collection. Lifting that restriction means fixing the notification path first.

## Orphaned collection items

`CollectionItem."imageId"` had no foreign key in the database, although `schema.prisma` declares
`onDelete: Cascade` for it. Deleting an `Image` therefore left the collection row behind, invisible
to any query that joins `Image` but still counted as pending in review queues — 236,512 across the
table on 2026-08-03, 866 of them in `REVIEW`. The AI review job can never act on those, so they
accumulate in the queue looking like work.

Images are deleted from at least four places (`image.service.ts:406`, `:456`, `post.service.ts:980`,
`user.service.ts:1276`), two of them raw SQL and one a bulk `deleteMany`, so application-level
cleanup cannot be made airtight. The migration adds the missing constraint.

`articleId`, `postId` and `modelId` have the same drift — declared `Cascade` in the schema, absent
from the database. Their orphan counts are unmeasured; the combined scan timed out.

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
- **Our own uncertainty never rejects a submission.** A response the rules cannot parse, and a
  subject whose age the model could not determine, are both left for a human regardless of
  `escalationAction` — a provider outage must not reject submissions and tell the submitters they
  broke a rule.
- **`minorUncertain` alone does not escalate.** The prompt invites that hedge on exactly the
  stylized art these collections are made of, so on its own it would sweep up a large share of
  ordinary submissions. It escalates alongside a sexualized presentation, or when the image is
  photorealistic — `rules/minors.md` makes photorealism the bright line for minors in any context,
  so an ambiguous age matters there even where the image is otherwise wholesome.
- **Items a moderator has already decided are left alone.** The job claims rows only while they are
  still `REVIEW` with no reviewer, so a human decision made mid-run keeps both its outcome and its
  attribution.
- **`escalationAction: 'leaveForHuman'`** stamps `reviewedById` without changing status, so the job
  does not reclassify (and re-bill) the item on the next run.
- The job acts as system user `-1` via an in-process `isSystem` flag on
  `updateCollectionItemsStatus`. That flag is never accepted from a tRPC input.
