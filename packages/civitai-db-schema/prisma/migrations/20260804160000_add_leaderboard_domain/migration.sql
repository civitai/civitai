-- Per-domain leaderboard visibility. Mirrors Announcement/Bug/Changelog.
-- Default [all] leaves every existing board visible everywhere, so applying this
-- alone is a no-op; the backfill below is what changes behavior.
ALTER TABLE "Leaderboard" ADD COLUMN "domain" "DomainColor"[] NOT NULL DEFAULT ARRAY['all']::"DomainColor"[];

-- The mature boards render on civitai.com today: leaderboard.service.ts had no
-- domain awareness, and `public` only distinguishes moderator from not.
UPDATE "Leaderboard" SET "domain" = ARRAY['red']::"DomainColor"[]
WHERE id IN ('overall_nsfw', 'images-nsfw');
