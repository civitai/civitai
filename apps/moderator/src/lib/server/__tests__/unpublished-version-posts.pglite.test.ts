import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

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

const { planEnqueue, enqueueUnpublishedVersionPosts, ENQUEUE_SOURCE } = await import(
  '../unpublished-version-posts'
);

const SCHEMA = `
CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), meta jsonb);
CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, meta jsonb);
CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, meta jsonb);
CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int, "publishedAt" timestamp(3));
CREATE TABLE "Image" (
  id int PRIMARY KEY, "postId" int, "userId" int NOT NULL,
  ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text, "blockedFor" text
);
CREATE TABLE "CsamReport" (
  id serial PRIMARY KEY, "userId" int, details jsonb, images jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE "Report" (
  id serial PRIMARY KEY, "userId" int NOT NULL, reason text NOT NULL, status text NOT NULL,
  details jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now()
);
CREATE TABLE "PostReport" ("reportId" int NOT NULL UNIQUE, "postId" int NOT NULL);
CREATE TABLE "ModActivity" (
  id serial PRIMARY KEY, "userId" int, "entityType" text, "entityId" int, activity text
);
`;

const MOD = 9;
const OWNER = 1;
const PULLED = 'pulled-reason';
const REASONS = [PULLED];

// Posts 101 (a pulled version) and 109 (a pulled model) are the only two a run may report. Every
// other post is a case that must not be: the owner's own, unpublished, scheduled, a reason not asked
// for, a version since republished, and the five exclusions.
const FIXTURE = `
INSERT INTO "User" VALUES (${OWNER}, NULL, NULL), (${MOD}, NULL, NULL), (-1, NULL, NULL),
  (10, NULL, NULL), (11, '2026-01-01', NULL), (12, NULL, NULL), (13, NULL, NULL),
  (14, NULL, NULL), (15, NULL, NULL);
INSERT INTO "CsamReport" ("userId", details) VALUES (12, '{}');
INSERT INTO "Model" VALUES
  (1, ${OWNER}, 'Published', NULL),
  (2, ${OWNER}, 'Unpublished', '{"unpublishedReason": "${PULLED}"}');
INSERT INTO "ModelVersion" VALUES
  (1, 1, 'UnpublishedViolation', '{"unpublishedReason": "${PULLED}"}'),
  (2, 1, 'Unpublished', '{"unpublishedReason": "another-reason"}'),
  (3, 2, 'Published', NULL),
  (4, 1, 'Published', '{"unpublishedReason": "${PULLED}"}');
INSERT INTO "Post" VALUES
  (101, 10, 1, '2026-01-01'),
  (102, ${OWNER}, 1, '2026-01-01'),
  (103, 10, 1, NULL),
  (104, 11, 1, '2026-01-01'),
  (105, 12, 1, '2026-01-01'),
  (106, 13, 1, '2026-01-01'),
  (107, 14, 1, '2026-01-01'),
  (108, 10, 1, '2026-01-01'),
  (109, 15, 3, '2026-01-01'),
  (110, 10, 2, '2026-01-01'),
  (111, 10, 4, '2026-01-01'),
  (112, 10, 1, now() + interval '1 day');
INSERT INTO "Image" (id, "postId", "userId", ingestion, "needsReview", "blockedFor") VALUES
  (1, 101, 10, 'Scanned', NULL, NULL), (2, 101, 10, 'Scanned', NULL, NULL),
  (3, 102, ${OWNER}, 'Scanned', NULL, NULL), (4, 103, 10, 'Scanned', NULL, NULL),
  (5, 104, 11, 'Scanned', NULL, NULL), (6, 105, 12, 'Scanned', NULL, NULL),
  (7, 106, 13, 'Scanned', NULL, NULL), (8, 106, 13, 'Scanned', 'csam', NULL),
  (9, 107, 14, 'Scanned', NULL, NULL), (10, 107, 14, 'Blocked', NULL, 'moderated'),
  (11, 109, 15, 'Scanned', NULL, NULL), (12, 110, 10, 'Scanned', NULL, NULL),
  (13, 111, 10, 'Scanned', NULL, NULL), (14, 112, 10, 'Scanned', NULL, NULL);
`;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA + FIXTURE);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

