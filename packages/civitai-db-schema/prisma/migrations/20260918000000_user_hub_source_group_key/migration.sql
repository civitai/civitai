-- Groups a hub's tag sources into AND-sets. Tags sharing a groupKey (within the same
-- `exclude` polarity of one hub) must ALL match; NULL is a group of one, which is the
-- behaviour every existing row already has. Additive and nullable, so no backfill and
-- nothing to order against a deploy.
ALTER TABLE "UserHubSource" ADD COLUMN "groupKey" INTEGER;
