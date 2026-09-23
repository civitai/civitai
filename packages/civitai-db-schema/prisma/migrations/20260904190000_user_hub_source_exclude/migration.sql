-- Negative hub sources: a creator, model or version whose content is kept OUT of
-- the hub. Applied manually — see CLAUDE.md.
--
-- Additive and defaulted, so the currently deployed client (which does not select
-- the column) keeps working: apply this BEFORE the deploy that reads it, never after.

ALTER TABLE "UserHubSource" ADD COLUMN "exclude" BOOLEAN NOT NULL DEFAULT false;
