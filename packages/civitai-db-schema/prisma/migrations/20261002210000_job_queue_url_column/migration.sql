-- Apply BEFORE the deploy. Prisma names every scalar column in a `findMany` without a `select`, so a
-- client that knows `url` fails every JobQueue read until the column exists. A nullable column the
-- running client does not know is harmless.
ALTER TABLE "JobQueue" ADD COLUMN IF NOT EXISTS "url" TEXT;
