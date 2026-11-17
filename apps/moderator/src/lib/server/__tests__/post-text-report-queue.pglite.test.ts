import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';

/**
 * A storyline text's report (`PostTextReport`) is worked in the post queue: listed and counted with
 * the post's own reports, under the post, and shown with the text as it is now, refused or not.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../redis', () => ({
  getRedis: () => ({ sAdd: vi.fn(), sRem: vi.fn(), del: vi.fn(), set: vi.fn(), get: vi.fn() }),
}));

const { getReports, getReportCounts, getReportStatusCounts } = await import('../reports.service');
const { getReportedPostTexts } = await import('../post-text-reports.service');

const OWNER = 10;
const REPORTER = 99;
const POST = 5;
const OTHER_POST = 6;

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "email" TEXT);
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
${REPORT_ENTITIES.filter((e) => e.reportTable !== 'PostTextReport')
  .map(
    (e) =>
      `CREATE TABLE IF NOT EXISTS "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER);`
  )
  .join('\n')}
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "index" INTEGER);
CREATE TABLE "PostText" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
  "index" INTEGER NOT NULL, "content" TEXT NOT NULL,
  "refused" BOOLEAN NOT NULL DEFAULT false, "refusedByModerator" BOOLEAN NOT NULL DEFAULT false,
  "refusedByScan" BOOLEAN NOT NULL DEFAULT false, "csamHeld" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL
);
CREATE TABLE "PostTextReport" (
  "reportId" INTEGER PRIMARY KEY,
  "postTextId" INTEGER REFERENCES "PostText" ("id") ON DELETE SET NULL,
  "postId" INTEGER NOT NULL
);
INSERT INTO "User" VALUES (${REPORTER}, 'reporter', null), (${OWNER}, 'owner', null);
-- Post ${POST}: image (index 0), text 71 (index 0, after the image), image (index 1), text 72 (index 1).
INSERT INTO "Image" VALUES (1, ${POST}, 0), (2, ${POST}, 1);
INSERT INTO "PostText" ("id", "postId", "userId", "index", "content", "refused", "refusedByModerator")
  VALUES (71, ${POST}, ${OWNER}, 0, '<p>First <b>words</b>.</p>', false, false),
         (72, ${POST}, ${OWNER}, 1, '<p>Refused words.</p>', true, true);
INSERT INTO "Report" ("id", "reason", "userId", "details") VALUES
  (100, 'TOSViolation', ${REPORTER}, null),
  (200, 'TOSViolation', ${REPORTER}, '{"postText": {"content": "<p>Words <i>before</i> the edit.</p>"}}'),
  (300, 'Spam', ${REPORTER}, null), (400, 'TOSViolation', ${REPORTER}, null);
-- 100 is about the post itself; 200 and 300 about its texts; 400 about another post.
INSERT INTO "PostReport" ("reportId", "postId") VALUES (100, ${POST}), (400, ${OTHER_POST});
INSERT INTO "PostTextReport" ("reportId", "postTextId", "postId") VALUES (200, 71, ${POST}), (300, 72, ${POST});
`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('the post queue', () => {
  it("lists a text's report beside the post's own, under the post", async () => {
    const { items, totalItems } = await getReports({
      type: 'post',
      statuses: ['Pending'] as never,
      reasons: 'all',
    });
    expect(items.map((r) => [r.id, r.entityId])).toEqual([
      [400, OTHER_POST],
      [300, POST],
      [200, POST],
      [100, POST],
    ]);
    expect(totalItems).toBe(4);
  });

  it("lists a text's report among the open post's reports", async () => {
    const { items } = await getReports({
      type: 'post',
      entityId: POST,
      statuses: ['Pending'] as never,
      reasons: 'all',
    });
    expect(items.map((r) => r.id)).toEqual([300, 200, 100]);
  });

  it("counts a text's report in the post queue's badge and tabs, and has no queue of its own", async () => {
    const counts = await getReportCounts();
    expect(counts['report:post']).toBe(4);
    expect(counts).not.toHaveProperty('report:postText');
    expect(await getReportStatusCounts({ type: 'post', reasons: 'all' })).toEqual({ Pending: 4 });
  });

  it('keeps the report listed once its text is deleted', async () => {
    await db.exec(`DELETE FROM "PostText" WHERE id = 71`);
    const { items } = await getReports({
      type: 'post',
      entityId: POST,
      statuses: ['Pending'] as never,
      reasons: 'all',
    });
    expect(items.map((r) => r.id)).toContain(200);
  });
});

describe('getReportedPostTexts', () => {
  it('shows each reported text as plain words with its slide, refused ones included', async () => {
    const texts = await getReportedPostTexts([100, 200, 300]);
    expect(texts.has(100)).toBe(false);
    expect(texts.get(200)).toEqual({
      textId: 71,
      position: 2,
      slideCount: 4,
      text: 'First words.',
      reportedText: 'Words before the edit.',
      refused: false,
      refusedByModerator: false,
      refusedByScan: false,
      held: false,
    });
    expect(texts.get(300)).toMatchObject({
      textId: 72,
      reportedText: null,
      position: 4,
      text: 'Refused words.',
      refused: true,
      refusedByModerator: true,
    });
  });

  it('marks a text held for csam review', async () => {
    await db.exec(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('PostText', 71, 'csam', 'Pending')`
    );
    expect((await getReportedPostTexts([200])).get(200)?.held).toBe(true);
  });

  it('lists a deleted text with nothing to show', async () => {
    await db.exec(`DELETE FROM "PostText" WHERE id = 71`);
    expect((await getReportedPostTexts([200])).get(200)).toMatchObject({
      textId: null,
      text: null,
      reportedText: 'Words before the edit.',
      position: null,
    });
  });
});
