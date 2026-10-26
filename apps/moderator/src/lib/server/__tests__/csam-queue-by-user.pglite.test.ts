import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// PGlite boots a WASM Postgres; under a full parallel run that alone can pass the default hook budget.
vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getCsamQueueByUser, getImageReviewQueue } = await import('../image-review.service');

const SCHEMA = `
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "image" TEXT, "bannedAt" TIMESTAMP(3), "meta" JSONB);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "title" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'u',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 4,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "mimeType" TEXT,
  "needsReview" TEXT,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "blockedFor" TEXT,
  "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "postId" INTEGER,
  "userId" INTEGER NOT NULL
);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT, "nsfwLevel" INTEGER, "type" TEXT);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "reportSentAt" TIMESTAMP(3), "details" JSONB,
  "images" JSONB NOT NULL DEFAULT '[]'
);
`;

// Every level, Blocked included, so the browsing-level filter is not what decides a row.
const ALL_LEVELS = 63;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  // 101: three flagged (one removed), reported twice, newest sent 2026-02-01, banned for a reason
  // that holds, and its removed image listed on a report.
  // 102: one flagged, report filed but never sent. 103: one flagged, no report.
  // 104: flagged in another queue only. 105: CSAM flag on an errored image only.
  await db.exec(`
    INSERT INTO "User" ("id", "username") VALUES
      (101, 'a'), (102, 'b'), (103, 'c'), (104, 'd'), (105, 'e'), (106, 'f');
    UPDATE "User" SET "bannedAt" = '2026-01-01',
      "meta" = '{"banDetails": {"reasonCode": "SexualMinor"}}' WHERE id = 101;
    INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion", "nsfwLevel") VALUES
      (1, 101, 'csam', 'Scanned', 4),
      (2, 101, 'csam', 'Blocked', 32),
      (3, 101, 'csam', 'Scanned', 4),
      (4, 102, 'csam', 'Scanned', 4),
      (5, 103, 'csam', 'Blocked', 32),
      (6, 104, 'minor', 'Scanned', 4),
      (7, 105, 'csam', 'Error', 4),
      (8, 101, NULL, 'Scanned', 4),
      (9, 106, 'csam', 'Blocked', 32);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "images") VALUES
      (101, '2026-01-01', '[{"id": 2}]'), (101, '2026-02-01', '[]'), (102, NULL, '[]');
    -- Names nobody here; 106 is its secondary user.
    INSERT INTO "CsamReport" ("userId", "details") VALUES (-1, '{"secondaryUserId": "106"}');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('the CSAM queue by user', () => {
  it('counts each owner’s flagged images, most flagged first, and nothing outside the queue', async () => {
    const { users, truncated } = await getCsamQueueByUser({ browsingLevel: ALL_LEVELS });
    expect(truncated).toBe(false);
    expect(
      users.map(({ userId, flagged, latestImageId }) => ({ userId, flagged, latestImageId }))
    ).toEqual([
      { userId: 101, flagged: 3, latestImageId: 3 },
      { userId: 102, flagged: 1, latestImageId: 4 },
      { userId: 103, flagged: 1, latestImageId: 5 },
      { userId: 106, flagged: 1, latestImageId: 9 },
    ]);
  });

  it('says whether each owner has a CSAM report, and when the newest was sent', async () => {
    const { users } = await getCsamQueueByUser({ browsingLevel: ALL_LEVELS });
    expect(
      users.map(({ userId, reported, reportSentAt }) => ({
        userId,
        reported,
        sent: reportSentAt ? new Date(reportSentAt).toISOString().slice(0, 10) : null,
      }))
    ).toEqual([
      { userId: 101, reported: true, sent: '2026-02-01' },
      { userId: 102, reported: true, sent: null },
      { userId: 103, reported: false, sent: null },
      // Secondary on a report is not a report about them.
      { userId: 106, reported: false, sent: null },
    ]);
  });

  it('says what a bulk clear would take, whatever the level filter, and whom it would refuse', async () => {
    const { users } = await getCsamQueueByUser({ browsingLevel: 4 });
    expect(users.map(({ userId, removed, heldBy }) => ({ userId, removed, heldBy }))).toEqual([
      { userId: 101, removed: 1, heldBy: ['csamReport', 'ban', 'reportedImage'] },
      { userId: 102, removed: 0, heldBy: ['csamReport'] },
    ]);
    const all = await getCsamQueueByUser({ browsingLevel: ALL_LEVELS });
    expect(all.users.find((u) => u.userId === 103)).toMatchObject({ removed: 1, heldBy: [] });
    expect(all.users.find((u) => u.userId === 106)).toMatchObject({
      removed: 1,
      heldBy: ['csamReportSecondary'],
    });
  });

  it('applies the browsing-level filter the flat queue applies', async () => {
    const { users } = await getCsamQueueByUser({ browsingLevel: 4 });
    expect(users.map(({ userId, flagged }) => ({ userId, flagged }))).toEqual([
      { userId: 101, flagged: 2 },
      { userId: 102, flagged: 1 },
    ]);
  });
});

describe('an evidence hold in the CSAM queue by user', () => {
  afterAll(async () => {
    await db.exec(`DROP VIEW IF EXISTS "EvidenceHeldUser"; DROP TABLE IF EXISTS "EvidenceHold"`);
  });

  const heldBy = async (userId: number) =>
    (await getCsamQueueByUser({ browsingLevel: ALL_LEVELS })).users.find((u) => u.userId === userId)
      ?.heldBy;

  it('names the hold for a user the marker view holds, and only that user', async () => {
    await db.exec(`
      CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL);
      CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold" GROUP BY "userId";
      INSERT INTO "EvidenceHold" ("userId") VALUES (103);
    `);
    expect(await heldBy(103)).toEqual(['evidenceHold']);
    expect(await heldBy(106)).toEqual(['csamReportSecondary']);
  });

  // Without the view every user reads as held, so no user may be told they are on a hold.
  it('says the status is unknown while the table exists without its view', async () => {
    await db.exec(`DROP VIEW "EvidenceHeldUser"`);
    expect(await heldBy(103)).toEqual(['evidenceHoldUnknown']);
    expect(await heldBy(106)).toEqual(['csamReportSecondary', 'evidenceHoldUnknown']);
  });
});

describe('the CSAM queue filtered to one user', () => {
  it('lists only that owner’s flagged images', async () => {
    const { items } = await getImageReviewQueue({
      needsReview: 'csam',
      browsingLevel: ALL_LEVELS,
      userId: 101,
      limit: 50,
    });
    expect(items.map((i) => i.id)).toEqual([3, 2, 1]);
  });
});
