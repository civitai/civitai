-- Minimal schema for hot-reads-7.kysely-parity.test.ts.
--
-- Only the tables the reads behind kysely-hot-reads-7 touch, and only the columns those reads
-- select, filter, join or group on. Types, nullability and primary keys follow schema.full.prisma.
-- Foreign keys are left out so a fixture row can point at a row that is gone (a chapter whose post
-- id names no post). All of these are base TABLES in production too (none is declared as a view),
-- which the suite checks separately. Everything lives in its own schema, hot_reads_7_parity,
-- because other parity suites share the throwaway database.
--
-- No semicolons in comments: the suite splits this file on them.
--
-- Applied against a THROWAWAY database: this drops and recreates the schema on every run.

DROP SCHEMA IF EXISTS "hot_reads_7_parity" CASCADE;
CREATE SCHEMA "hot_reads_7_parity";

CREATE TABLE "hot_reads_7_parity"."StorylineChapter" (
  "id"          INTEGER NOT NULL PRIMARY KEY,
  "storylineId" INTEGER NOT NULL,
  "postId"      INTEGER UNIQUE,
  "userId"      INTEGER NOT NULL,
  "depth"       INTEGER NOT NULL
);

CREATE TABLE "hot_reads_7_parity"."Model" (
  "id"      INTEGER NOT NULL PRIMARY KEY,
  "sfwName" TEXT
);

CREATE TABLE "hot_reads_7_parity"."Post" (
  "id"             INTEGER NOT NULL PRIMARY KEY,
  "modelVersionId" INTEGER
);

CREATE TABLE "hot_reads_7_parity"."ItemDefinition" (
  "id"     INTEGER NOT NULL PRIMARY KEY,
  "type"   TEXT    NOT NULL,
  "status" TEXT    NOT NULL DEFAULT 'draft'
);

CREATE TABLE "hot_reads_7_parity"."Item" (
  "id"               BIGINT  NOT NULL PRIMARY KEY,
  "itemDefinitionId" INTEGER NOT NULL,
  "holderType"       TEXT    NOT NULL,
  "holderId"         INTEGER NOT NULL,
  "quantity"         INTEGER NOT NULL DEFAULT 1
);
