import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `read` stands in for the replica. Unset, it is the primary; a test that sets it to a stale copy
// shows which reads go to which.
const { dbHandle } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown, read: null as unknown },
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.read ?? dbHandle.current;
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
const PULLED_B = 'pulled-reason-b';
const REASONS = [PULLED, PULLED_B];

// Posts 101 (a pulled version), 109 (a pulled model) and 114 (a version pulled for one reason under a
// model pulled for another: the version's wins) are the only three a run may report. Every other post
// is a case that must not be: the owner's own, unpublished, scheduled, a reason not asked for, a
// version or model since republished with its old reason left in meta, and the exclusions.
const FIXTURE = `
INSERT INTO "User" VALUES (${OWNER}, NULL, NULL), (${MOD}, NULL, NULL), (-1, NULL, NULL),
  (10, NULL, NULL), (11, '2026-01-01', NULL), (12, NULL, NULL), (13, NULL, NULL),
  (14, NULL, NULL), (15, NULL, NULL), (16, NULL, NULL), (17, NULL, NULL), (18, NULL, NULL),
  (19, NULL, NULL), (999, NULL, NULL);
INSERT INTO "CsamReport" ("userId", details) VALUES (12, '{}'), (999, '{"secondaryUserId": "19"}');
INSERT INTO "Model" VALUES
  (1, ${OWNER}, 'Published', NULL),
  (2, ${OWNER}, 'Unpublished', '{"unpublishedReason": "${PULLED}"}'),
  (5, ${OWNER}, 'Published', '{"unpublishedReason": "${PULLED}"}'),
  (6, ${OWNER}, 'Unpublished', '{"unpublishedReason": "${PULLED_B}"}');
INSERT INTO "ModelVersion" VALUES
  (1, 1, 'UnpublishedViolation', '{"unpublishedReason": "${PULLED}"}'),
  (2, 1, 'Unpublished', '{"unpublishedReason": "another-reason"}'),
  (3, 2, 'Published', NULL),
  (4, 1, 'Published', '{"unpublishedReason": "${PULLED}"}'),
  (50, 5, 'Published', NULL),
  (60, 6, 'UnpublishedViolation', '{"unpublishedReason": "${PULLED}"}');
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
  (112, 10, 1, now() + interval '1 day'),
  (113, 10, 50, '2026-01-01'),
  (114, 16, 60, '2026-01-01'),
  (115, 17, 1, '2026-01-01'),
  (116, 18, 1, '2026-01-01'),
  (117, 19, 1, '2026-01-01');
INSERT INTO "Image" (id, "postId", "userId", ingestion, "needsReview", "blockedFor") VALUES
  (1, 101, 10, 'Scanned', NULL, NULL), (2, 101, 10, 'Scanned', NULL, NULL),
  (3, 102, ${OWNER}, 'Scanned', NULL, NULL), (4, 103, 10, 'Scanned', NULL, NULL),
  (5, 104, 11, 'Scanned', NULL, NULL), (6, 105, 12, 'Scanned', NULL, NULL),
  (7, 106, 13, 'Scanned', NULL, NULL), (8, 106, 13, 'Scanned', 'csam', NULL),
  (9, 107, 14, 'Scanned', NULL, NULL), (10, 107, 14, 'Blocked', NULL, 'moderated'),
  (11, 109, 15, 'Scanned', NULL, NULL), (12, 110, 10, 'Scanned', NULL, NULL),
  (13, 111, 10, 'Scanned', NULL, NULL), (14, 112, 10, 'Scanned', NULL, NULL),
  (15, 113, 10, 'Scanned', NULL, NULL), (16, 114, 16, 'Scanned', NULL, NULL),
  (17, 115, 17, 'Scanned', NULL, 'CSAM'), (18, 116, 18, 'Pending', NULL, NULL),
  (19, 117, 19, 'Scanned', NULL, NULL);
`;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA + FIXTURE);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  dbHandle.read = null;
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
      eligible: 3,
      excluded: {
        alreadyQueued: 0,
        noImages: 1,
        // 106 csam-flagged, 107 Blocked, 115 blocked for CSAM while Scanned, 116 Pending.
        imageNotClear: 4,
        posterBanned: 1,
        // 105 the subject of a CSAM report, 117 named as its secondary user.
        posterHeld: 2,
      },
      byReason: { [PULLED]: 3 },
    });
    expect(await reportedPosts()).toEqual([]);
  });

  // Both directions: a count that is too low must be refused too, or the operator who saw fewer
  // posts than there are files them all.
  it.each([4, 2])(
    'refuses a run expecting %i when 3 are eligible, and files nothing',
    async (expected) => {
      const result = await run(expected);

      expect(result).toMatchObject({ ok: false, reason: 'countChanged' });
      expect(await reportedPosts()).toEqual([]);
    }
  );

  it('reports exactly the eligible posts, as the system account, and changes no post or image', async () => {
    const before = await snapshot();

    const result = await run(3);

    expect(result).toMatchObject({ ok: true, reported: 3 });
    expect(await reportedPosts()).toEqual([101, 109, 114]);
    const reports = await pg.query<{
      userId: number;
      reason: string;
      status: string;
      details: Record<string, unknown>;
    }>(`SELECT r."userId", r.reason, r.status, r.details FROM "Report" r ORDER BY r.id`);
    const filed = (details: Record<string, unknown>) => ({
      userId: -1,
      reason: 'AdminAttention',
      status: 'Pending',
      details: expect.objectContaining({ source: ENQUEUE_SOURCE, ...details }),
    });
    expect(reports.rows).toEqual([
      filed({
        modelId: 1,
        modelVersionId: 1,
        unpublishedReason: PULLED,
        unpublishedLevel: 'version',
      }),
      filed({
        modelId: 2,
        modelVersionId: 3,
        unpublishedReason: PULLED,
        unpublishedLevel: 'model',
      }),
      filed({
        modelId: 6,
        modelVersionId: 60,
        unpublishedReason: PULLED,
        unpublishedLevel: 'version',
      }),
    ]);
    const activity = await pg.query(
      `SELECT "userId", "entityType", "entityId" FROM "ModActivity" ORDER BY "entityId"`
    );
    expect(activity.rows).toEqual(
      [101, 109, 114].map((entityId) => ({ userId: MOD, entityType: 'post', entityId }))
    );
    expect(await snapshot()).toBe(before);
  });

  it('files nothing new on a rerun, and counts the reported posts as already queued', async () => {
    await run(3);

    const plan = await planEnqueue(REASONS, undefined, PAGE);
    expect(plan.eligible).toBe(0);
    expect(plan.excluded.alreadyQueued).toBe(3);
    expect(await run(0)).toMatchObject({ ok: true, reported: 0 });
    expect(await reportedPosts()).toEqual([101, 109, 114]);
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

    expect(await run(3)).toMatchObject({ ok: true, reported: 3 });
  });

  // An evidence-hold table with its view gone is "drift": the hold legs then hold everyone, so the
  // job must file nothing rather than file around a hold it cannot read.
  it('holds every poster when the hold marker has drifted', async () => {
    await pg.exec(`CREATE TABLE "EvidenceHold" (id int);`);

    const plan = await planEnqueue(REASONS, undefined, PAGE);
    expect(plan.eligible).toBe(0);
    expect(plan.excluded.posterHeld).toBe(5);
  });

  // The replica may lag. A real run counts and files from the primary, so a stale replica can
  // neither refuse a correct count nor let a wrong one through.
  it('counts a real run from the primary, not the replica', async () => {
    const replica = await freshPglite();
    await replica.exec(SCHEMA);
    dbHandle.read = new Kysely({ dialect: pgliteDialect(replica) });

    expect((await planEnqueue(REASONS, undefined, PAGE)).eligible).toBe(0);
    expect(await run(3)).toMatchObject({ ok: true, reported: 3 });
  });

  // The count is checked before the first page; a post that becomes eligible after that may take
  // another's place, but the run never files more than the operator confirmed.
  it('never files more than the expected count when a post becomes eligible mid-run', async () => {
    const primary = dbHandle.current as Kysely<never>;
    const transaction = primary.transaction.bind(primary);
    vi.spyOn(primary, 'transaction').mockImplementationOnce(() => {
      const builder = transaction();
      return {
        execute: async (fn: never) => {
          await pg.exec(`
            INSERT INTO "Post" VALUES (100, 10, 1, '2026-01-01');
            INSERT INTO "Image" (id, "postId", "userId") VALUES (100, 100, 10);
          `);
          return builder.execute(fn);
        },
      } as never;
    });

    // One page holding every candidate, so the cap inside the page is what stops it; across pages
    // the loop's own `reported < expectedCount` would stop it first and hide a missing cap.
    const result = await enqueueUnpublishedVersionPosts({
      reasons: REASONS,
      expectedCount: 3,
      moderatorId: MOD,
      pageSize: 500,
    });

    expect(result).toMatchObject({ ok: true, reported: 3 });
    expect(await reportedPosts()).toEqual([100, 101, 109]);
  });

  // Each page is one transaction: a page that fails partway files none of its posts, the pages
  // before it stay filed, and the result says how many.
  it('rolls back a failed page whole and reports what earlier pages filed', async () => {
    await pg.exec(`
      CREATE FUNCTION fail_on_109() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."postId" = 109 THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_on_109 BEFORE INSERT ON "PostReport"
        FOR EACH ROW EXECUTE FUNCTION fail_on_109();
    `);

    expect(await run(3)).toMatchObject({ ok: false, reason: 'failed', reported: 1 });
    expect(await reportedPosts()).toEqual([101]);
    const reports = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Report"`);
    expect(reports.rows[0].n).toBe(1);
    const activity = await pg.query<{ entityId: number }>(`SELECT "entityId" FROM "ModActivity"`);
    expect(activity.rows.map((r) => r.entityId)).toEqual([101]);
  });
});
