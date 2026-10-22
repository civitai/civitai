import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

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

const {
  releaseHeldUserCsamFlags,
  clearRemovedFlagsUnlessHeld,
  RELEASABLE_LEGS,
  RELEASE_TABLE,
  HOLD_MARKER_TABLE,
  HOLD_MARKER_VIEW,
} = await import('../csam-flag-clear');

const SCHEMA = `
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "bannedAt" TIMESTAMP(3), "meta" JSONB);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "needsReview" TEXT,
  "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned'
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "reportSentAt" TIMESTAMP(3), "details" JSONB,
  "images" JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, "activity" TEXT
);
CREATE TABLE "${HOLD_MARKER_TABLE}" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE VIEW "${HOLD_MARKER_VIEW}" AS SELECT "userId" FROM "${HOLD_MARKER_TABLE}" GROUP BY "userId";
`;

// As the migration writes it.
const RELEASE_TABLE_SQL = `
CREATE TABLE "${RELEASE_TABLE}" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "moderatorId" INTEGER NOT NULL,
  "approvalRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "overriddenLegs" JSONB NOT NULL,
  "imageCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;

const ADMIN = 9;
const REF = '2026-01-31-120000-0123abcd';
const minorBan = JSON.stringify({ banDetails: { reasonCode: 'SexualMinor' } });

// Every user owns three CSAM-flagged images: two removed, one still live. All but `notHeld` are
// banned for a reason that holds; the rest of each name is the hold it carries besides.
const USERS = {
  banOnly: 200,
  banOnlyAgain: 201,
  dryRun: 202,
  mismatch: 203,
  report: 210,
  secondaryReport: 211,
  reportedImage: 212,
  evidenceHold: 213,
  notHeld: 220,
  bystander: 230,
} as const;
type Key = keyof typeof USERS;

let db: PGlite;

const flagged = async (userId: number) =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "Image" WHERE "userId" = $1 AND "needsReview" = 'csam' ORDER BY id`,
      [userId]
    )
  ).rows.map((r) => r.id);

const activityFor = async (userId: number) =>
  (
    await db.query<{ userId: number; entityType: string; entityId: number; activity: string }>(
      `SELECT "userId", "entityType", "entityId", "activity" FROM "ModActivity"
       WHERE "entityId" BETWEEN $1 * 10 AND $1 * 10 + 9 ORDER BY "entityId"`,
      [userId]
    )
  ).rows;

const releasesFor = async (userId: number) =>
  (
    await db.query(
      `SELECT "userId", "moderatorId", "approvalRef", "reason", "overriddenLegs", "imageCount"
       FROM "${RELEASE_TABLE}" WHERE "userId" = $1`,
      [userId]
    )
  ).rows;

