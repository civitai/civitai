-- Apply BEFORE the deploy. Prisma names every scalar column in a `findMany` without a `select`, so a
-- client that knows `data` fails every JobQueue read until the column exists. A nullable column the
-- running client does not know is harmless.
--
-- Per-type payload; its shape is owned by the code that reads and writes each type
-- (src/server/schema/job-queue.schema.ts).
-- Metadata-only, but ACCESS EXCLUSIVE: behind a long transaction on JobQueue it would queue every
-- insert and delete behind itself. Time out and retry instead.
SET lock_timeout = '3s';
ALTER TABLE "JobQueue" ADD COLUMN IF NOT EXISTS "data" JSONB;
