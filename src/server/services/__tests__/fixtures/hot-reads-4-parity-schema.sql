-- Minimal schema for hot-reads-4.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-4 touch, and only the columns those reads select,
-- filter, join or order on. Types, nullability and primary keys follow schema.full.prisma, except
-- that the CITEXT columns ("User"."username", "Model"."name") are TEXT here, as in the other parity
-- fixtures, so the throwaway database needs no extension. All of them are base TABLES in production
-- too (none is declared as a view), which the suite checks separately. Everything lives in its own
-- schema, hot_reads_4_parity, because other parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_4_parity" CASCADE;
CREATE SCHEMA "hot_reads_4_parity";

CREATE TYPE "hot_reads_4_parity"."ReviewReactions" AS ENUM ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart');

CREATE TABLE "hot_reads_4_parity"."User" (
  "id"        INTEGER      NOT NULL PRIMARY KEY,
  "username"  TEXT,
  "image"     TEXT,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "hot_reads_4_parity"."Model" (
  "id"     INTEGER NOT NULL PRIMARY KEY,
  "name"   TEXT    NOT NULL,
  "userId" INTEGER NOT NULL REFERENCES "hot_reads_4_parity"."User" ("id")
);

CREATE TABLE "hot_reads_4_parity"."Comment" (
  "id"           INTEGER      NOT NULL PRIMARY KEY,
  "content"      TEXT         NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nsfw"         BOOLEAN      NOT NULL DEFAULT false,
  "tosViolation" BOOLEAN      NOT NULL DEFAULT false,
  "parentId"     INTEGER      REFERENCES "hot_reads_4_parity"."Comment" ("id"),
  "userId"       INTEGER      NOT NULL REFERENCES "hot_reads_4_parity"."User" ("id"),
  "modelId"      INTEGER      NOT NULL REFERENCES "hot_reads_4_parity"."Model" ("id"),
  "locked"       BOOLEAN      DEFAULT false,
  "hidden"       BOOLEAN      DEFAULT false,
  "pinnedAt"     TIMESTAMP(3)
);

CREATE TABLE "hot_reads_4_parity"."CommentReaction" (
  "id"        INTEGER                                  NOT NULL PRIMARY KEY,
  "commentId" INTEGER                                  NOT NULL REFERENCES "hot_reads_4_parity"."Comment" ("id"),
  "userId"    INTEGER                                  NOT NULL REFERENCES "hot_reads_4_parity"."User" ("id"),
  "reaction"  "hot_reads_4_parity"."ReviewReactions"   NOT NULL
);
