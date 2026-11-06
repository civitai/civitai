import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalHoldUserIdsSql } from '~/server/utils/legal-hold';

/**
 * `EvidenceHoldComment` and its copy from the `archive` schema, run against the real migrations on
 * a Postgres stand-in. The comment table's "held" is a marker or a report that still holds; its
 * report half is a SQL copy of `legalHoldUserIdsSql`, pinned to it here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const HOLD_MIGRATION = path.join(MIGRATIONS, '20261019220000_evidence_hold/migration.sql');
const COMMENT_MIGRATION = path.join(
  MIGRATIONS,
  '20261226120000_evidence_hold_comment/migration.sql'
);

const PENDING = 101; // report not yet sent
const UNARCHIVED = 102; // report sent 400 days ago, never archived
const SENT_364 = 103; // sent and archived 364 days ago
const SENT_366 = 104; // sent and archived 366 days ago: the year is up
const SECONDARY = 105; // only ever the secondary user, on a report sent 10 days ago
const SUBJECT = 106; // the subject of that report
const SECONDARY_366 = 107; // secondary user on a report sent and archived 366 days ago
const MARKER = 108; // manual hold marker, no report
const NOBODY = 109; // no report, no marker
const ALL = [
  PENDING,
  UNARCHIVED,
  SENT_364,
  SENT_366,
  SECONDARY,
  SUBJECT,
  SECONDARY_366,
  MARKER,
  NOBODY,
];
const HELD = [PENDING, UNARCHIVED, SENT_364, SECONDARY, SUBJECT, MARKER];
const REPORT_HELD = HELD.filter((id) => id !== MARKER);

// The tables the hold migration's triggers attach to, as far as it needs them.
const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL DEFAULT 'u', "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
    "blockedFor" text, metadata jsonb, "updatedAt" timestamp(3), "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, title text, detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), "publishedAt" timestamp(3),
    "modelVersionId" int, "collectionId" int, metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE SCHEMA archive;
  CREATE TABLE archive."Thread" (id int, "postId" int, "imageId" int, "parentThreadId" int);
  CREATE TABLE archive."CommentV2" (
    id int, content text, "createdAt" timestamp(3), "updatedAt" timestamp(3), nsfw boolean,
    "tosViolation" boolean, "userId" int, "threadId" int, metadata jsonb, hidden boolean,
    "pinnedAt" timestamp(3), "reactionCount" int
  );
`;

let db: PGlite;

const count = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0].n);
const keptUsers = async () =>
  (
    await db.query<{ userId: number }>(
      `SELECT DISTINCT "userId" FROM "EvidenceHoldComment" ORDER BY "userId"`
    )
  ).rows.map((r) => r.userId);
const keep = async () =>
  (await db.query<{ n: number }>(`SELECT evidence_hold_keep_archived_comments() AS n`)).rows[0].n;
const reset = () =>
  db.exec(`
    SET session_replication_role = replica;
    TRUNCATE "EvidenceHoldComment", "EvidenceHold", "CsamReport";
    SET session_replication_role = DEFAULT;
  `);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  await db.exec(readFileSync(COMMENT_MIGRATION, 'utf8'));
  // Off, so the report fixtures write no markers and the report half is what is exercised.
  await db.exec(`ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold"`);
  // Two archived comments per user, on one archived thread.
  await db.exec(`INSERT INTO archive."Thread" (id, "postId") VALUES (1, 900)`);
  await db.exec(
    `INSERT INTO archive."CommentV2" (id, content, "userId", "threadId") VALUES ${ALL.flatMap(
      (u) => [`(${u * 10}, 'c', ${u}, 1)`, `(${u * 10 + 1}, 'c', ${u}, 1)`]
    ).join(', ')}`
  );
});

afterAll(() => db?.close());

beforeEach(async () => {
  await reset();
  await db.exec(`
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${PENDING}, NULL, NULL, '{}'),
      (${UNARCHIVED}, now() - interval '400 days', NULL, '{}'),
      (${SENT_364}, now() - interval '364 days', now() - interval '364 days', '{}'),
      (${SENT_366}, now() - interval '366 days', now() - interval '366 days', '{}'),
      (${SUBJECT}, now() - interval '10 days', now() - interval '10 days', '{"secondaryUserId": "${SECONDARY}"}'),
      (NULL, now() - interval '366 days', now() - interval '366 days', '{"secondaryUserId": "${SECONDARY_366}"}');
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKER}, 'manual', 'r');
  `);
});

describe('held, for the comment table', () => {
  it('matches legalHoldUserIdsSql on every report case', async () => {
    const ts = (
      await db.query<{ userId: string }>(legalHoldUserIdsSql.text, legalHoldUserIdsSql.values)
    ).rows.map((r) => Number(r.userId));
    const { rows } = await db.query<{ id: number; held: boolean }>(
      `SELECT id, evidence_hold_report_names(id) AS held FROM unnest($1::int[]) id ORDER BY id`,
      [ALL]
    );
    const sqlHeld = rows.filter((r) => r.held).map((r) => r.id);

    // Both sides against the expected set, so a change to one is not matched by a change to the other.
    expect([...ts].sort((a, b) => a - b)).toEqual(REPORT_HELD);
    expect(sqlHeld).toEqual(REPORT_HELD);
  });

  it('adds the marker owners', async () => {
    const { rows } = await db.query<{ id: number; held: boolean }>(
      `SELECT id, evidence_hold_comment_owner_held(id) AS held FROM unnest($1::int[]) id ORDER BY id`,
      [ALL]
    );
    expect(rows.filter((r) => r.held).map((r) => r.id)).toEqual(HELD);
  });
});

describe('evidence_hold_keep_archived_comments', () => {
  it('keeps the held owners archived comments, once', async () => {
    expect(await keep()).toBe(HELD.length * 2);
    expect(await keptUsers()).toEqual(HELD);
    const thread = await db.query<{ thread: { postId: number } }>(
      `SELECT thread FROM "EvidenceHoldComment" WHERE "commentId" = ${MARKER * 10}`
    );
    expect(thread.rows[0].thread.postId).toBe(900);

    expect(await keep()).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "EvidenceHoldComment"`)).toBe(HELD.length * 2);
  });
});

describe('a kept comment', () => {
  beforeEach(keep);

  it('cannot change', async () => {
    await expect(
      db.exec(`UPDATE "EvidenceHoldComment" SET content = 'x' WHERE "userId" = ${PENDING}`)
    ).rejects.toThrow(/cannot change/);
  });

  it('cannot be deleted while its owner is held by a report alone', async () => {
    await expect(
      db.exec(`DELETE FROM "EvidenceHoldComment" WHERE "userId" = ${PENDING}`)
    ).rejects.toThrow(/cannot be deleted while its owner is held/);
  });

  it('cannot be truncated', async () => {
    await expect(db.exec(`TRUNCATE "EvidenceHoldComment"`)).rejects.toThrow(/cannot be truncated/);
  });
});

describe('evidence_hold_purge_unheld', () => {
  beforeEach(keep);

  it('keeps report-only and marker owners, and purges an owner whose year is up', async () => {
    await db.exec(`
      UPDATE "CsamReport" SET "reportSentAt" = now() - interval '366 days',
        "archivedAt" = now() - interval '366 days'
      WHERE "userId" = ${SENT_364}
    `);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);

    expect(await keptUsers()).toEqual(HELD.filter((id) => id !== SENT_364));
  });

  it('purges a marker owner on release, and nobody else', async () => {
    await db.exec(`
      UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r'
      WHERE "userId" = ${MARKER}
    `);

    expect(await keptUsers()).toEqual(HELD.filter((id) => id !== MARKER));
  });
});
