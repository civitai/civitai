-- Minimal schema for hot-reads-8.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-8 touch, and only the columns those reads
-- select, filter, join or order on. Types, nullability, keys and enums follow schema.full.prisma,
-- including the StorylineChapter postId unique key and the partial unique index that allows one
-- depth-0 chapter per storyline. Foreign keys are left out so a fixture row can point at a row that
-- is gone (a first chapter whose post was deleted). All of these are base TABLES in production too
-- (none is declared as a view), which the suite checks separately. Everything lives in its own
-- schema, hot_reads_8_parity, because other parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_8_parity" CASCADE;
CREATE SCHEMA "hot_reads_8_parity";

CREATE TYPE "hot_reads_8_parity"."CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme', 'CardDecoration');
CREATE TYPE "hot_reads_8_parity"."CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "hot_reads_8_parity"."CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');

CREATE TABLE "hot_reads_8_parity"."User" (
  "id"        INTEGER      NOT NULL PRIMARY KEY,
  "bannedAt"  TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "hot_reads_8_parity"."Post" (
  "id"           INTEGER      NOT NULL PRIMARY KEY,
  "userId"       INTEGER      NOT NULL,
  "nsfwLevel"    INTEGER      NOT NULL DEFAULT 0,
  "tosViolation" BOOLEAN      NOT NULL DEFAULT false,
  "publishedAt"  TIMESTAMP(3)
);

CREATE TABLE "hot_reads_8_parity"."Storyline" (
  "id"                 INTEGER      NOT NULL PRIMARY KEY,
  "userId"             INTEGER      NOT NULL,
  "title"              VARCHAR(255) NOT NULL,
  "maxNsfwLevel"       INTEGER      NOT NULL,
  "tosViolation"       BOOLEAN      NOT NULL DEFAULT false,
  "minorByScan"        BOOLEAN      NOT NULL DEFAULT false,
  "nsfwLevel"          INTEGER      NOT NULL DEFAULT 0,
  "moderatorNsfwLevel" INTEGER
);

CREATE TABLE "hot_reads_8_parity"."StorylineChapter" (
  "id"          INTEGER      NOT NULL PRIMARY KEY,
  "storylineId" INTEGER      NOT NULL,
  "postId"      INTEGER      UNIQUE,
  "userId"      INTEGER      NOT NULL,
  "depth"       INTEGER      NOT NULL,
  "removedAt"   TIMESTAMP(3)
);

CREATE UNIQUE INDEX "StorylineChapter_storylineId_root_key" ON "hot_reads_8_parity"."StorylineChapter"("storylineId") WHERE "depth" = 0;

CREATE TABLE "hot_reads_8_parity"."Cosmetic" (
  "id"          INTEGER                                 NOT NULL PRIMARY KEY,
  "name"        TEXT                                    NOT NULL,
  "description" TEXT,
  "type"        "hot_reads_8_parity"."CosmeticType"     NOT NULL,
  "source"      "hot_reads_8_parity"."CosmeticSource"   NOT NULL,
  "data"        JSONB                                   NOT NULL,
  "createdById" INTEGER,
  "flags"       INTEGER                                 NOT NULL DEFAULT 0
);

CREATE TABLE "hot_reads_8_parity"."UserCosmetic" (
  "userId"         INTEGER                               NOT NULL,
  "cosmeticId"     INTEGER                               NOT NULL,
  "obtainedAt"     TIMESTAMP(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equippedAt"     TIMESTAMP(3),
  "data"           JSONB,
  "claimKey"       TEXT                                  NOT NULL DEFAULT 'claimed',
  "equippedToId"   INTEGER,
  "equippedToType" "hot_reads_8_parity"."CosmeticEntity",
  "forId"          INTEGER,
  "forType"        "hot_reads_8_parity"."CosmeticEntity",
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "hot_reads_8_parity"."Model" (
  "id"     INTEGER NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL
);

CREATE TABLE "hot_reads_8_parity"."ModelVersion" (
  "id"      INTEGER NOT NULL PRIMARY KEY,
  "modelId" INTEGER NOT NULL
);
