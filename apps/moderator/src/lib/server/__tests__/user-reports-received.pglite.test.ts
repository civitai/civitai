import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { OWNED_REPORT_ENTITIES } from '../report-entities';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getReportsReceived } = await import('../user-reports.service');

// Only the columns the query reads. The per-type tables come from the same entity list the service
// iterates, so a type added there needs no edit here; the Chat tables are the one hand-written part.
const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "createdAt" TIMESTAMP(3) NOT NULL,
  "statusSetAt" TIMESTAMP(3),
  "statusSetBy" INTEGER,
  "userId" INTEGER NOT NULL,
  "details" JSONB,
  "internalNotes" TEXT,
  "alsoReportedBy" INTEGER[],
  "previouslyReviewedCount" INTEGER
);
CREATE TABLE "Chat" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "ChatMember" ("chatId" INTEGER NOT NULL, "userId" INTEGER NOT NULL);
CREATE TABLE "ChatReport" ("reportId" INTEGER NOT NULL, "chatId" INTEGER NOT NULL);
${OWNED_REPORT_ENTITIES.map(
  (e) => `CREATE TABLE "${e.table}" ("id" INTEGER PRIMARY KEY, "${e.ownerColumn}" INTEGER);
CREATE TABLE "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER NOT NULL);`
).join('\n')}
`;

const AUTHOR = 10;
const OTHER = 20;
const REPORTER = 99;

let db: PGlite;
let nextReport = 1;

async function reportImage(
  owner: number,
  imageId: number,
  daysAgo: number,
  reason = 'TOSViolation'
) {
  const id = nextReport++;
  await db.query(`INSERT INTO "Image" ("id","userId") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
    imageId,
    owner,
  ]);
  await db.query(
    `INSERT INTO "Report" ("id","reason","createdAt","userId") VALUES ($1,$2, now() - make_interval(days => $3::int),$4)`,
    [id, reason, daysAgo, REPORTER]
  );
  await db.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES ($1,$2)`, [id, imageId]);
  return id;
}

async function reportPost(owner: number, postId: number, daysAgo: number) {
  const id = nextReport++;
  await db.query(`INSERT INTO "Post" ("id","userId") VALUES ($1,$2)`, [postId, owner]);
  await db.query(
    `INSERT INTO "Report" ("id","reason","createdAt","userId") VALUES ($1,'Spam', now() - make_interval(days => $2::int),$3)`,
    [id, daysAgo, REPORTER]
  );
  await db.query(`INSERT INTO "PostReport" ("reportId","postId") VALUES ($1,$2)`, [id, postId]);
  return id;
}

beforeEach(async () => {
  nextReport = 1;
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.query(`INSERT INTO "User" ("id","username") VALUES ($1,'reporter')`, [REPORTER]);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('getReportsReceived', () => {
  it('merges the types newest first and keeps only the newest `limit`', async () => {
    const oldest = await reportImage(AUTHOR, 1, 9);
    const post = await reportPost(AUTHOR, 5, 3);
    const middle = await reportImage(AUTHOR, 2, 6);
    const newest = await reportImage(AUTHOR, 3, 1);

    const all = await getReportsReceived(AUTHOR);
    expect(all.map((r) => r.id)).toEqual([newest, post, middle, oldest]);

    const top = await getReportsReceived(AUTHOR, { limit: 2 });
    expect(top.map((r) => r.id)).toEqual([newest, post]);
    expect(top[1]).toMatchObject({
      type: 'post',
      entityType: 'Post',
      entityId: 5,
      reporter: 'reporter',
    });
  });

  it('never returns a report on another account’s content', async () => {
    const mine = await reportImage(AUTHOR, 1, 2);
    await reportImage(OTHER, 2, 1);
    await reportPost(OTHER, 6, 1);

    expect((await getReportsReceived(AUTHOR, { limit: 5 })).map((r) => r.id)).toEqual([mine]);
    expect(await getReportsReceived(30)).toEqual([]);
  });

  it('drops the reasons it was not asked for', async () => {
    const human = await reportImage(AUTHOR, 1, 3, 'TOSViolation');
    await reportImage(AUTHOR, 2, 1, 'Automated');

    const rows = await getReportsReceived(AUTHOR, { reasons: ['TOSViolation'] });
    expect(rows.map((r) => r.id)).toEqual([human]);
  });
});
