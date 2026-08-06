# CSAM / blocked-image retention — follow-ups

Deferred items from the `remove-blocked-images` retention work (Aug 2026). Everything here was
found during review of that change but deliberately **not** included in it, either because it is a
behaviour change that wants its own testing, or because it is pre-existing debt the change merely
made visible. Address after those changes deploy and settle.

Context for anything below: `remove-blocked-images` (`src/server/jobs/image-ingestion.ts`) hard
deletes blocked media — the `Image` row and the S3 object — 7 days after the block. It reads
nothing but the `JobQueue` `BlockedImageDelete` rows, so the queue is the sole record of what is
pending deletion. It is currently **the only thing in the codebase that deletes CSAM media.**

---

## 1. Finish `removeContentForCsamReportsJob` — highest value

`src/server/jobs/process-csam.ts` — the job exists but has never been implemented: it was created
2023-12-18 with a copy-pasted placeholder body (`// await archiveCsamDataForReport(report)`) and
was never added to the exported `csamJobs` array. Consequently `contentRemovedAt` has never been
written by any code.

- [ ] Implement the removal step for reports that are both sent and archived
      (`getCsamsToRemoveContent` already selects exactly that set).
- [ ] Set `contentRemovedAt` on success.
- [ ] Add the job to `csamJobs`.
- [ ] Confirm ordering against `remove-blocked-images`: content removal must not race the archive,
      and the two jobs currently run at `:40` and `:00`.

Until this lands, `getCsamReportStats().unremoved` is a permanently-growing, undrainable counter
and the moderator dashboard column that reads it (`src/pages/moderator/csam/index.tsx`) is dead.

## 2. Alerting on a stranded CSAM report

The send/archive pipeline has **no retry limit, no backoff, and no dead-letter**. Every failure
leaves `reportSentAt` NULL and retries hourly forever:

- `processCsamReport` returns silently when NCMEC responds with a non-zero code — no log, no state
  change.
- `NcmecCaller.getInstance()` throws if `NCMEC_URL` / `NCMEC_USERNAME` / `NCMEC_PASSWORD` are
  missing, so a credential rotation strands every report at once.
- The `reportSentAt` write is inside an `if (isProd)`.

Historical latency (n=458): median 0.58h to send, but max 645h (27 days); median 1.3h to archive,
max 7,802h (325 days). **119 reports (26%) took longer than 7 days to archive.**

- [ ] Alert when any `CsamReport` is unsent for >24h or unarchived for >7d.
- [ ] Consider an attempt counter / dead-letter so a permanently-failing report is visible rather
      than silently retried forever.

This matters more now: the CSAM hold added in the retention work holds a user's blocked media while
they have an open report, bounded by `CSAM_HOLD_MAX_DAYS` (30). A stranded report means evidence is
purged at the ceiling with only an Axiom alert to show for it.

## 3. `archivedAt` is doing double duty

`archiveCsamDataForReport` stamps `archivedAt` for a `userId`-null (internal) report even though
nothing is archived — it now also writes `details.archiveSkipped` so the distinction is at least
recorded. That is a workaround, not a fix.

- [ ] Give "terminal but nothing stored" its own state rather than overloading `archivedAt`, so the
      moderator UI and any retention/completeness claim can tell the two apart.

## 4. Legacy `csam.service.ts` is a duplicate of `csam.service-new.ts`

Both files exist. Jobs import `-new`; `csam.controller.ts` and `csam.router.ts` still import the
old one. The old copy carries the same bugs — the `(e.message = '...')` assignment was fixed in
both, but the silent `if (!userId) return` remains in the legacy file, along with an unreferenced
`getCsamsToRemoveContent`.

- [ ] Delete `csam.service.ts` and point its two remaining consumers at `-new`, or finish the
      migration the `-new` suffix implies. Two copies of CSAM logic is how a fix gets applied to
      the wrong one.

## 5. `unblock-images.ts` clears `blockedFor` without touching `ingestion`

