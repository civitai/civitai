import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';

/**
 * A storyline report once the storyline is deleted (the main app's `deleteStoryline`): the link row
 * stays with "storylineId" NULL and the title and held copy stamped on it. The queue must still
 * list it, count it and let a moderator resolve it, and the page shows the copy.
 */

const { dbHandle, recordModActivity, rewardReportReporters } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  recordModActivity: vi.fn(),
  rewardReportReporters: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../rewards', () => ({ rewardReportReporters }));
vi.mock('../redis', () => ({
  getRedis: () => ({ sAdd: vi.fn(), sRem: vi.fn(), del: vi.fn(), set: vi.fn(), get: vi.fn() }),
}));

const { getReports, getReportStatusCounts, setReportStatus } = await import('../reports.service');
const { getDeletedReportStorylines } = await import('../storyline-takedown.service');

const OWNER = 10;
const REPORTER = 99;
const MOD = 7;

// Only the columns the queries read. Every other report type gets an empty link table, so the
// queries that fan out over all of them run.
const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
ALTER TABLE "User" ADD COLUMN "email" TEXT;
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "statusSetAt" TIMESTAMP(3),
  "statusSetBy" INTEGER,
  "userId" INTEGER NOT NULL,
  "details" JSONB,
  "internalNotes" TEXT,
  "alsoReportedBy" INTEGER[],
  "previouslyReviewedCount" INTEGER
);
${REPORT_ENTITIES.filter((e) => e.reportTable !== 'StorylineReport')
  .map(
    (e) =>
      `CREATE TABLE IF NOT EXISTS "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER);`
  )
  .join('\n')}
CREATE TABLE "Storyline" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "title" TEXT NOT NULL);
CREATE TABLE "StorylineReport" (
  "reportId" INTEGER PRIMARY KEY,
  "storylineId" INTEGER REFERENCES "Storyline" ("id") ON DELETE SET NULL,
  "heldStorylineId" INTEGER,
  "storylineTitle" TEXT
);
CREATE TABLE "HeldStoryline" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3) NOT NULL, "deletedById" INTEGER NOT NULL,
  "reportIds" INTEGER[] NOT NULL DEFAULT '{}', "commenterIds" INTEGER[] NOT NULL DEFAULT '{}',
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "holdReasons" TEXT[]
);
CREATE TABLE "HeldStorylineChapter" ("id" INTEGER PRIMARY KEY, "storylineId" INTEGER NOT NULL);
INSERT INTO "User" VALUES (${REPORTER}, 'reporter'), (${OWNER}, 'owner'), (${MOD}, 'mod');
INSERT INTO "Storyline" VALUES (1, ${OWNER}, 'Still here'), (2, ${OWNER}, 'Kept on delete'),
  (3, ${OWNER}, 'Gone for good'), (4, ${OWNER}, 'Taken out');
INSERT INTO "Report" ("id", "reason", "userId") VALUES (100, 'TOSViolation', ${REPORTER}),
  (200, 'TOSViolation', ${REPORTER}), (300, 'TOSViolation', ${REPORTER}),
  (400, 'TOSViolation', ${REPORTER});
INSERT INTO "StorylineReport" ("reportId", "storylineId") VALUES (100, 1), (200, 2), (300, 3), (400, 4);
`;

// What `deleteStoryline` leaves (pinned on the writer's side by storyline-delete.sql.behavior.test.ts
// and the migration): report 200's storyline kept as a copy, report 300's without one, and report
// 400's kept from a moderator's delete.
const DELETE = `
UPDATE "StorylineReport" SET "storylineTitle" = 'Kept on delete', "heldStorylineId" = 2 WHERE "reportId" = 200;
UPDATE "StorylineReport" SET "storylineTitle" = 'Gone for good' WHERE "reportId" = 300;
INSERT INTO "HeldStoryline" ("id", "userId", "title", "createdAt", "deletedAt", "deletedById", "reportIds")
  VALUES (2, ${OWNER}, 'Kept on delete', now(), now(), ${OWNER}, ARRAY[200]);
INSERT INTO "HeldStorylineChapter" VALUES (20, 2), (21, 2);
UPDATE "StorylineReport" SET "storylineTitle" = 'Taken out', "heldStorylineId" = 4 WHERE "reportId" = 400;
INSERT INTO "HeldStoryline" ("id", "userId", "title", "createdAt", "deletedAt", "deletedById")
  VALUES (4, ${OWNER}, 'Taken out', now(), now(), ${MOD});
DELETE FROM "Storyline" WHERE "id" IN (2, 3, 4);
`;

let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const queue = () =>
  getReports({ type: 'storyline', statuses: ['Pending'] as never, reasons: 'all' });

describe('a storyline report after its storyline is deleted', () => {
  it('stays listed, with no entity id, beside a report whose storyline is still there', async () => {
    const before = await queue();
    await db.exec(DELETE);
    const after = await queue();
    expect(before.items.map((r) => r.id).sort()).toEqual([100, 200, 300, 400]);
    expect(after.items.map((r) => [r.id, r.entityId]).sort()).toEqual([
      [100, 1],
      [200, null],
      [300, null],
      [400, null],
    ]);
    expect(after.totalItems).toBe(4);
  });

  it('is still counted in the queue tabs', async () => {
    await db.exec(DELETE);
    expect(await getReportStatusCounts({ type: 'storyline', reasons: 'all' })).toEqual({
      Pending: 4,
    });
  });

  it('can be resolved, Actioned or Unactioned', async () => {
    await db.exec(DELETE);
    expect(await setReportStatus({ id: 200, status: 'Actioned' as never, userId: MOD })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setReportStatus({ id: 300, status: 'Unactioned' as never, userId: MOD })).toEqual({
      ok: true,
      changed: true,
    });
    const { rows } = await db.query(`SELECT id, status FROM "Report" ORDER BY id`);
    expect(rows).toEqual([
      { id: 100, status: 'Pending' },
      { id: 200, status: 'Actioned' },
      { id: 300, status: 'Unactioned' },
      { id: 400, status: 'Pending' },
    ]);
  });

  it('shows the held copy, or only the title when none was kept', async () => {
    await db.exec(DELETE);
    const deleted = await getDeletedReportStorylines([100, 200, 300, 400]);
    expect(deleted.sort((a, b) => a.reportId - b.reportId)).toEqual([
      {
        reportId: 200,
        title: 'Kept on delete',
        held: {
          id: 2,
          userId: OWNER,
          deletedAt: expect.any(Date),
          deletedByOwner: true,
          chapters: 2,
        },
      },
      { reportId: 300, title: 'Gone for good', held: null },
      {
        reportId: 400,
        title: 'Taken out',
        held: {
          id: 4,
          userId: OWNER,
          deletedAt: expect.any(Date),
          deletedByOwner: false,
          chapters: 0,
        },
      },
    ]);
  });
});
