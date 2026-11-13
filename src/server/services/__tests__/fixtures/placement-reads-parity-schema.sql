-- Minimal schema for placement-reads.kysely-parity.test.ts.
--
-- Only the tables the placement read family touches, and only the columns those reads select or
-- filter on. Types, nullability and primary keys follow schema.full.prisma. Everything lives in its
-- own schema, placement_parity, because the other parity suites share the throwaway database and
-- one of them creates its own "Image" and "MediaType". "User"."username" is CITEXT in production
-- and TEXT here, so the suite needs no extension. Both paths read it back as a plain string.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against KYSELY_PARITY_DATABASE_URL, which must be a THROWAWAY database: this drops and
-- recreates the schema on every run.

DROP SCHEMA IF EXISTS "placement_parity" CASCADE;
CREATE SCHEMA "placement_parity";

CREATE TYPE "placement_parity"."MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "placement_parity"."StorylineStatus" AS ENUM ('Ongoing', 'Complete');
CREATE TYPE "placement_parity"."PaymentProvider" AS ENUM ('Stripe', 'Paddle', 'Civitai');

CREATE TABLE "placement_parity"."User" (
  "id"       INTEGER NOT NULL PRIMARY KEY,
  "username" TEXT,
  "meta"     JSONB   DEFAULT '{}'
);

CREATE TABLE "placement_parity"."Image" (
  "id"     INTEGER                          NOT NULL PRIMARY KEY,
  "userId" INTEGER                          NOT NULL,
  "postId" INTEGER,
  "type"   "placement_parity"."MediaType"   NOT NULL DEFAULT 'image'
);

CREATE TABLE "placement_parity"."Model" (
  "id"     INTEGER NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL
);

CREATE TABLE "placement_parity"."Storyline" (
  "id"           INTEGER                              NOT NULL PRIMARY KEY,
  "userId"       INTEGER                              NOT NULL,
  "status"       "placement_parity"."StorylineStatus" NOT NULL DEFAULT 'Ongoing',
  "tosViolation" BOOLEAN                              NOT NULL DEFAULT false
);

CREATE TABLE "placement_parity"."StorylineChapter" (
  "id"          INTEGER      NOT NULL PRIMARY KEY,
  "storylineId" INTEGER      NOT NULL REFERENCES "placement_parity"."Storyline"("id"),
  "postId"      INTEGER      UNIQUE,
  "removedAt"   TIMESTAMP(3)
);

CREATE TABLE "placement_parity"."PlacementSpace" (
  "id"         SERIAL       NOT NULL PRIMARY KEY,
  "surface"    TEXT         NOT NULL,
  "entityType" TEXT         NOT NULL,
  "entityId"   INTEGER      NOT NULL,
  "mode"       TEXT         NOT NULL,
  "price"      INTEGER,
  "freeSlots"  INTEGER,
  "settings"   JSONB        NOT NULL DEFAULT '{}',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PlacementSpace_surface_entityType_entityId_key" ON "placement_parity"."PlacementSpace"("surface", "entityType", "entityId");

CREATE TABLE "placement_parity"."Placement" (
  "id"         INTEGER      NOT NULL PRIMARY KEY,
  "surface"    TEXT         NOT NULL,
  "targetType" TEXT         NOT NULL,
  "targetId"   INTEGER      NOT NULL,
  "ownerId"    INTEGER      NOT NULL,
  "placerId"   INTEGER      NOT NULL,
  "data"       JSONB        NOT NULL DEFAULT '{}',
  "status"     TEXT         NOT NULL,
  "amount"     INTEGER      NOT NULL,
  "free"       BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "placement_parity"."Product" (
  "id"          TEXT                                 NOT NULL PRIMARY KEY,
  "active"      BOOLEAN                              NOT NULL,
  "name"        TEXT                                 NOT NULL,
  "description" TEXT,
  "metadata"    JSONB                                NOT NULL,
  "provider"    "placement_parity"."PaymentProvider" NOT NULL DEFAULT 'Stripe'
);

CREATE TABLE "placement_parity"."Price" (
  "id"            TEXT    NOT NULL PRIMARY KEY,
  "productId"     TEXT    NOT NULL REFERENCES "placement_parity"."Product"("id"),
  "active"        BOOLEAN NOT NULL,
  "currency"      TEXT    NOT NULL,
  "unitAmount"    INTEGER,
  "interval"      TEXT,
  "intervalCount" INTEGER
);

CREATE TABLE "placement_parity"."CustomerSubscription" (
  "id"                 TEXT         NOT NULL PRIMARY KEY,
  "userId"             INTEGER      NOT NULL,
  "buzzType"           TEXT         NOT NULL DEFAULT 'yellow',
  "metadata"           JSONB        NOT NULL,
  "status"             TEXT         NOT NULL,
  "priceId"            TEXT         NOT NULL REFERENCES "placement_parity"."Price"("id"),
  "productId"          TEXT         NOT NULL REFERENCES "placement_parity"."Product"("id"),
  "cancelAtPeriodEnd"  BOOLEAN      NOT NULL,
  "cancelAt"           TIMESTAMP(3),
  "canceledAt"         TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd"   TIMESTAMP(3) NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL,
  "endedAt"            TIMESTAMP(3)
);
