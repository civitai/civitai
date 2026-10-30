CREATE TYPE "CollectionItemRejectionReason" AS ENUM (
  'OffTopic', 'WrongFormat', 'Duplicate', 'Quality', 'RulesViolation', 'Other', 'Automated'
);

ALTER TABLE "CollectionItem"
  ADD COLUMN "rejectionReason" "CollectionItemRejectionReason",
  ADD COLUMN "rejectionDetail" TEXT;
