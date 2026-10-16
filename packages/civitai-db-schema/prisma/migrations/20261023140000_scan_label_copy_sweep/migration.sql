-- A ledger of every object the scan label copy job writes, so the sweep can withdraw a copy whose
-- item or image no longer qualifies. No FK: a copy must stay tracked after its item or image row is
-- deleted, because that is exactly when it has to be withdrawn.
--
-- Apply before the build that ships it: the copy job writes the ledger before each upload, and the
-- sweep writes "withdrawn". Copies an older build makes after this runs are ledgered by the sweep.

CREATE TABLE IF NOT EXISTS "ScanLabelCopyObject" (
  "key"            TEXT PRIMARY KEY,
  "itemId"         INTEGER NOT NULL,
  "imageId"        INTEGER NOT NULL,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "withdrawnAt"    TIMESTAMPTZ(3),
  "withdrawReason" TEXT CHECK ("withdrawReason" IN ('excluded', 'ineligible', 'gone')),
  "withdrawError"  TEXT
);

CREATE INDEX IF NOT EXISTS "ScanLabelCopyObject_live_idx"
  ON "ScanLabelCopyObject" ("itemId") WHERE "withdrawnAt" IS NULL;

-- Copies made before the ledger existed.
INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId", "createdAt")
SELECT "copyKey", "id", "imageId", COALESCE("copiedAt", now())
FROM "ScanLabelItem"
WHERE "copyKey" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "ScanLabelItem" DROP CONSTRAINT IF EXISTS "ScanLabelItem_copyState_check";
ALTER TABLE "ScanLabelItem" ADD CONSTRAINT "ScanLabelItem_copyState_check"
  CHECK ("copyState" IN ('copied', 'skipped', 'failed', 'withdrawn')) NOT VALID;
ALTER TABLE "ScanLabelItem" VALIDATE CONSTRAINT "ScanLabelItem_copyState_check";
