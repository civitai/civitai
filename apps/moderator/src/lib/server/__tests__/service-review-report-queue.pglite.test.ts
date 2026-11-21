import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';

/**
 * A buyer review's report (`ServiceDealReviewReport`) is worked in the service-offering queue:
 * listed and counted with the offering's own reports, under the offering, and shown with the review
 * as it is now, hidden or not, with its images.
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

const { getReports, getReportCounts } = await import('../reports.service');
const { getReportedServiceReviews } = await import('../service-review-reports.service');

const SELLER = 990000010;
const REPORTER = 990000099;
const OFFERING = 990000005;
const OTHER_OFFERING = 990000006;
const REVIEW = 990000071;
const OFFERING_REPORT = 990000100;
const REVIEW_REPORT = 990000200;
const OTHER_REPORT = 990000400;

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
${REPORT_ENTITIES.filter((e) => e.reportTable !== 'ServiceDealReviewReport')
  .map(
    (e) =>
      `CREATE TABLE IF NOT EXISTS "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER);`
  )
  .join('\n')}
CREATE TABLE "ServiceOffering" ("id" INTEGER PRIMARY KEY, "sellerId" INTEGER NOT NULL);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL);
CREATE TABLE "ServiceDealReview" (
  "id" INTEGER PRIMARY KEY, "dealId" INTEGER NOT NULL, "verdict" TEXT NOT NULL,
  "comment" TEXT, "sellerReply" TEXT, "publishedAt" TIMESTAMP(3), "hiddenAt" TIMESTAMP(3)
);
CREATE TABLE "ServiceDealReviewImage" ("reviewId" INTEGER NOT NULL, "imageId" INTEGER NOT NULL);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL
);
CREATE TABLE "ServiceDealReviewReport" (
  "reportId" INTEGER PRIMARY KEY, "serviceDealReviewId" INTEGER NOT NULL, "serviceOfferingId" INTEGER NOT NULL
);
INSERT INTO "User" VALUES (${REPORTER}, 'reporter', null), (${SELLER}, 'seller', null);
INSERT INTO "ServiceOffering" VALUES (${OFFERING}, ${SELLER}), (${OTHER_OFFERING}, ${SELLER});
INSERT INTO "ServiceDealReview" VALUES
  (${REVIEW}, 990000031, 'Unhappy', 'Comment now', 'Reply now', now(), null);
INSERT INTO "Image" VALUES (990000001, 'key-b'), (990000002, 'key-a');
INSERT INTO "ServiceDealReviewImage" VALUES (${REVIEW}, 990000002), (${REVIEW}, 990000001);
INSERT INTO "Report" ("id", "reason", "userId", "details") VALUES
  (${OFFERING_REPORT}, 'TOSViolation', ${REPORTER}, null),
  (${REVIEW_REPORT}, 'TOSViolation', ${REPORTER},
    '{"serviceDealReview": {"comment": "Comment before the edit", "sellerReply": "Reply now"}}'),
  (${OTHER_REPORT}, 'TOSViolation', ${REPORTER}, null);
INSERT INTO "ServiceOfferingReport" ("reportId", "serviceOfferingId") VALUES
  (${OFFERING_REPORT}, ${OFFERING}), (${OTHER_REPORT}, ${OTHER_OFFERING});
INSERT INTO "ServiceDealReviewReport" VALUES (${REVIEW_REPORT}, ${REVIEW}, ${OFFERING});
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

describe('the service-offering queue', () => {
  it("lists a review's report beside the offering's own, under the offering", async () => {
    const { items, totalItems } = await getReports({
      type: 'serviceOffering',
      statuses: ['Pending'] as never,
      reasons: 'all',
    });
    expect(items.map((r) => [r.id, r.entityId])).toEqual([
      [OTHER_REPORT, OTHER_OFFERING],
      [REVIEW_REPORT, OFFERING],
      [OFFERING_REPORT, OFFERING],
    ]);
    expect(totalItems).toBe(3);
  });

  it("counts a review's report in the offering queue's badge, and has no queue of its own", async () => {
    const counts = await getReportCounts();
    expect(counts['report:serviceOffering']).toBe(3);
    expect(counts).not.toHaveProperty('report:serviceDealReview');
  });
});

describe('getReportedServiceReviews', () => {
  it('shows the review as it is now and as reported, with its images', async () => {
    const reviews = await getReportedServiceReviews([OFFERING_REPORT, REVIEW_REPORT]);
    expect(reviews.has(OFFERING_REPORT)).toBe(false);
    expect(reviews.get(REVIEW_REPORT)).toEqual({
      reviewId: REVIEW,
      dealId: 990000031,
      verdict: 'Unhappy',
      comment: 'Comment now',
      sellerReply: 'Reply now',
      reportedComment: 'Comment before the edit',
      reportedReply: 'Reply now',
      shown: true,
      hidden: false,
      commentHeld: false,
      replyHeld: false,
      images: [
        { id: 990000001, url: 'key-b' },
        { id: 990000002, url: 'key-a' },
      ],
    });
  });

  it('marks a hidden review, and a text held for csam review', async () => {
    await db.exec(`
      UPDATE "ServiceDealReview" SET "hiddenAt" = now(), "publishedAt" = null;
      INSERT INTO "TextScanHold" ("entityType", "entityId", label, status)
        VALUES ('ServiceDealReviewReply', ${REVIEW}, 'csam', 'Pending');
    `);
    expect((await getReportedServiceReviews([REVIEW_REPORT])).get(REVIEW_REPORT)).toMatchObject({
      shown: false,
      hidden: true,
      commentHeld: false,
      replyHeld: true,
    });
  });
});
