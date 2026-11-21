-- A restricted licensing root: kept out of the version editor's picker, and a version may only gain it
-- as its licensing source through a moderator. Staff set it by hand.
--
-- Apply BEFORE the deploy: the version write path selects "restricted".
ALTER TABLE "LicensingRoot" ADD COLUMN IF NOT EXISTS "restricted" BOOLEAN NOT NULL DEFAULT false;
