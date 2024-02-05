-- CreateEnum
CREATE TYPE "BuzzWithdrawalRequestStatus" AS ENUM ('Requested', 'Canceled', 'Rejected', 'Approved', 'Reverted', 'Transferred');
-- CreateTable

CREATE TABLE "BuzzWithdrawalRequestHistory" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "updatedById" INTEGER NOT NULL,
    "status" "BuzzWithdrawalRequestStatus" NOT NULL DEFAULT 'Requested',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "BuzzWithdrawalRequestHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuzzWithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER,
    "connectedAccountId" TEXT NOT NULL,
    "buzzWithdrawalTransactionId" TEXT NOT NULL,
    "requestedBuzzAmount" INTEGER NOT NULL,
    "platformFeeRate" INTEGER NOT NULL,
    "transferredAmount" INTEGER,
    "transferId" TEXT,
    "currency" "Currency",
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BuzzWithdrawalRequestStatus" NOT NULL DEFAULT 'Requested',

    CONSTRAINT "BuzzWithdrawalRequest_pkey" PRIMARY KEY ("id")
);
 
-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequestHistory" ADD CONSTRAINT "BuzzWithdrawalRequestHistory_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuzzWithdrawalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequestHistory" ADD CONSTRAINT "BuzzWithdrawalRequestHistory_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequest" ADD CONSTRAINT "BuzzWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add trigger to automatically create a history record when a request is created
CREATE OR REPLACE FUNCTION create_buzz_withdrawal_request_history_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Update status to be the latest
    INSERT INTO "BuzzWithdrawalRequestHistory" ("id", "requestId", "updatedById", "status", "createdAt", "metadata")
    -- NOTE: cuid is something out of Postgres so it does not work here. Because of that, the we'll use the origina requestId as the id of the history record
    	VALUES (NEW."id", NEW."id", NEW."userId", NEW."status", NEW."createdAt", NEW."metadata");
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_create_buzz_withdrawal_request_history_on_insert
AFTER INSERT ON "BuzzWithdrawalRequest"
FOR EACH ROW
EXECUTE PROCEDURE create_buzz_withdrawal_request_history_on_insert();


--- 
CREATE OR REPLACE FUNCTION update_buzz_withdrawal_request_status()
RETURNS TRIGGER AS $$
BEGIN
    -- Update status to be the latest
    UPDATE "BuzzWithdrawalRequest" SET "status" = NEW."status", "updatedAt" = now() WHERE "id" = NEW."requestId";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_update_buzz_withdrawal_request_status
AFTER INSERT ON "BuzzWithdrawalRequestHistory"
FOR EACH ROW
EXECUTE FUNCTION update_buzz_withdrawal_request_status();