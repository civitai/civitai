ALTER TABLE "Bid"
  ADD COLUMN "transactionId" text,
  ADD COLUMN "fromRecurring" boolean not null default false;

UPDATE "Bid" SET "transactionId" = 'unk' where "transactionId" is null;
ALTER TABLE "Bid" ALTER COLUMN "transactionId" SET NOT NULL;

ALTER TABLE "BidRecurring" ADD COLUMN "isPaused" boolean not null default false;

ALTER TABLE "Bid" ADD COLUMN "isRefunded" boolean not null default false;
