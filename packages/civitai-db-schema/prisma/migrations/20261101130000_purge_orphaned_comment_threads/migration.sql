-- One-off purge of the comment threads that lost their entity before Thread's entity FKs
-- cascaded (20261101120000_thread_entity_fk_cascade): root threads with every entity column
-- null, plus reply threads whose parent comment was hard-deleted (commentId null under a live
-- entity). Nothing can render either. Everything deleted is copied to the `archive` schema first
-- and stays there until the CommentV3 teardown drops it.
--
-- HAND-APPLIED, after the FK-cascade migration (so the set is closed, not a stream). Data only;
-- the Prisma schema does not change. Run with autocommit (psql default): the batched DELETE is a
-- DO block that COMMITs per batch, which is refused inside a transaction block.
--
-- Deleting a Report here is safe because none of these reports is linked to any target other
-- than its orphaned comment (checked 2026-10-16); the guard in step 4 re-checks that per row.
--
-- 🔴 Apply one step at a time and read the counts in step 3 before running step 4 or 5.

SET lock_timeout = '5s';

-- 1. The set. `top` marks the rows the DELETE targets; everything else cascades from them.
CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE archive.orphan_thread_set AS
WITH RECURSIVE
  roots AS (
    SELECT id FROM "Thread"
    WHERE "parentThreadId" IS NULL
      AND "questionId" IS NULL AND "answerId" IS NULL AND "imageId" IS NULL AND "postId" IS NULL
      AND "reviewId" IS NULL AND "commentId" IS NULL AND "modelId" IS NULL AND "articleId" IS NULL
      AND "bountyId" IS NULL AND "bountyEntryId" IS NULL AND "clubPostId" IS NULL
      AND "comicProjectId" IS NULL AND "challengeId" IS NULL AND "model3dId" IS NULL
      AND "model3dReviewId" IS NULL AND "appListingId" IS NULL AND "crucibleId" IS NULL
  ),
  under_roots AS (
    SELECT t.id FROM "Thread" t JOIN roots r ON t."rootThreadId" = r.id
  ),
  dead_parent AS (
    SELECT id FROM "Thread"
    WHERE "parentThreadId" IS NOT NULL AND "commentId" IS NULL
  ),
  under_dead_parent AS (
    SELECT id FROM dead_parent
    UNION
    SELECT t.id FROM "Thread" t JOIN under_dead_parent u ON t."parentThreadId" = u.id
  ),
  members AS (
    SELECT id FROM roots
    UNION SELECT id FROM under_roots
    UNION SELECT id FROM under_dead_parent
  )
SELECT m.id,
       t."parentThreadId",
       (t."parentThreadId" IS NULL OR t."parentThreadId" NOT IN (SELECT id FROM members)) AS top
FROM members m JOIN "Thread" t ON t.id = m.id;

CREATE UNIQUE INDEX ON archive.orphan_thread_set (id);
CREATE INDEX ON archive.orphan_thread_set (id) WHERE top;

-- 2. Archive every row the purge removes, in dependency order.
CREATE TABLE archive."Thread" AS
  SELECT t.* FROM "Thread" t JOIN archive.orphan_thread_set s ON s.id = t.id;
CREATE TABLE archive."CommentV2" AS
  SELECT c.* FROM "CommentV2" c JOIN archive.orphan_thread_set s ON s.id = c."threadId";
CREATE TABLE archive."CommentV2Reaction" AS
  SELECT r.* FROM "CommentV2Reaction" r JOIN archive."CommentV2" c ON c.id = r."commentId";
CREATE TABLE archive."CommentV2Report" AS
  SELECT l.* FROM "CommentV2Report" l JOIN archive."CommentV2" c ON c.id = l."commentV2Id";
CREATE TABLE archive."Report" AS
  SELECT rp.* FROM "Report" rp JOIN archive."CommentV2Report" l ON l."reportId" = rp.id;
CREATE TABLE archive."ReportAutomated" AS
  SELECT ra.* FROM "ReportAutomated" ra JOIN archive."Report" rp ON rp.id = ra."reportId";
CREATE TABLE archive."ThreadMute" AS
  SELECT m.* FROM "ThreadMute" m JOIN archive.orphan_thread_set s ON s.id = m."threadId";
CREATE TABLE archive."EntityModeration" AS
  SELECT e.* FROM "EntityModeration" e JOIN archive."CommentV2" c
    ON e."entityType" = 'CommentV2' AND e."entityId" = c.id;
CREATE TABLE archive."JobQueue" AS
  SELECT j.* FROM "JobQueue" j JOIN archive."CommentV2" c
    ON j."entityType" = 'CommentV2' AND j."entityId" = c.id;

CREATE UNIQUE INDEX ON archive."Thread" (id);
CREATE UNIQUE INDEX ON archive."CommentV2" (id);
CREATE INDEX ON archive."CommentV2" ("threadId");
CREATE UNIQUE INDEX ON archive."CommentV2Reaction" (id);
CREATE UNIQUE INDEX ON archive."Report" (id);

-- 3. Counts. The archive must match the live set row for row before anything is deleted.
SELECT 'threads' AS what,
       (SELECT count(*) FROM archive.orphan_thread_set) AS in_set,
       (SELECT count(*) FROM archive.orphan_thread_set WHERE top) AS tops,
       (SELECT count(*) FROM archive."Thread") AS archived