beforeAll(async () => {
  delete process.env.MOD_HOLD_BAN_NOTES_PATTERN;
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(RELEASE_TABLE_SQL);
  for (const [key, id] of Object.entries(USERS) as [Key, number][]) {
    const banned = key !== 'notHeld' && key !== 'bystander';
    await db.query(`INSERT INTO "User" ("id", "bannedAt", "meta") VALUES ($1, $2, $3)`, [
      id,
      banned ? new Date('2026-01-01') : null,
      banned ? minorBan : null,
    ]);
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion") VALUES
        ($1 * 10 + 1, $1, 'csam', 'Blocked'),
        ($1 * 10 + 2, $1, 'csam', 'Blocked'),
        ($1 * 10 + 3, $1, 'csam', 'Scanned')`,
      [id]
    );
  }
  await db.exec(`
    INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion") VALUES (2009, 200, 'minor', 'Blocked');
    INSERT INTO "CsamReport" ("userId", "details") VALUES (210, '{}');
    INSERT INTO "CsamReport" ("userId", "details") VALUES (-1, '{"secondaryUserId": "211"}');
    INSERT INTO "CsamReport" ("userId", "details", "images") VALUES (-1, '{}', '[{"id": 2121}]');
    INSERT INTO "${HOLD_MARKER_TABLE}" ("userId") VALUES (213);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const release = (userId: number, expectedCount = 2) =>
  releaseHeldUserCsamFlags({
    userId,
    expectedCount,
    approvalRef: REF,
    reason: ' cleared on review ',
    moderatorId: ADMIN,
  });

const count = (userId: number) =>
  releaseHeldUserCsamFlags({
    userId,
    approvalRef: REF,
    reason: 'cleared on review',
    moderatorId: ADMIN,
    dryRun: true,
  });

describe('releasing a user held only by a ban', () => {
  it('clears every removed image’s flag and records the release', async () => {
    const id = USERS.banOnly;

    expect(await release(id)).toEqual({
      ok: true,
      dryRun: false,
      count: 2,
      remaining: 1,
      legs: ['ban'],
    });

    expect(await flagged(id)).toEqual([id * 10 + 3]);
    expect(await activityFor(id)).toEqual([
      {
        userId: ADMIN,
        entityType: 'image',
        entityId: id * 10 + 1,
        activity: 'releaseHeldReviewFlag',
      },
      {
        userId: ADMIN,
        entityType: 'image',
        entityId: id * 10 + 2,
        activity: 'releaseHeldReviewFlag',
      },
    ]);
    expect(await releasesFor(id)).toEqual([
      {
        userId: id,
        moderatorId: ADMIN,
        approvalRef: REF,
        reason: 'cleared on review',
        overriddenLegs: ['ban'],
        imageCount: 2,
      },
    ]);
  });

  it('leaves live images, other queues’ flags and other users untouched', async () => {
    const { rows } = await db.query<{ needsReview: string; ingestion: string }>(
      `SELECT "needsReview", ingestion FROM "Image" WHERE id IN (2003, 2009) ORDER BY id`
    );
    expect(rows).toEqual([
      { needsReview: 'csam', ingestion: 'Scanned' },
      { needsReview: 'minor', ingestion: 'Blocked' },
    ]);
    expect(await flagged(USERS.bystander)).toHaveLength(3);
    // The images stay removed.
    expect((await db.query(`SELECT ingestion FROM "Image" WHERE id IN (2001, 2002)`)).rows).toEqual(
      [{ ingestion: 'Blocked' }, { ingestion: 'Blocked' }]
    );
  });

  it('counts without changing anything', async () => {
    const id = USERS.dryRun;

    expect(await count(id)).toEqual({
      ok: true,
      dryRun: true,
      count: 2,
      remaining: 1,
      legs: ['ban'],
    });

    expect(await flagged(id)).toHaveLength(3);
    expect(await activityFor(id)).toEqual([]);
    expect(await releasesFor(id)).toEqual([]);
  });

  it('releases nothing when the count differs from the one entered', async () => {
    const id = USERS.mismatch;

    expect(await release(id, 3)).toEqual({ ok: false, reason: 'changed', legs: ['ban'] });

    expect(await flagged(id)).toHaveLength(3);
    expect(await activityFor(id)).toEqual([]);
    expect(await releasesFor(id)).toEqual([]);
  });

  it('refuses a malformed approval reference before touching anything', async () => {
    await expect(
      releaseHeldUserCsamFlags({
        userId: USERS.banOnlyAgain,
        expectedCount: 2,
        approvalRef: 'hub:request:x',
        reason: 'r',
        moderatorId: ADMIN,
      })
    ).rejects.toThrow('Not an approval reference.');
    expect(await flagged(USERS.banOnlyAgain)).toHaveLength(3);
  });
});

// `legs` come back in `flagClearHoldLegs` order.
const LEG_ORDER = ['csamReport', 'csamReportSecondary', 'ban', 'reportedImage', 'evidenceHold'];
const byLeg = (a: string, b: string) => LEG_ORDER.indexOf(a) - LEG_ORDER.indexOf(b);

const OTHER_LEGS = [
  ['report', 'csamReport'],
  ['secondaryReport', 'csamReportSecondary'],
  ['reportedImage', 'reportedImage'],
  ['evidenceHold', 'evidenceHold'],
] as const;

describe('a user held by more than a ban', () => {
  it.each(OTHER_LEGS)('is refused, and keeps every flag (%s)', async (key, leg) => {
    const id = USERS[key];

    expect(await release(id)).toEqual({
      ok: false,
      reason: 'held',
      legs: ['ban', leg].sort(byLeg),
    });

    expect(await flagged(id)).toHaveLength(3);
    expect(await activityFor(id)).toEqual([]);
    expect(await releasesFor(id)).toEqual([]);
  });

  it.each(OTHER_LEGS)('is refused a count too (%s)', async (key) => {
    expect(await count(USERS[key])).toMatchObject({ ok: false, reason: 'held' });
  });

  // The pre-check and the UPDATE each carry the hold; this pins the UPDATE's on its own.
  it.each(OTHER_LEGS)('is skipped by the update itself (%s)', async (key) => {
    const kysely = dbHandle.current as Kysely<never>;
    expect(
      await clearRemovedFlagsUnlessHeld(kysely as never, USERS[key], 'view', RELEASABLE_LEGS)
    ).toEqual([]);
    expect(await flagged(USERS[key])).toHaveLength(3);
  });
});

describe('refusals that are not holds', () => {
  it('refuses a user who is not held: the normal clear is for them', async () => {
    const id = USERS.notHeld;
    expect(await release(id)).toEqual({ ok: false, reason: 'not-held', legs: [] });
    expect(await flagged(id)).toHaveLength(3);
  });

  it('refuses while the release table is missing', async () => {
    const id = USERS.banOnlyAgain;
    await db.exec(`ALTER TABLE "${RELEASE_TABLE}" RENAME TO "${RELEASE_TABLE}Away"`);
    try {
      expect(await release(id)).toEqual({ ok: false, reason: 'unavailable', legs: [] });
      expect(await count(id)).toEqual({ ok: false, reason: 'unavailable', legs: [] });
      expect(await flagged(id)).toHaveLength(3);
      expect(await activityFor(id)).toEqual([]);
    } finally {
      await db.exec(`ALTER TABLE "${RELEASE_TABLE}Away" RENAME TO "${RELEASE_TABLE}"`);
    }
    // Control: the same user releases once the table is back.
    expect(await release(id)).toMatchObject({ ok: true, count: 2 });
  });
});
