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

const { getCsamQueueByUser, getImageReviewCounts, getImageReviewQueue } = await import(
  '../image-review.service'
);

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
  "images" JSONB NOT NULL DEFAULT '[]', "type" TEXT NOT NULL DEFAULT 'Image'
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

describe('what a sent CSAM report takes out of the pending count', () => {
  // Every image predates every send (2026-03-01) unless said, so dates never cover one.
  // 201: both listed, one as { id }, one as a bare id the send cannot read. 202: one of two listed.
  // 203: none listed.
  // 204: listed on a report never sent. 205: no report. 206: created after the send, listed.
  // 207: listed only on a report about someone else. 211: listed only on a report of another type.
  // 212: both listed, but the send recorded one file as missing. 213: a report whose images are not
  // a list. 206's report details are malformed, which must not change its result. 214: one send
  // recorded image 37 as missing, a later send carried it.
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "User" ("id", "username") VALUES
        (201, 'g'), (202, 'h'), (203, 'i'), (204, 'j'), (205, 'k'), (206, 'l'), (207, 'm'),
        (211, 'o'), (212, 'p'), (213, 'q'), (214, 'r');
      INSERT INTO "Image" ("id", "userId", "needsReview", "createdAt") VALUES
        (21, 201, 'csam', '2026-01-01'),
        (22, 201, 'csam', '2026-01-01'),
        (23, 202, 'csam', '2026-01-01'),
        (24, 202, 'csam', '2026-01-01'),
        (25, 203, 'csam', '2026-01-01'),
        (26, 204, 'csam', '2026-01-01'),
        (27, 205, 'csam', '2026-01-01'),
        (28, 206, 'csam', '2026-04-01'),
        (29, 207, 'csam', '2026-01-01'),
        (30, 201, 'minor', '2026-01-01'),
        (32, 211, 'csam', '2026-01-01'),
        (33, 212, 'csam', '2026-01-01'),
        (34, 212, 'csam', '2026-01-01'),
        (35, 213, 'csam', '2026-01-01'),
        (36, 214, 'csam', '2026-01-01'),
        (37, 214, 'csam', '2026-01-01');
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "images", "details") VALUES
        (214, '2026-03-01', '[{"id": 36}, {"id": 37}]',
          '{"images": [{"id": 36, "fileId": "f"}, {"id": 37, "source": "missing"}]}'),
        (214, '2026-03-02', '[{"id": 37}]', '{"images": [{"id": 37, "fileId": "g"}]}'),
        (212, '2026-03-01', '[{"id": 33}, {"id": 34}]',
          '{"images": [{"id": 33, "fileId": "f"}, {"id": 34, "source": "missing"}]}'),
        (213, '2026-03-01', '{"id": 35}', NULL),
        (206, '2026-03-01', '[]', '{"images": "x"}');
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "images", "type") VALUES
        (201, '2026-03-01', '[{"id": 21}, 22, {"id": 30}]', 'Image'),
        (202, '2026-03-01', '[{"id": 23}]', 'Image'),
        (203, '2026-03-01', '[]', 'Image'),
        (204, NULL, '[{"id": 26}]', 'Image'),
        (206, '2026-03-01', '[{"id": 28}]', 'Image'),
        (208, '2026-03-01', '[{"id": 29}]', 'Image'),
        (211, '2026-03-01', '[{"id": 32}]', 'TrainingData');
    `);
  });

  afterAll(async () => {
    await db.exec(`
      DELETE FROM "CsamReport" WHERE "userId" BETWEEN 201 AND 214;
      DELETE FROM "Image" WHERE "userId" BETWEEN 201 AND 214;
      DELETE FROM "User" WHERE id BETWEEN 201 AND 214;
    `);
  });

  const pendingOf = async () =>
    Object.fromEntries(
      (await getCsamQueueByUser({ browsingLevel: ALL_LEVELS })).users.map((u) => [
        u.userId,
        u.pending,
      ])
    );

  it('leaves pending every image no sent report on its owner lists', async () => {
    expect(await pendingOf()).toEqual({
      // One of 101's sent reports lists image 2.
      101: 2,
      102: 1,
      103: 1,
      106: 1,
      201: 1,
      202: 1,
      203: 1,
      204: 1,
      205: 1,
      206: 0,
      207: 1,
      211: 1,
      212: 1,
      213: 1,
      214: 0,
    });
  });

  it('lists users with something pending first', async () => {
    const { users } = await getCsamQueueByUser({ browsingLevel: ALL_LEVELS });
    expect(users.slice(-2).map((u) => u.userId)).toEqual([214, 206]);
  });

  it('badges exactly what the by-user page shows as pending', async () => {
    const pending = Object.values(await pendingOf()).reduce((a, b) => a + b, 0);
    expect(pending).toBe(14);
    expect(Number((await getImageReviewCounts()).csam)).toBe(pending);
  });

  it('leaves the other queues’ badges alone', async () => {
    // 104's image, and 201's, though a sent report on 201 lists it.
    expect(Number((await getImageReviewCounts()).minor)).toBe(2);
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

describe('images set aside from the CSAM queue', () => {
  // 301 is not held: dismissed 400 days ago (61), set aside after a report (63), no row (64). 302 is
  // held: dismissed 400 days ago (65), set aside after a report (66).
  beforeAll(async () => {
    await db.exec(`
      CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');
      CREATE TABLE "CsamQueueSetAside" (
        "imageId" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL,
        "outcome" "CsamQueueSetAsideOutcome" NOT NULL, "csamReportId" INTEGER,
        "moderatorId" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL
      );
      CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL);
      CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold" GROUP BY "userId";
      INSERT INTO "EvidenceHold" ("userId") VALUES (302);
      INSERT INTO "User" ("id", "username") VALUES (301, 's'), (302, 't');
      INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion") VALUES
        (61, 301, 'csam', 'Blocked'), (63, 301, 'csam', 'Blocked'), (64, 301, 'csam', 'Blocked'),
        (65, 302, 'csam', 'Blocked'), (66, 302, 'csam', 'Blocked');
      INSERT INTO "CsamQueueSetAside" ("imageId", "userId", "outcome", "moderatorId", "createdAt") VALUES
        (61, 301, 'Dismissed', 1, (now() AT TIME ZONE 'UTC') - interval '400 days'),
        (63, 301, 'AfterReport', 1, now() AT TIME ZONE 'UTC'),
        (65, 302, 'Dismissed', 1, (now() AT TIME ZONE 'UTC') - interval '400 days'),
        (66, 302, 'AfterReport', 1, now() AT TIME ZONE 'UTC');
    `);
  });

  afterAll(async () => {
    await db.exec(`
      DROP VIEW IF EXISTS "EvidenceHeldUser"; DROP TABLE IF EXISTS "EvidenceHold";
      DROP TABLE IF EXISTS "CsamQueueSetAside"; DROP TYPE IF EXISTS "CsamQueueSetAsideOutcome";
      DELETE FROM "Image" WHERE "userId" IN (301, 302); DELETE FROM "User" WHERE id IN (301, 302);
    `);
  });

  const pendingOf = async (userId: number) =>
    (await getCsamQueueByUser({ browsingLevel: ALL_LEVELS })).users.find((u) => u.userId === userId)
      ?.pending;
  const listed = async (userId: number) =>
    (
      await getImageReviewQueue({
        needsReview: 'csam',
        browsingLevel: ALL_LEVELS,
        userId,
        limit: 50,
      })
    ).items.map((i) => i.id);

  it('keeps a dismissal out for good, and a row set aside after a report only while held', async () => {
    expect(await pendingOf(301)).toBe(2);
    expect(await listed(301)).toEqual([64, 63]);
    expect(await pendingOf(302)).toBe(0);
    expect(await listed(302)).toEqual([]);
  });

  it('badges what the by-user page shows as pending', async () => {
    const { users } = await getCsamQueueByUser({ browsingLevel: ALL_LEVELS });
    const pending = users.reduce((n, u) => n + u.pending, 0);
    expect(Number((await getImageReviewCounts()).csam)).toBe(pending);
  });

  it('shows rows set aside after a report while the marker view is missing', async () => {
    await db.exec(`DROP VIEW "EvidenceHeldUser"`);
    try {
      expect(await pendingOf(301)).toBe(2);
      expect(await pendingOf(302)).toBe(1);
      expect(await listed(302)).toEqual([66]);
    } finally {
      await db.exec(
        `CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold" GROUP BY "userId"`
      );
    }
  });

  it('shows every image while the table is missing', async () => {
    await db.exec(`ALTER TABLE "CsamQueueSetAside" RENAME TO "CsamQueueSetAsideAway"`);
    try {
      expect(await pendingOf(301)).toBe(3);
      expect(await pendingOf(302)).toBe(2);
      expect(await listed(301)).toEqual([64, 63, 61]);
      expect(Number((await getImageReviewCounts()).csam)).toBeGreaterThan(0);
    } finally {
      await db.exec(`ALTER TABLE "CsamQueueSetAsideAway" RENAME TO "CsamQueueSetAside"`);
    }
  });
});