const reportedPosts = async () =>
  (
    await pg.query<{ postId: number }>(`SELECT "postId" FROM "PostReport" ORDER BY "postId"`)
  ).rows.map((r) => r.postId);

const snapshot = async () =>
  JSON.stringify([
    (await pg.query(`SELECT * FROM "Image" ORDER BY id`)).rows,
    (await pg.query(`SELECT * FROM "Post" ORDER BY id`)).rows,
  ]);

// Page size 2 throughout, so every run crosses several keyset pages.
const PAGE = 2;
const run = (expectedCount: number) =>
  enqueueUnpublishedVersionPosts({
    reasons: REASONS,
    expectedCount,
    moderatorId: MOD,
    pageSize: PAGE,
  });

describe('enqueueing posts on unpublished resources for review', () => {
  it('counts the eligible posts and each exclusion, and a dry run writes nothing', async () => {
    const plan = await planEnqueue(REASONS, undefined, PAGE);

    expect(plan).toEqual({
      eligible: 2,
      excluded: {
        alreadyQueued: 0,
        noImages: 1,
        imageNotClear: 2,
        posterBanned: 1,
        posterHeld: 1,
      },
      byReason: { [PULLED]: 2 },
    });
    expect(await reportedPosts()).toEqual([]);
  });

  it('refuses a run whose expected count is not what it counts now, and files nothing', async () => {
    const result = await run(3);

    expect(result).toMatchObject({ ok: false, reason: 'countChanged' });
    expect(await reportedPosts()).toEqual([]);
  });

  it('reports exactly the eligible posts, as the system account, and changes no post or image', async () => {
    const before = await snapshot();

    const result = await run(2);

    expect(result).toMatchObject({ ok: true, reported: 2 });
    expect(await reportedPosts()).toEqual([101, 109]);
    const reports = await pg.query<{
      userId: number;
      reason: string;
      status: string;
      details: Record<string, unknown>;
    }>(`SELECT r."userId", r.reason, r.status, r.details FROM "Report" r ORDER BY r.id`);
    expect(reports.rows).toEqual([
      {
        userId: -1,
        reason: 'AdminAttention',
        status: 'Pending',
        details: expect.objectContaining({
          source: ENQUEUE_SOURCE,
          modelId: 1,
          modelVersionId: 1,
          unpublishedReason: PULLED,
          unpublishedLevel: 'version',
        }),
      },
      {
        userId: -1,
        reason: 'AdminAttention',
        status: 'Pending',
        details: expect.objectContaining({
          modelId: 2,
          modelVersionId: 3,
          unpublishedReason: PULLED,
          unpublishedLevel: 'model',
        }),
      },
    ]);
    const activity = await pg.query(
      `SELECT "userId", "entityType", "entityId" FROM "ModActivity" ORDER BY "entityId"`
    );
    expect(activity.rows).toEqual([
      { userId: MOD, entityType: 'post', entityId: 101 },
      { userId: MOD, entityType: 'post', entityId: 109 },
    ]);
    expect(await snapshot()).toBe(before);
  });

  it('files nothing new on a rerun, and counts the reported posts as already queued', async () => {
    await run(2);

    const plan = await planEnqueue(REASONS, undefined, PAGE);
    expect(plan.eligible).toBe(0);
    expect(plan.excluded.alreadyQueued).toBe(2);
    expect(await run(0)).toMatchObject({ ok: true, reported: 0 });
    expect(await reportedPosts()).toEqual([101, 109]);
  });

  // The marker is what makes a rerun safe; a report on the same post from a person, or from the
  // system account for something else, is not this job's and must not stop it.
  it('still reports a post that has some other report on it', async () => {
    await pg.exec(`
      INSERT INTO "Report" (id, "userId", reason, status, details) VALUES
        (900, 10, 'AdminAttention', 'Pending', '{"source": "${ENQUEUE_SOURCE}"}'),
        (901, -1, 'Automated', 'Pending', '{}');
      INSERT INTO "PostReport" VALUES (900, 101), (901, 109);
      SELECT setval(pg_get_serial_sequence('"Report"', 'id'), 1000);
    `);

    expect(await run(2)).toMatchObject({ ok: true, reported: 2 });
  });
});
