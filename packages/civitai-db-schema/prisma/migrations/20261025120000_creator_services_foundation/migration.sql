-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Services foundation: offerings, deals paid through Buzz escrow, the deal's
-- append-only event sheet, delivery files, and one receipt row per Buzz movement.
-- Nothing reads or writes these tables until the dark `creatorServices` flag ships code
-- that does, so this can be applied before or after the deploy that carries the client.
--
-- The REFERENCES "User" clauses take a SHARE ROW EXCLUSIVE lock on "User", which queues
-- behind any open write transaction on it and blocks new writes while it waits. The
-- timeout makes a contended run fail fast instead; re-run it, it is idempotent.

SET lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "ServiceOfferingStatus" AS ENUM ('Draft', 'Active', 'Paused', 'Removed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServicePreviewKind" AS ENUM ('Image', 'Video', 'SampleOutputs', 'None');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceBuzzType" AS ENUM ('yellow', 'blue', 'green');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealStatus" AS ENUM (
    'Requested', 'Accepted', 'Delivered', 'InRevision', 'Completed',
    'Declined', 'Expired', 'CancellationRequested', 'Cancelled', 'Disputed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealEventType" AS ENUM (
    'Requested', 'Accepted', 'Declined', 'Expired', 'Delivered', 'RevisionRequested',
    'Completed', 'CancellationRequested', 'CancellationAccepted', 'CancellationDeclined',
    'Cancelled', 'Disputed', 'DisputeResolved', 'DeadlineExtended', 'Held', 'Released',
    'Refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealFileKind" AS ENUM ('Preview', 'Final');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealFileScanStatus" AS ENUM ('Pending', 'Passed', 'Failed', 'NotScanned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDisputeResolution" AS ENUM ('Refund', 'Release');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealLeg" AS ENUM ('Hold', 'Release', 'Fee', 'Refund');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ServiceOffering" (
  "id"                SERIAL PRIMARY KEY,
  "sellerId"          INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title"             TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "coverImageId"      INTEGER,
  "price"             INTEGER NOT NULL CHECK ("price" > 0),
  "acceptsBlue"       BOOLEAN NOT NULL DEFAULT false,
  "previewKind"       "ServicePreviewKind" NOT NULL DEFAULT 'Image',
  "deliveryDays"      INTEGER NOT NULL CHECK ("deliveryDays" > 0),
  "revisionsIncluded" INTEGER NOT NULL DEFAULT 0 CHECK ("revisionsIncluded" >= 0),
  "maxOpenDeals"      INTEGER CHECK ("maxOpenDeals" > 0),
  "status"            "ServiceOfferingStatus" NOT NULL DEFAULT 'Draft',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceOffering_id_sellerId_key"
  ON "ServiceOffering" ("id", "sellerId");
CREATE INDEX IF NOT EXISTS "ServiceOffering_sellerId_status_idx"
  ON "ServiceOffering" ("sellerId", "status");
CREATE INDEX IF NOT EXISTS "ServiceOffering_status_createdAt_idx"
  ON "ServiceOffering" ("status", "createdAt");

-- Deals, their events, files and receipts RESTRICT deletes: they are the money record,
-- and a user or offering delete must not take it with them. Offerings are retired with
-- status 'Removed', never deleted.
CREATE TABLE IF NOT EXISTS "ServiceDeal" (
  "id"                        SERIAL PRIMARY KEY,
  "offeringId"                INTEGER NOT NULL REFERENCES "ServiceOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "buyerId"                   INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sellerId"                  INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "price"                     INTEGER NOT NULL,
  "buzzType"                  "ServiceBuzzType" NOT NULL,
  "feeAmount"                 INTEGER NOT NULL DEFAULT 0,
  "revisionsIncluded"         INTEGER NOT NULL CHECK ("revisionsIncluded" >= 0),
  "revisionsUsed"             INTEGER NOT NULL DEFAULT 0 CHECK ("revisionsUsed" >= 0),
  "deliveryDays"              INTEGER NOT NULL CHECK ("deliveryDays" > 0),
  "previewKind"               "ServicePreviewKind" NOT NULL,
  "status"                    "ServiceDealStatus" NOT NULL DEFAULT 'Requested',
  "heldAt"                    TIMESTAMP(3),
  "settledAt"                 TIMESTAMP(3),
  "chatId"                    INTEGER,
  "requestText"               TEXT NOT NULL,
  "requestedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt"                TIMESTAMP(3),
  "dueAt"                     TIMESTAMP(3),
  "deliveredAt"               TIMESTAMP(3),
  "completedAt"               TIMESTAMP(3),
  "releaseAt"                 TIMESTAMP(3),
  "cancellationRequestedAt"   TIMESTAMP(3),
  "cancellationRequestedById" INTEGER,
  "cancellationReason"        TEXT,
  "disputeOpenedAt"           TIMESTAMP(3),
  "disputeReason"             TEXT,
  "disputeResolvedAt"         TIMESTAMP(3),
  "disputeResolution"         "ServiceDisputeResolution",
  "disputeResolvedById"       INTEGER,
  "closedAt"                  TIMESTAMP(3),
  "closeReason"               TEXT,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL,
  -- The seller is paid `price - feeAmount`, so the fee can never reach the price. With the fee
  -- at least 0 this also refuses a free deal.
  CONSTRAINT "ServiceDeal_fee_below_price" CHECK ("feeAmount" >= 0 AND "feeAmount" < "price"),
  CONSTRAINT "ServiceDeal_buyer_not_seller" CHECK ("buyerId" <> "sellerId"),
  -- The release sweeper selects Completed deals by "releaseAt"; a Completed deal
  -- without one would never be paid out.
  CONSTRAINT "ServiceDeal_completed_has_releaseAt" CHECK ("status" <> 'Completed' OR "releaseAt" IS NOT NULL),
  -- A deal past Requested is one the buyer has paid for: the seller must never be able to
  -- accept, deliver or be paid on a deal whose hold never cleared.
  CONSTRAINT "ServiceDeal_held_before_work" CHECK (
    "heldAt" IS NOT NULL OR "status" IN ('Requested', 'Declined', 'Expired', 'Cancelled')
  ),
  CONSTRAINT "ServiceDeal_settled_after_held" CHECK ("settledAt" IS NULL OR "heldAt" IS NOT NULL),
  CONSTRAINT "ServiceDeal_dispute_resolution_consistent" CHECK (("disputeResolvedAt" IS NULL) = ("disputeResolution" IS NULL)),
  -- Release pays "sellerId", so it must be the offering's seller, not whatever a caller passed.
  -- NO ACTION on update: moving an offering to another seller must not redirect a deal's payout.
  -- Deals are never deleted, so an offering that has had ANY deal, open or closed, can never
  -- change seller. Not in the Prisma schema, which declares the offering relation on "offeringId"
  -- alone.
  CONSTRAINT "ServiceDeal_offering_seller_fkey" FOREIGN KEY ("offeringId", "sellerId")
    REFERENCES "ServiceOffering"("id", "sellerId") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- Target of the receipt's composite FK that pins each leg to the deal's Buzz type.
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDeal_id_buzzType_key" ON "ServiceDeal" ("id", "buzzType");

CREATE INDEX IF NOT EXISTS "ServiceDeal_buyerId_status_idx" ON "ServiceDeal" ("buyerId", "status");
CREATE INDEX IF NOT EXISTS "ServiceDeal_sellerId_status_idx" ON "ServiceDeal" ("sellerId", "status");
CREATE INDEX IF NOT EXISTS "ServiceDeal_offeringId_status_idx" ON "ServiceDeal" ("offeringId", "status");
-- The sweeps, PARTIAL so each holds only the deals it can still act on. The Prisma schema
-- declares them without the predicates, which it cannot express.
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_requestedAt_idx" ON "ServiceDeal" ("status", "requestedAt")
  WHERE "status" = 'Requested';
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_deliveredAt_idx" ON "ServiceDeal" ("status", "deliveredAt")
  WHERE "status" = 'Delivered';
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_cancellationRequestedAt_idx" ON "ServiceDeal" ("status", "cancellationRequestedAt")
  WHERE "status" = 'CancellationRequested';
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_dueAt_idx" ON "ServiceDeal" ("status", "dueAt")
  WHERE "status" IN ('Accepted', 'InRevision');
-- Completed stays Completed after payout, so without "settledAt" this would grow with every
-- deal ever completed.
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_releaseAt_idx" ON "ServiceDeal" ("status", "releaseAt")
  WHERE "status" = 'Completed' AND "settledAt" IS NULL;
-- A closed deal that was never held has nothing to refund and never settles, so it is left out.
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_closedAt_idx" ON "ServiceDeal" ("status", "closedAt")
  WHERE "status" IN ('Declined', 'Expired', 'Cancelled') AND "heldAt" IS NOT NULL AND "settledAt" IS NULL;

CREATE TABLE IF NOT EXISTS "ServiceDealEvent" (
  "id"        SERIAL PRIMARY KEY,
  "dealId"    INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId"   INTEGER NOT NULL,
  "type"      "ServiceDealEventType" NOT NULL,
  "round"     INTEGER NOT NULL DEFAULT 0,
  "comment"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ServiceDealEvent_dealId_createdAt_id_idx" ON "ServiceDealEvent" ("dealId", "createdAt", "id");

CREATE TABLE IF NOT EXISTS "ServiceDealFile" (
  "id"             SERIAL PRIMARY KEY,
  "dealId"         INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "round"          INTEGER NOT NULL DEFAULT 0,
  "kind"           "ServiceDealFileKind" NOT NULL,
  "s3Key"          TEXT NOT NULL,
  "watermarkedKey" TEXT,
  "imageId"        INTEGER,
  "mimeType"       TEXT NOT NULL,
  "size"           INTEGER NOT NULL,
  "scanStatus"     "ServiceDealFileScanStatus" NOT NULL DEFAULT 'Pending',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ServiceDealFile_dealId_round_kind_idx" ON "ServiceDealFile" ("dealId", "round", "kind");

CREATE TABLE IF NOT EXISTS "ServiceDealTransaction" (
  "id"                    SERIAL PRIMARY KEY,
  "dealId"                INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "leg"                   "ServiceDealLeg" NOT NULL,
  "externalTransactionId" TEXT NOT NULL,
  "transactionId"         TEXT,
  "amount"                INTEGER NOT NULL CHECK ("amount" > 0),
  "buzzType"              "ServiceBuzzType" NOT NULL,
  "attempts"              INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"         TIMESTAMP(3),
  "lastError"             TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Every leg moves the deal's own Buzz type. Not in the Prisma schema.
  CONSTRAINT "ServiceDealTransaction_deal_buzzType_fkey" FOREIGN KEY ("dealId", "buzzType")
    REFERENCES "ServiceDeal"("id", "buzzType") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_externalTransactionId_key"
  ON "ServiceDealTransaction" ("externalTransactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_dealId_leg_key"
  ON "ServiceDealTransaction" ("dealId", "leg");
-- The recovery sweep's claimed-but-unpaid legs. Rows leave it as they are paid.
CREATE INDEX IF NOT EXISTS "ServiceDealTransaction_createdAt_idx"
  ON "ServiceDealTransaction" ("createdAt")
  WHERE "transactionId" IS NULL;

-- A refund excludes both halves of a payout: whichever side is claimed first holds the
-- slot, and the other side's insert fails. Release and Fee may coexist. Not in the Prisma
-- schema, which cannot express a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_dealId_payout_key"
  ON "ServiceDealTransaction" ("dealId")
  WHERE "leg" IN ('Release', 'Refund');
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_dealId_fee_refund_key"
  ON "ServiceDealTransaction" ("dealId")
  WHERE "leg" IN ('Fee', 'Refund');

RESET lock_timeout;