UNION ALL
SELECT 'comments',
       (SELECT count(*) FROM "CommentV2" c JOIN archive.orphan_thread_set s ON s.id = c."threadId"),
       NULL,
       (SELECT count(*) FROM archive."CommentV2")
UNION ALL
SELECT 'reactions',
       (SELECT count(*) FROM "CommentV2Reaction" r JOIN archive."CommentV2" c ON c.id = r."commentId"),
       NULL,
       (SELECT count(*) FROM archive."CommentV2Reaction")
UNION ALL
SELECT 'reports', (SELECT count(*) FROM archive."CommentV2Report"), NULL, (SELECT count(*) FROM archive."Report")
UNION ALL
SELECT 'report_automated', NULL, NULL, (SELECT count(*) FROM archive."ReportAutomated")
UNION ALL
SELECT 'mutes', NULL, NULL, (SELECT count(*) FROM archive."ThreadMute")
UNION ALL
SELECT 'entity_moderation', NULL, NULL, (SELECT count(*) FROM archive."EntityModeration")
UNION ALL
SELECT 'job_queue', NULL, NULL, (SELECT count(*) FROM archive."JobQueue");

-- 4. Rows no FK reaches. The Report delete cascades its CommentV2Report link and ReportAutomated.
-- Guard: a report that is also linked to anything other than an archived comment is kept.
DELETE FROM "Report" rp
USING archive."Report" a
WHERE rp.id = a.id
  AND NOT EXISTS (
    SELECT 1 FROM "CommentV2Report" l
    WHERE l."reportId" = rp.id
      AND NOT EXISTS (SELECT 1 FROM archive."CommentV2" c WHERE c.id = l."commentV2Id")
  )
  AND NOT EXISTS (SELECT 1 FROM "ImageReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "CommentReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "UserReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "ModelReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "PostReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "ArticleReport" x WHERE x."reportId" = rp.id)
  AND NOT EXISTS (SELECT 1 FROM "ResourceReviewReport" x WHERE x."reportId" = rp.id);

DELETE FROM "EntityModeration" e USING archive."EntityModeration" a WHERE e.id = a.id;

DELETE FROM "JobQueue" j USING archive."JobQueue" a
WHERE j."entityType" = a."entityType" AND j."entityId" = a."entityId" AND j.type = a.type;

-- 5. The threads, in batches of tops. Nested threads, comments, reactions, remaining report
-- links and mutes cascade through the existing FKs. The two count triggers fire per cascaded row
-- and update parents that are going in the same statement — wasted work, not wrong results, and
-- the reason to batch. Re-runnable: it only ever picks tops that still exist.
DO $$
DECLARE
  batch integer[];
  n integer;
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
    FROM (
      SELECT s.id FROM archive.orphan_thread_set s
      WHERE s.top AND EXISTS (SELECT 1 FROM "Thread" t WHERE t.id = s.id)
      ORDER BY s.id LIMIT 2000
    ) b;
    EXIT WHEN batch IS NULL;

    DELETE FROM "Thread" WHERE id = ANY (batch);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'deleted % top threads, last id %', n, batch[array_upper(batch, 1)];
    COMMIT;
    PERFORM pg_sleep(0.2);
  END LOOP;
END $$;

-- 6. Verify: nothing from the set is left, and nothing new has formed since the FK cascade.
SELECT 'set_rows_left' AS what,
       (SELECT count(*) FROM "Thread" t JOIN archive.orphan_thread_set s ON s.id = t.id) AS n
UNION ALL
SELECT 'orphan_roots_now',
       (SELECT count(*) FROM "Thread"
        WHERE "parentThreadId" IS NULL
          AND "questionId" IS NULL AND "answerId" IS NULL AND "imageId" IS NULL AND "postId" IS NULL
          AND "reviewId" IS NULL AND "commentId" IS NULL AND "modelId" IS NULL AND "articleId" IS NULL
          AND "bountyId" IS NULL AND "bountyEntryId" IS NULL AND "clubPostId" IS NULL
          AND "comicProjectId" IS NULL AND "challengeId" IS NULL AND "model3dId" IS NULL
          AND "model3dReviewId" IS NULL AND "appListingId" IS NULL AND "crucibleId" IS NULL)
UNION ALL
SELECT 'archived_comments_still_live',
       (SELECT count(*) FROM "CommentV2" c JOIN archive."CommentV2" a ON a.id = c.id)
UNION ALL
-- Non-zero here is a report the step-4 guard kept because it also pointed at another target.
SELECT 'archived_reports_kept_by_guard',
       (SELECT count(*) FROM "Report" r JOIN archive."Report" a ON a.id = r.id);

RESET lock_timeout;

-- 7. Reclaim. Each on its own, outside a transaction.
VACUUM ANALYZE "Thread";
VACUUM ANALYZE "CommentV2";
VACUUM ANALYZE "CommentV2Reaction";

-- Restore, if ever needed: insert archive rows in FK order (Thread roots before children,
-- CommentV2, reactions, Report, ReportAutomated, CommentV2Report, ThreadMute) with
-- Thread.commentCount and CommentV2.reactionCount set to 0 — the count triggers re-increment on
-- insert — and trg_moderation_commentv2 disabled for the session, or it enqueues a moderation
-- job per restored comment.
