-- Deleting your own message hides it from both sides. The row is retained, for
-- the same reason a cleared conversation is: a ChatReport filed afterwards has
-- to stay reviewable, and the delete itself is recorded in the audit log.
ALTER TABLE "ChatMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);
