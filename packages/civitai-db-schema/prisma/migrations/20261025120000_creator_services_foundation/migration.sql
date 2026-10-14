-- Idempotent: applied by hand, possibly more than once.
--
-- Creator Services foundation: offerings, deals paid through Buzz escrow, the deal's
-- append-only event sheet, delivery files, and one receipt row per Buzz movement.
-- Nothing reads or writes these tables until the dark `creatorServices` flag ships code
-- that does, so this can be applied before or after the deploy that carries the client.

DO $$ BEGIN
  CREATE TYPE "ServiceOfferingStatus" AS ENUM ('Draft', 'Active', 'Paused', 'Removed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServicePreviewKind" AS ENUM ('Image', 'Video', 'SampleOutputs', 'None');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceBuzzType" AS ENUM ('yellow', 'blue');
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
  "price"                     INTEGER NOT NULL CHECK ("price" > 0),
  "buzzType"                  "ServiceBuzzType" NOT NULL,
  "feeAmount"                 INTEGER NOT NULL DEFAULT 0,
  "revisionsIncluded"         INTEGER NOT NULL CHECK ("revisionsIncluded" >= 0),
  "revisionsUsed"             INTEGER NOT NULL DEFAULT 0 CHECK ("revisionsUsed" >= 0),
  "deliveryDays"              INTEGER NOT NULL CHECK ("deliveryDays" > 0),
  "previewKind"               "ServicePreviewKind" NOT NULL,
  "status"                    "ServiceDealStatus" NOT NULL DEFAULT 'Requested',
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
  -- The seller is paid `price - feeAmount`, so the fee can never reach the price.
  CONSTRAINT "ServiceDeal_fee_below_price" CHECK ("feeAmount" >= 0 AND "feeAmount" < "price"),
  CONSTRAINT "ServiceDeal_buyer_not_seller" CHECK ("buyerId" <> "sellerId"),
  -- The release sweeper selects Completed deals by "releaseAt"; a Completed deal
  -- without one would never be paid out.
  CONSTRAINT "ServiceDeal_completed_has_releaseAt" CHECK ("status" <> 'Completed' OR "releaseAt" IS NOT NULL),
  CONSTRAINT "ServiceDeal_dispute_resolution_consistent" CHECK (("disputeResolvedAt" IS NULL) = ("disputeResolution" IS NULL))
);

CREATE INDEX IF NOT EXISTS "ServiceDeal_buyerId_status_idx" ON "ServiceDeal" ("buyerId", "status");
CREATE INDEX IF NOT EXISTS "ServiceDeal_sellerId_status_idx" ON "ServiceDeal" ("sellerId", "status");
CREATE INDEX IF NOT EXISTS "ServiceDeal_offeringId_status_idx" ON "ServiceDeal" ("offeringId", "status");
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_requestedAt_idx" ON "ServiceDeal" ("status", "requestedAt");
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_deliveredAt_idx" ON "ServiceDeal" ("status", "deliveredAt");
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_cancellationRequestedAt_idx" ON "ServiceDeal" ("status", "cancellationRequestedAt");
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_dueAt_idx" ON "ServiceDeal" ("status", "dueAt");
CREATE INDEX IF NOT EXISTS "ServiceDeal_status_releaseAt_idx" ON "ServiceDeal" ("status", "releaseAt");

CREATE TABLE IF NOT EXISTS "ServiceDealEvent" (
  "id"        SERIAL PRIMARY KEY,
  "dealId"    INTEGER NOT NULL REFERENCES "ServiceDeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId"   INTEGER NOT NULL,
  "type"      "ServiceDealEventType" NOT NULL,
  "round"     INTEGER NOT NULL DEFAULT 0,
  "comment"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ServiceDealEvent_dealId_createdAt_idx" ON "ServiceDealEvent" ("dealId", "createdAt");

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
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_externalTransactionId_key"
  ON "ServiceDealTransaction" ("externalTransactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_dealId_leg_key"
  ON "ServiceDealTransaction" ("dealId", "leg");
CREATE INDEX IF NOT EXISTS "ServiceDealTransaction_leg_createdAt_idx"
  ON "ServiceDealTransaction" ("leg", "createdAt");

-- Release and Refund are mutually exclusive per deal: whichever leg is claimed first
-- holds this slot, and the other's insert fails. Not in the Prisma schema, which cannot
-- express a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealTransaction_dealId_payout_key"
  ON "ServiceDealTransaction" ("dealId")
  WHERE "leg" IN ('Release', 'Refund');
