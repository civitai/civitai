# Storage Object Cleanup — Audit & Design

Living doc tracking **which S3/R2/B2 objects each entity owns, whether they're DB-tracked, and how (or
whether) they get reclaimed when the owning record is deleted.** The goal is to move object deletion onto a
consistent **outbox / cleanup-job** model instead of best-effort synchronous deletes in the request path.

Uses the repo's `@dev:` / `@ai:` inline-comment convention for back-and-forth.

## Context / decisions so far

- **Uploads** are (or should be) client-direct with a user-authed, constraint-locked presign — no
  server-to-server hop needed.
- **Deletes** are server-side, and in practice happen in the **main app, in-process**, as a side effect of the
  DB mutation that removed the record. They do **not** currently route through `apps/storage`.
- The `apps/storage` service's remaining justification is narrow: isolating the genuinely dangerous creds
  (CSAM, maybe B2 delete) — not a general presign/delete broker. (Not deleting the service; right-sizing it.)
- **Preferred deletion shape: outbox / cleanup-job**, not synchronous delete-after-commit. A synchronous
  delete that fails after the row is gone silently orphans the object.

## The generic outbox we already have: `JobQueue`

**We do not need to build outbox infra — it exists.** [`JobQueue`](../packages/civitai-db-schema/prisma/schema.full.prisma)
is a generic entity-keyed queue:

```prisma
model JobQueue {
  type       JobQueueType   // CleanUp | BlockedImageDelete | CleanIfEmpty | UpdateNsfwLevel | UpdateSearchIndex | UpdateMetrics | ModerationRequest | ImageScan
  entityType EntityType     // Image | Post | Article | Model | ModelVersion | Bounty | ...
  entityId   Int
  createdAt  DateTime @default(now())
  @@id([entityType, entityId, type])   // idempotent by construction
}
```