`src/pages/api/mod/unblock-images.ts` is a batch backfill that nulls `blockedFor` for images that
are not actually blocked (`needsReview` null, `nsfwLevel` not Blocked). It now also drops the
`BlockedImageDelete` queue rows, so it can no longer arm a purge on the very update meant to
unblock. But it still leaves `ingestion` untouched.

- [ ] Decide whether this is still needed at all — it reads like a one-shot cleanup tool. If it is,
      have it set `ingestion = 'Scanned'` for rows that really are `Blocked`; if not, delete it.

## 6. Orphaned blocked images (should be resolved by the migration — verify)

Before the `20260806130000_blocked_image_delete_queue_completeness` migration there were **12,689**
blocked, non-`AiNotVerified` images with no queue row, retained indefinitely with nothing to purge
them. The migration widens the trigger (INSERT, and `blockedFor` repoints) and backfills them.

- [ ] After applying, re-run the count below and confirm it is 0.
- [ ] `queueBlockedImagesForDelete` in `remove-deleted-user-images.ts` becomes redundant once the
      widened trigger is live. It is kept as belt-and-braces; drop it if that proves unnecessary.
- [ ] Drop the orphaned function, **as `postgres`** — the migration repoints the trigger to
      `queue_blocked_image_for_delete()` and leaves the old one with no callers:
      `DROP FUNCTION IF EXISTS blocked_image_delete_queue_trigger();`

### Function ownership footgun

`blocked_image_delete_queue_trigger()` and `image_scan_queue_trigger()` are owned by `postgres`,
because those migrations were applied as superuser. `create_job_queue_record()` and the `Image` /
`JobQueue` tables are owned by `civitai`, which is **not** a member of `postgres`. So `civitai` can
create triggers on its own tables and create new functions, but `CREATE OR REPLACE FUNCTION`
against either postgres-owned function fails with `must be owner of function` — and no `GRANT`
fixes that, since replacing a function requires ownership.

- [ ] Decide the convention: either apply DB migrations consistently as one role, or
      `ALTER FUNCTION ... OWNER TO civitai` (needs superuser) for the two stragglers, so the next
      person editing `image_scan_queue_trigger()` doesn't hit the same wall.

```sql
SELECT count(*) FROM "Image" i
WHERE i.ingestion = 'Blocked'::"ImageIngestionStatus"
  AND i."blockedFor" IS DISTINCT FROM 'AiNotVerified'
  AND NOT EXISTS (
    SELECT 1 FROM "JobQueue" q
    WHERE q."entityId" = i.id AND q."entityType" = 'Image'
      AND q.type = 'BlockedImageDelete'
  );
```

## 7. Deploy watch items

- [ ] **Deletion volume spike.** 576,255 of 602,662 queued rows were already past the 7-day cutoff
      at time of writing, so at `take: 15000` hourly this drains for ~38 hours at maximum deletion
      rate. Expect sustained S3/DB delete load and heavy use of the 20-minute job lock. This is a
      backlog being paid down — the new clock is strictly more conservative than the old one — but
      it will look like a spike.
- [ ] **The CSAM hold is inert in prod** (zero users currently have an open report), so it will not
      be exercised by real traffic on deploy. Unit tests are its only coverage. Watch the first
      real report through the full send → archive → release cycle.
- [ ] **External cron config.** `remove-csam-content` is still not exported in `csamJobs`, so if the
      out-of-repo scheduler has an entry for it, that entry 404s. Harmless (the job does nothing),
      but it will show as a failing cron.
- [ ] `image_userid_id_idx` existed in prod but not in the schema; it is now declared. No action in
      prod — the migration is a no-op there.

## 8. Feed ergonomics (`/moderator/csam/[userId]`)

`getImagesByUserIdForModeration` is a single unpaginated `findMany` over every image a user owns,
rendered all at once. The `?imageId=` deep link now pins and preselects the reported item, which
covers the report-driven workflow, but a moderator browsing a large account cold still loads
everything.

- [ ] Paginate the picker (the `InViewLoader` in `CsamImageSelection.tsx` is commented out) and add
      a filter/search, so the feed is usable without a deep link.
