import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { reportNotifications } from '~/server/notifications/report.notifications';

/** Who is told their report was actioned, run against a real Postgres. Ids are invented. */

type Def = (typeof reportNotifications)['report-actioned'];
const def = (reportNotifications as Record<string, Def>)['report-actioned'];

const REPORTER = 30;
const ALSO = 31;
const BANNED = 32;
const DELETED = 33;
const OWNER = 34;
const OTHER_OWNER = 35;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "Report" (
      id int PRIMARY KEY, "userId" int, "alsoReportedBy" int[] DEFAULT '{}', reason text,
      status text, "statusSetAt" timestamp, details jsonb DEFAULT '{}', "createdAt" timestamp DEFAULT now()
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
    CREATE TABLE "ResourceReviewReport" ("reportId" int);
    CREATE TABLE "ModelReport" ("reportId" int);
    CREATE TABLE "CommentReport" ("reportId" int);
    CREATE TABLE "CommentV2Report" ("reportId" int);
    CREATE TABLE "CommentV3Report" ("reportId" int);
    CREATE TABLE "ArticleReport" ("reportId" int);
    CREATE TABLE "PostReport" ("reportId" int);
    CREATE TABLE "CollectionReport" ("reportId" int);
    INSERT INTO "User" VALUES
      (${REPORTER}, NULL, NULL), (${ALSO}, NULL, NULL), (${BANNED}, now(), NULL),
      (${DELETED}, NULL, now()), (${OWNER}, NULL, NULL), (${OTHER_OWNER}, NULL, NULL);
    INSERT INTO "Image" VALUES (500, ${OWNER}), (600, ${OTHER_OWNER});
    INSERT INTO "Report" (id, "userId", "alsoReportedBy", reason, status, "statusSetAt") VALUES
      (7, ${REPORTER}, '{${ALSO},${BANNED},${DELETED},${OWNER}}', 'TOSViolation', 'Actioned', now()),
      (8, ${OWNER}, '{}', 'TOSViolation', 'Actioned', now()),
      (9, ${REPORTER}, '{}', 'TOSViolation', 'Pending', NULL),
      (10, ${OTHER_OWNER}, '{}', 'TOSViolation', 'Actioned', now());
    INSERT INTO "ImageReport" VALUES (500, 7), (500, 8), (600, 9), (500, 10);
  `);
});

const notified = async () => {
  const sql = await def.prepareQuery!({ lastSent: '2000-01-01T00:00:00Z' } as never);
  const { rows } = await pg.query<{ userId: number; key: string }>(sql as string);
  return rows.map((row) => `${row.userId}:${row.key}`).sort();
};

describe('report-actioned', () => {
  it('tells the reporters of an actioned report, but not a banned or deleted one', async () => {
    expect(await notified()).toEqual([
      `${REPORTER}:report-actioned:7`,
      `${ALSO}:report-actioned:7`,
      // Owns a reported image, but this report is about someone else's.
      `${OTHER_OWNER}:report-actioned:10`,
    ]);
  });

  it('never tells an owner that their own reported image was actioned', async () => {
    expect((await notified()).some((entry) => entry.startsWith(`${OWNER}:`))).toBe(false);
  });
});
