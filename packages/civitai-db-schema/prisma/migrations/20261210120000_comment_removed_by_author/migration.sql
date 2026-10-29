-- Additive and guarded: apply before the deploy that reads the column.
ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "removedByAuthor" boolean NOT NULL DEFAULT false;
