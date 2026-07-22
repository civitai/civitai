-- Moderator-curated "official" flag, decoupled from account ownership.
ALTER TABLE "Model" ADD COLUMN "isOfficial" BOOLEAN NOT NULL DEFAULT false;

-- One-time seed of the initial official set from the CivitaiOfficial account
-- (constants.system.officialUserId). After this, moderators curate the flag
-- per model; it is no longer tied to who owns the model.
UPDATE "Model" SET "isOfficial" = true WHERE "userId" = 12042163;
