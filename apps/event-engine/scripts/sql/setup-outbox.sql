-- Create enums
CREATE TYPE "OutboxEvent" AS ENUM (
  'PUBLISHED',
  'UNPUBLISHED',
  'DELETED',
  'UPDATED'
);

CREATE TYPE "OutboxEntity" AS ENUM (
  'Article',
  'Image',
  'Model',
  'Post',
  'ModelVersion',
);

-- Create table
CREATE TABLE "Outbox" (
    id BIGSERIAL PRIMARY KEY,
    event "OutboxEvent" NOT NULL,
    "entityType" "OutboxEntity" NOT NULL,
    "entityId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) default CURRENT_TIMESTAMP
);