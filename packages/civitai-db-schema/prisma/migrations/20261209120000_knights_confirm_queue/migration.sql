-- Knights confirm queue: a moderator's NSFW level change is rated again, blind, by a second moderator.
-- Agreement puts the image in the Knights Acolyte pool and sanity-check set; disagreement drops it.
--
-- Apply before the code that writes it ships. The FK to "Image" takes a SHARE ROW EXCLUSIVE lock on
-- "Image" while the table is created (blocks writes, not reads); re-run on lock timeout.

CREATE TABLE IF NOT EXISTS "KnightsConfirmItem" (
  "id"          SERIAL PRIMARY KEY,
  "imageId"     INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
  "firstLevel"  SMALLINT NOT NULL,
  "firstModId"  INTEGER NOT NULL,
  "firstSetAt"  TIMESTAMPTZ(3) NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'agreed', 'disagreed')),
  "secondLevel" SMALLINT,
  "secondModId" INTEGER,
  "secondAt"    TIMESTAMPTZ(3),
  "pooledAt"    TIMESTAMPTZ(3),
  "expiredAt"   TIMESTAMPTZ(3),
  "poolAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CHECK (("status" = 'open') = ("secondAt" IS NULL)),
  CHECK ("secondModId" IS NULL OR "secondModId" <> "firstModId"),
  CHECK ("status" <> 'agreed' OR "secondLevel" = "firstLevel"),
  CHECK ("status" <> 'disagreed' OR "secondLevel" <> "firstLevel")
);

CREATE INDEX IF NOT EXISTS "KnightsConfirmItem_status_createdAt_idx"
  ON "KnightsConfirmItem" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsConfirmItem_status_secondAt_idx"
  ON "KnightsConfirmItem" ("status", "secondAt");
CREATE INDEX IF NOT EXISTS "KnightsConfirmItem_imageId_idx" ON "KnightsConfirmItem" ("imageId");
-- One open item per image: a second level change before anyone confirms the first adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsConfirmItem_open_imageId_key"
  ON "KnightsConfirmItem" ("imageId") WHERE "status" = 'open';

-- Expiry is read lazily (`expiresAt > now`); nothing sweeps expired rows. "userId" has no FK so
-- deleting a moderator's account does not touch the item.
CREATE TABLE IF NOT EXISTS "KnightsConfirmClaim" (
  "itemId"    INTEGER NOT NULL REFERENCES "KnightsConfirmItem"("id") ON DELETE CASCADE,
  "userId"    INTEGER NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "token"     UUID NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY ("itemId", "userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnightsConfirmClaim_token_key" ON "KnightsConfirmClaim" ("token");
CREATE INDEX IF NOT EXISTS "KnightsConfirmClaim_userId_idx" ON "KnightsConfirmClaim" ("userId");
