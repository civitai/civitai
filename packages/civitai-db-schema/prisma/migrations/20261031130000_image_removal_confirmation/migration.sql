-- Removals held for a second moderator: a moderator removed an image for the same reason that the
-- image's latest approved appeal overturned. The image stays up while the row is Pending; a moderator
-- holding the `image.removal.confirm` permission confirms (the removal then runs) or declines it on the
-- moderator app's /images/re-removals page.
--
-- HAND-APPLIED. Apply BEFORE the release that writes it: the block paths insert here, and a missing
-- table fails the removal instead of holding it.
--
-- 🔴 The FK to "Image" takes a SHARE ROW EXCLUSIVE lock on "Image" while the table is created (blocks
-- writes, not reads). Apply one statement at a time and re-run on lock timeout.

SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS "ImageRemovalConfirmation" (
  "id"               SERIAL PRIMARY KEY,
  "imageId"          INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
  "appealId"         INTEGER NOT NULL,
  "requestedById"    INTEGER NOT NULL,
  "requestedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "violationType"    TEXT,
  "violationDetails" TEXT,
  "source"           TEXT NOT NULL,
  "reportIds"        INTEGER[] NOT NULL DEFAULT '{}',
  "status"           TEXT NOT NULL DEFAULT 'Pending'
                     CHECK ("status" IN ('Pending', 'Confirmed', 'Declined', 'Void')),
  "decidedById"      INTEGER,
  "decidedAt"        TIMESTAMPTZ(3),
  "decisionNote"     TEXT,
  CHECK (("status" = 'Pending') = ("decidedAt" IS NULL))
);
RESET lock_timeout;

-- One open request per image: a second removal while one is pending joins it rather than queueing twice.
CREATE UNIQUE INDEX IF NOT EXISTS "ImageRemovalConfirmation_pending_imageId_key"
  ON "ImageRemovalConfirmation" ("imageId") WHERE "status" = 'Pending';
CREATE INDEX IF NOT EXISTS "ImageRemovalConfirmation_status_requestedAt_idx"
  ON "ImageRemovalConfirmation" ("status", "requestedAt");
CREATE INDEX IF NOT EXISTS "ImageRemovalConfirmation_imageId_idx"
  ON "ImageRemovalConfirmation" ("imageId");
