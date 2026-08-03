-- Paid-placement foundation: a creator-owned space someone pays to occupy.
-- `surface`, `entityType`/`targetType` and `mode`/`status` are TEXT rather than enums so
-- adding a surface stays a code change; the allowed values live in the surface table in
-- src/shared/utils/placement.ts, which denies anything it does not list.

CREATE TABLE IF NOT EXISTS "PlacementSpace" (
  "id"         SERIAL PRIMARY KEY,
  "surface"    TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId"   INTEGER NOT NULL,
  "mode"       TEXT NOT NULL,
  "price"      INTEGER,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlacementSpace_surface_entityType_entityId_key"
  ON "PlacementSpace" ("surface", "entityType", "entityId");
CREATE INDEX IF NOT EXISTS "PlacementSpace_entityType_entityId_idx"
  ON "PlacementSpace" ("entityType", "entityId");

CREATE TABLE IF NOT EXISTS "Placement" (
  "id"                SERIAL PRIMARY KEY,
  "surface"           TEXT NOT NULL,
  "targetType"        TEXT NOT NULL,
  "targetId"          INTEGER NOT NULL,
  "ownerId"           INTEGER NOT NULL,
  "placerId"          INTEGER NOT NULL,
  "data"              JSONB NOT NULL DEFAULT '{}',
  "status"            TEXT NOT NULL,
  "amount"            INTEGER NOT NULL,
  "buzzTransactionId" TEXT,
  "feeTransactionId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"         TIMESTAMP(3),
  "resolvedAt"        TIMESTAMP(3),
  "resolvedById"      INTEGER,
  CONSTRAINT "Placement_amount_nonnegative" CHECK ("amount" >= 0)
);

ALTER TABLE "Placement"
  ADD CONSTRAINT "Placement_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Placement"
  ADD CONSTRAINT "Placement_placerId_fkey"
  FOREIGN KEY ("placerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Placement_surface_targetType_targetId_status_idx"
  ON "Placement" ("surface", "targetType", "targetId", "status");
CREATE INDEX IF NOT EXISTS "Placement_ownerId_status_idx" ON "Placement" ("ownerId", "status");
CREATE INDEX IF NOT EXISTS "Placement_placerId_status_idx" ON "Placement" ("placerId", "status");
-- Drives the expiry sweep, which reads only pending rows past their deadline.
CREATE INDEX IF NOT EXISTS "Placement_status_expiresAt_idx" ON "Placement" ("status", "expiresAt");

-- One escrow charge per placement, so a retried hold cannot double-charge.
CREATE UNIQUE INDEX IF NOT EXISTS "Placement_buzzTransactionId_key"
  ON "Placement" ("buzzTransactionId") WHERE "buzzTransactionId" IS NOT NULL;
