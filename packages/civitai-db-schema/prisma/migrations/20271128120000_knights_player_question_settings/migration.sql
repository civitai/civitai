-- Idempotent: applied by hand, possibly more than once.
-- Per-player Knights settings: the yes/no questions switch (null follows the default saved on the moderator Config page)
-- and the preset tag groups a player hides. Apply before deploying Knights, which reads both columns on every pick.
ALTER TABLE "KnightsPlayer" ADD COLUMN IF NOT EXISTS "yesNoQuestions" BOOLEAN;
ALTER TABLE "KnightsPlayer" ADD COLUMN IF NOT EXISTS "hiddenTagGroups" TEXT[] NOT NULL DEFAULT '{}';