- **Enqueue** — [enqueueJobs()](../src/server/services/job-queue.service.ts#L6): raw `INSERT … ON CONFLICT DO NOTHING`.
- **Process** — cron reads `where type = X`, groups by entityType via `reduceJobQueueToIds`, does the work,
  deletes the rows.

### Existing deletion types (one already deletes S3)

| Type | Job | Deletes S3? |
| --- | --- | --- |
| `BlockedImageDelete` | [removeBlockedImages](../src/server/jobs/image-ingestion.ts#L247) (daily) | **yes** — pulls `Image` from queue, 7-day retention gate, `deleteImages()` → `deleteImageFromS3` (refcount-guarded). **This is the precedent to generalize.** |
| `CleanUp` | [handleJobQueueCleanup](../src/server/jobs/job-queue.ts#L203) (every 1 min) | no — DB relations only (`imageConnection`, `collectionItem`) + nsfw recompute. **No producers currently enqueue it** (dormant processor). |
| `CleanIfEmpty` | deletes empty posts | n/a |

[deleteImages()](../src/server/services/image.service.ts#L454) already batch-deletes images **including S3**.

## DB reality: the existing `Outbox` table (checked 2026-07-16)

There **is** a live `Outbox` table (applied manually — not in Prisma migrations, so `grep` over `prisma/` misses
it). It is a **trigger-populated domain-event CDC outbox**, almost certainly the event-bus initiative's infra
([[event-bus-initiative]]). Current state:

- **Schema:** `Outbox(id bigint, event text, entityType enum, entityId bigint, createdAt timestamptz, details jsonb)`.
  `entityType` enum = `Article | Image | Model | Post | ModelVersion` (**no `File`/`ModelFile`**). Only PK on `id`.
- **Populated by 8 `outbox_*` triggers** on Image/Model/ModelVersion/Post. Events seen: `TO_SCAN`, `PUBLISHED`,
  `UPDATED`, `DELETED`, `UNPUBLISHED`.
- **The url-capture pattern already exists:** `outbox_image_to_scan` does
  `INSERT … details = jsonb_build_object('url', NEW.url)`. Proven in prod — not something to invent.
- **Delete events are insufficient for S3 cleanup:** `outbox_post_deleted` / `outbox_model_deleted` insert
  `(event, entityType, entityId)` with **no `details`/url**, and at **domain granularity** (Post/Model), not the
  Image/File/ModelFile rows that own S3 objects.
- **Dormant + never drained:** ~498k rows, oldest 2025-10-13, **newest 2026-06-17** (0 writes in last 7 days).
  **No relay/consumer exists** — nothing reads it. Triggers show attached+enabled in `pg_trigger` yet produce no
  rows, so status is unclear.

### Decision now hinges on the event-bus roadmap (not code)

The trigger→table→url-capture mechanism we designed **already exists here**. So "new table vs reuse Outbox" reduces to:

- **Reuse Outbox** (if the event-bus is being revived): add DELETE triggers on **Image/File/ModelFile** capturing
  `OLD.url` into `details` (copy the `to_scan` pattern), extend the `entityType` enum, and build the cleanup job as
  the **first real consumer**. Must define multi-consumer row retention — the table has no `processedAt`/offset, so a
  consumer that hard-deletes rows would break a future Kafka relay (and vice versa).
- **Dedicated storage-delete queue** (if Outbox is paused/abandoned): same trigger mechanism, a table we fully own,
  no coupling to dormant unowned infra. Converge at the event layer later.

**Open question blocking the choice:** is the `Outbox` / event-bus being revived, redesigned, or abandoned?

### Why we are NOT using `JobQueue` for this

`JobQueue` carries only `(entityType, entityId)` — no url payload — so a job could only reclaim by re-reading the
entity row, which forces soft-delete-everywhere. And it's populated by **app code** (`enqueueJobs`), so any new
delete path that forgets to enqueue silently reintroduces the orphan bug. Rejected in favor of DB triggers (below),
which capture the url from `OLD` and fire on *every* delete path unconditionally.

## Chosen design: dedicated outbox table + DB triggers

**Goal:** remove all inline S3 deletion from app code; a single job drains an outbox that DB triggers populate.

### Table (Prisma model for typed job reads; triggers added via raw migration)

```prisma
model StorageObjectDeleteQueue {   // name TBD
  id          BigInt   @id @default(autoincrement())
  url         String                       // S3 key/url captured from OLD row
  source      String                       // 'Image' | 'File' | 'ModelFile' | 'VaultItem' — picks bucket + guard
  entityId    Int?                         // for tracing only
  createdAt   DateTime @default(now())
  processAfter DateTime @default(now())    // grace window (see open decisions)
  attempts    Int      @default(0)
  lastError   String?
  @@index([processAfter])
}
```

### Triggers

- **`AFTER DELETE … FOR EACH STATEMENT` with a transition table** (`REFERENCING OLD TABLE AS old_rows`), doing one
  set-based `INSERT … SELECT url, '<source>' FROM old_rows`. Statement-level + transition table is the
  performance-right choice for high-volume tables (Image): a bulk delete of N rows writes the outbox in **one**
  insert, not N trigger firings. *(Verify cascade-delete coverage under this trigger form during testing — row-level
  is the fallback if a cascade path doesn't fire the statement trigger.)*
- **Tables:** `Image`, `File`, `ModelFile`, `VaultItem` (every S3-owning table). Each tags its `source`.
- **Migration is hand-written SQL, applied manually** (repo rule — we do not `migrate deploy`). Precedent:
  [w1_publish_requests migration](../prisma/migrations/20260528170000_w1_publish_requests/migration.sql).
- **Phase 1 = DELETE only.** URL *replacement* (model-file replace at
  [model-file.service.ts:172](../src/server/services/model-file.service.ts#L172), replaced-file purge) is an
  `AFTER UPDATE OF url` where `OLD.url <> NEW.url` — a phase-2 trigger. Keep phase 1 to row removal.

### The drain job (single job, replaces all inline S3 deletes)

1. Read a batch ordered by `id` where `processAfter <= now()`.
2. **Guard (required):** before deleting, re-query live tables — is any row still referencing this `url`? If yes,
   drop the outbox row without deleting (the object is still in use). This is the relocated
   `deleteImageFromS3` / `urlsSafeToDelete` guard.
3. Resolve backend (R2 vs B2) via existing `resolveMediaLocation(url)`; issue the S3 delete (idempotent, so
   reprocessing is safe); purge resize cache for images.
4. On success delete the outbox row; on failure bump `attempts` + set `lastError`, leave it for retry. Process by
   `id` so a poison row can't block the queue; park/alert past a max-attempts threshold.
5. Keep the `DATABASE_IS_PROD` gate: the outbox fills in every env, but the job only deletes objects in prod.

### Inline S3-delete call sites to remove (the sweep)

All of these stop touching S3 and rely on the trigger+job instead:

- Images: `deleteImageFromS3` and its callers — [image.service.ts:431](../src/server/services/image.service.ts#L431)
  (`deleteImageById`), [:488](../src/server/services/image.service.ts#L488) (`deleteImages`),
  [post.service.ts:1008](../src/server/services/post.service.ts#L1008), the blocked-image path in
  [image-ingestion.ts](../src/server/jobs/image-ingestion.ts).
- Model files: `deleteModelFileObject(s)` — [model-file.service.ts:172](../src/server/services/model-file.service.ts#L172),
  [:256](../src/server/services/model-file.service.ts#L256),
  [model-version.service.ts:865](../src/server/services/model-version.service.ts#L865),
  [:2801](../src/server/services/model-version.service.ts#L2801),
  [model.service.ts:1753](../src/server/services/model.service.ts#L1753),
  [purge-replaced-files.ts](../src/server/jobs/purge-replaced-files.ts) (→ folds into phase-2 replacement trigger).
- Training: `deleteObject` — [training.service.ts](../src/server/services/training.service.ts) (×4),
  [delete-old-training-data.ts](../src/server/jobs/delete-old-training-data.ts).
- Vault: `deleteManyObjects` — [vault.service.ts:292](../src/server/services/vault.service.ts#L292).
- Attachments (`File`) — currently **not** deleted anywhere; the trigger on `File` fixes the existing orphan.

### Costs / caveats to weigh

- **Every DELETE on these tables now writes an outbox row** (bigger txn, more WAL on hot tables like Image). Keep the
  trigger minimal and the table narrow; statement-level insert-select keeps bulk deletes cheap.
- **Triggers are invisible logic** — document them here and in the migration so they're discoverable.
- **Cascades fan out.** Deleting a user cascades to thousands of images → thousands of outbox rows in one txn. The
  job must batch; the statement-level trigger keeps the write itself a single statement.

### Open decisions

1. **Grace window** — immediate (`processAfter = now()`) or a short delay to absorb delete-then-recreate-same-url
   races? (Recommend a small delay, e.g. minutes.)
2. **Statement-level vs row-level trigger** — pending cascade-coverage verification.
3. **Table/enum naming** and whether `source` is a text tag or a Postgres enum.

## Older per-domain pattern (marker column + dedicated cron)

Predates the `JobQueue` unification; still live. Same idea, one job per domain instead of the shared queue:

| Job | Marker → scan | Guard | Idempotency |
| --- | --- | --- | --- |
| [purge-replaced-files.ts](../src/server/jobs/purge-replaced-files.ts) | `ModelFile.replacedAt` < now−30d AND `dataPurged` not true | refcount (`deleteModelFileObject` → `urlsSafeToDelete`) | sets `dataPurged = true` |
| [delete-old-training-data.ts](../src/server/jobs/delete-old-training-data.ts) | training `completedAt` > 30d, non-public, `dataPurged` not true | — | sets `dataPurged` |
| [user-deleted-cleanup.ts](../src/server/jobs/user-deleted-cleanup.ts) | `User.deletedAt` ≥ last run | — | `getJobDate`/`setLastRun` watermark |

Postgres `onDelete: Cascade`/`SetNull` handles related-**row** cleanup for free; jobs exist only for the
cross-system side effects the DB can't cascade (S3, search index).

## Entity audit

Status legend: ✅ reclaimed · ⚠️ reclaimed but fragile (silent-orphan risk) · ❌ orphaned (no S3 delete).

### Article — [deleteArticleById](../src/server/services/article.service.ts#L1261)

| Object | S3 on delete | DB-tracked | Mechanism | Status |
| --- | --- | --- | --- | --- |
| Cover image | yes | `Image` row + `Article.coverId` | `deleteImageById` → [deleteImageFromS3](../src/server/services/image.service.ts#L345) | ⚠️ |
| Content images (embedded in body) | only *truly orphaned* (no remaining `ImageConnection` to any entity) | `Image` rows + `ImageConnection` | `deleteImageById` | ⚠️ |
| Attachments (`File` rows) | **no** | `File` row (`entityType='Article'`) until deleted | `tx.file.deleteMany` — **row only** | ❌ |

**Findings:**

1. **Attachments are never deleted from S3.** Both the delete path
   ([article.service.ts:1288](../src/server/services/article.service.ts#L1288)) and the edit path that removes
   an attachment ([article.service.ts:1101](../src/server/services/article.service.ts#L1101)) call
   `tx.file.deleteMany(...)` and stop. The object at `File.url` is left in the bucket with no DB row referencing
   it → unreclaimable orphan. `File` has **no** refcount guard, grace period, or cleanup job.

2. **Image deletes are synchronous best-effort with swallowed errors.** `deleteImageFromS3` is refcount-guarded
   (`otherImagesWithSameUrl`) and prod-only, but wrapped in `catch { /* do nothing */ }` — and it runs *after*
   the `Image` row is already deleted. Any S3 failure (or the process dying mid-`deleteImageById`) silently
   orphans the object, with no reconciliation pass to catch it. This is the durability trap the outbox model
   is meant to close.

@ai:* Attachments look like the cleanest first target for the outbox pattern — a `File.deletedAt` marker + a
refcount-guarded purge job mirroring `purge-replaced-files`. Confirm which bucket attachments live in
(`File.url` is served via [/api/download/attachments/[fileId].ts](../src/pages/api/download/attachments/[fileId].ts))
before writing the guard, since the refcount check must scope to that backend.

### (next entities — Model, ModelVersion, Post, Bounty, …) — TODO
