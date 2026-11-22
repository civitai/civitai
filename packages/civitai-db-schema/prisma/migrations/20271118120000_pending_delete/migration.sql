-- Pending deletes. Apply BEFORE either app (main or moderator) deploys: the new code inserts this
-- value, and an insert fails on an enum value the database does not have yet.
--
-- The JobQueue type a delete that has to wait is queued as: an owner's own delete a child-safety case
-- keeps, or a parent's cleanup of an image something still keeps. It replaces "ImageDelete", which
-- nothing drains once both apps run the new code.
--
-- Apply by hand. Dry run: the file inside BEGIN; ... ROLLBACK;.

ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'PendingDelete';
