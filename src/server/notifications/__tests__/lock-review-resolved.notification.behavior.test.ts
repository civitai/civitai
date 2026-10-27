import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { reportNotifications } from '~/server/notifications/report.notifications';
import { LOCK_REVIEW_REPORT_REASON } from '~/shared/constants/lock-review.constants';

/** Who is told a lock review request was resolved, run against a real Postgres. Ids are invented. */

type Def = (typeof reportNotifications)['report-actioned'];
const defs = reportNotifications as Record<string, Def>;

const OWNER = 40;
const OTHER = 41;
const BANNED_OWNER = 42;
const MODEL = 700;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  const lockReview = JSON.stringify({
    reason: LOCK_REVIEW_REPORT_REASON,
    lockedProperties: ['nsfw'],
  });
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "Report" (
      id int PRIMARY KEY, "userId" int, "alsoReportedBy" int[] DEFAULT '{}', reason text,
      status text, "statusSetAt" timestamp, details jsonb DEFAULT '{}', "createdAt" timestamp DEFAULT now()
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
    CREATE TABLE "ResourceReviewReport" ("reportId" int);
    CREATE TABLE "ModelReport" ("modelId" int, "reportId" int);
    CREATE TABLE "CommentReport" ("reportId" int);
    CREATE TABLE "CommentV2Report" ("reportId" int);
    CREATE TABLE "CommentV3Report" ("reportId" int);
    CREATE TABLE "ArticleReport" ("reportId" int);
    CREATE TABLE "PostReport" ("reportId" int);
    CREATE TABLE "CollectionReport" ("reportId" int);
    INSERT INTO "User" VALUES (${OWNER}, NULL, NULL), (${OTHER}, NULL, NULL), (${BANNED_OWNER}, now(), NULL);
    INSERT INTO "Report" (id, "userId", "alsoReportedBy", reason, status, "statusSetAt", details) VALUES
      (1, ${OWNER}, '{}', 'AdminAttention', 'Actioned', now(), '${lockReview}'),
      (2, ${OWNER}, '{}', 'AdminAttention', 'Unactioned', now(), '${lockReview}'),
      (3, ${OWNER}, '{}', 'AdminAttention', 'Pending', NULL, '${lockReview}'),
      (4, ${BANNED_OWNER}, '{}', 'AdminAttention', 'Actioned', now(), '${lockReview}'),
      (5, ${OTHER}, '{}', 'AdminAttention', 'Actioned', now(), '{"reason":"Other concern"}');
    INSERT INTO "ModelReport" VALUES (${MODEL}, 1), (${MODEL}, 2), (${MODEL}, 3), (${MODEL}, 4), (${MODEL}, 5);
  `);
});

const notified = async (type: string) => {
  const sql = await defs[type].prepareQuery!({ lastSent: '2000-01-01T00:00:00Z' } as never);
  const { rows } = await pg.query<{ userId: number; key: string }>(sql as string);
  return rows.map((row) => `${row.userId}:${row.key}`).sort();
};

describe('lock-review-resolved', () => {
  it('tells the owner once a moderator closes their request, whichever way', async () => {
    expect(await notified('lock-review-resolved')).toEqual([
      `${OWNER}:lock-review-resolved:1`,
      `${OWNER}:lock-review-resolved:2`,
    ]);
  });

  it('links to the model and says nothing about the outcome', () => {
    const { message, url } = defs['lock-review-resolved'].prepareMessage({
      details: { reportId: 1, modelId: MODEL },
    } as never) as { message: string; url: string };
    expect(url).toBe(`/models/${MODEL}`);
    expect(message).toMatch(/^A moderator reviewed your request/);
  });

  it('is not also sent as a thank-you for reporting', async () => {
    expect(await notified('report-actioned')).toEqual([`${OTHER}:report-actioned:5`]);
  });
});
