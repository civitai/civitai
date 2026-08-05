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
  -- 'owner' | 'moderator'. Set with status 'removed': the two removals refund
  -- opposite amounts, so the status alone cannot settle the money.
  "removedBy"         TEXT,
  "amount"            INTEGER NOT NULL,
  -- On the row, not a call argument: settlement is resumable, and a sweeper that
  -- never saw the argument would strand the seller's share with no record it was
  -- ever owed.
  "sellerId"          INTEGER,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"         TIMESTAMP(3),
  "resolvedAt"        TIMESTAMP(3),
  "resolvedById"      INTEGER,
  CONSTRAINT "Placement_amount_nonnegative" CHECK ("amount" >= 0)
);

-- Applied by hand, so every statement here has to survive a re-run after a
-- partial apply. A bare ADD CONSTRAINT aborts the second time through.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_ownerId_fkey') THEN
    ALTER TABLE "Placement"
      ADD CONSTRAINT "Placement_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_placerId_fkey') THEN
    ALTER TABLE "Placement"
      ADD CONSTRAINT "Placement_placerId_fkey"
      FOREIGN KEY ("placerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- A removed row that doesn't say who removed it is unsettleable: the two
  -- removals refund opposite amounts, so nothing can decide, and expiry can't
  -- reach it either because it is no longer pending. Its escrow would be frozen
  -- with no path out, which is the exact state `expiresAt` exists to prevent —
  -- so the state is made unrepresentable rather than guarded in code.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_removedBy_check') THEN
    ALTER TABLE "Placement"
      ADD CONSTRAINT "Placement_removedBy_check"
      CHECK (
        ("status" <> 'removed' AND "removedBy" IS NULL) OR
        ("status" =  'removed' AND "removedBy" IN ('owner', 'moderator'))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_status_check') THEN
    ALTER TABLE "Placement"
      ADD CONSTRAINT "Placement_status_check"
      CHECK ("status" IN ('pending', 'approved', 'declined', 'expired', 'removed'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "Placement_surface_targetType_targetId_status_idx"
  ON "Placement" ("surface", "targetType", "targetId", "status");
CREATE INDEX IF NOT EXISTS "Placement_ownerId_status_idx" ON "Placement" ("ownerId", "status");
CREATE INDEX IF NOT EXISTS "Placement_placerId_status_idx" ON "Placement" ("placerId", "status");
-- Drives the expiry sweep, which reads only pending rows past their deadline.
CREATE INDEX IF NOT EXISTS "Placement_status_expiresAt_idx" ON "Placement" ("status", "expiresAt");

-- One row per movement of money. The UNIQUE below is the actual idempotency
-- guard: a unique index on a column of "Placement" only says no two placements
-- share an id, which is a different proposition from "this placement's money
-- moved once". Here the INSERT itself is the lock — a second attempt at a leg
-- raises instead of paying — and every movement leaves a receipt, which four
-- nullable columns on "Placement" would not give: a settlement that got half
-- way needs to say which half, and a status column cannot.
CREATE TABLE IF NOT EXISTS "PlacementTransaction" (
  "id"            SERIAL PRIMARY KEY,
  "placementId"   INTEGER NOT NULL,
  "kind"          TEXT NOT NULL,
  "transactionId" TEXT,
  "amount"        INTEGER NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlacementTransaction_amount_nonnegative" CHECK ("amount" >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlacementTransaction_placementId_fkey') THEN
    ALTER TABLE "PlacementTransaction"
      ADD CONSTRAINT "PlacementTransaction_placementId_fkey"
      FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "PlacementTransaction_placementId_kind_key"
  ON "PlacementTransaction" ("placementId", "kind");
-- Drives the sweeper over legs that were claimed but never paid.
CREATE INDEX IF NOT EXISTS "PlacementTransaction_kind_createdAt_idx"
  ON "PlacementTransaction" ("kind", "createdAt");
