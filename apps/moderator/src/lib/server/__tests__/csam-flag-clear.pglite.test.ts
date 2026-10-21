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
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const {
  clearUserCsamFlags,
  clearRemovedFlagsUnlessHeld,
  FALLBACK_BAN_NOTES_PATTERN,
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
`;

const MOD = 9;

// Every user owns three CSAM-flagged images: two removed, one still live. A held user keeps all three.
const ban = (reasonCode: string | null, detailsInternal?: string) =>
  JSON.stringify({ banDetails: { reasonCode, detailsInternal } });
const USERS: Record<string, { id: number; bannedAt?: boolean; meta?: string }> = {
  clean: { id: 100 },
  otherClean: { id: 101 },
  subjectSent: { id: 110 },
  subjectUnsent: { id: 111 },
  secondary: { id: 112 },
  minorBan: { id: 120, bannedAt: true, meta: ban('SexualMinor') },
  minorTrainingBan: { id: 121, bannedAt: true, meta: ban('SexualMinorTraining') },
  noReasonBan: { id: 122, bannedAt: true, meta: ban(null) },
  otherBanNoted: { id: 123, bannedAt: true, meta: ban('Other', 'see NCMEC ticket') },
  otherBanPlain: { id: 124, bannedAt: true, meta: ban('Other', 'spam') },
  harassmentBan: { id: 125, bannedAt: true, meta: ban('Harassment') },
  held: { id: 130 },
  heldReleased: { id: 131 },
  heldExpired: { id: 132 },
  releasedWithReport: { id: 133 },
  heldExtended: { id: 134 },
  mismatch: { id: 140 },
  reportedImage: { id: 150 },
  otherImageReported: { id: 151 },
  notedByDeployedPattern: { id: 160, bannedAt: true, meta: ban('Other', 'zzfixturenote') },
  driftProbe: { id: 170 },
};

let db: PGlite;

const flagged = async (userId: number) =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "Image" WHERE "userId" = $1 AND "needsReview" = 'csam' ORDER BY id`,
      [userId]
    )
  ).rows.map((r) => r.id);

const activityFor = async (ids: number[]) =>
  (
    await db.query<{ userId: number; entityType: string; entityId: number; activity: string }>(
      `SELECT "userId", "entityType", "entityId", "activity" FROM "ModActivity"
       WHERE "entityId" = ANY($1::int[]) ORDER BY "entityId"`,
      [ids]
    )
  ).rows;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  for (const { id, bannedAt, meta } of Object.values(USERS)) {
    await db.query(`INSERT INTO "User" ("id", "bannedAt", "meta") VALUES ($1, $2, $3)`, [
      id,
      bannedAt ? new Date('2026-01-01') : null,
      meta ?? null,
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
    INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion") VALUES (9001, 100, 'minor', 'Blocked');
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "details") VALUES
      (110, '2026-01-01', '{}'),
      (111, NULL, '{}'),
      (999, '2026-01-01', '{"secondaryUserId": "112"}');
    -- Names nobody this suite owns, and lists one of 150's removed images.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "details", "images") VALUES
      (-1, NULL, '{}', '[{"id": 1501, "fileId": "f1"}]');
    -- 151's only listed image is one the clear does not touch. The rest are shapes no job writes,
    -- ids past int range among them, which every lookup must read past.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "details", "images") VALUES
      (-1, NULL, '{}', '[{"id": 1513}]'),
      (-1, NULL, '{"secondaryUserId": "99999999999"}', '{}'),
      (-1, NULL, '{}', '[null, 5, {"id": null}, {"id": "abc"}, {"id": 99999999999}]');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const clear = (userId: number, expectedCount = 2) =>
  clearUserCsamFlags({ userId, expectedCount, moderatorId: MOD });

describe('clearing one user’s CSAM flags', () => {
  it('clears every removed image’s flag and only those, and logs each as a dismissal', async () => {
    const id = USERS.clean.id;

    expect(await clear(id)).toEqual({ ok: true, cleared: 2, remaining: 1 });

    expect(await flagged(id)).toEqual([id * 10 + 3]);
    expect(await activityFor([id * 10 + 1, id * 10 + 2, id * 10 + 3])).toEqual([
      { userId: MOD, entityType: 'image', entityId: id * 10 + 1, activity: 'dismissReviewFlag' },
      { userId: MOD, entityType: 'image', entityId: id * 10 + 2, activity: 'dismissReviewFlag' },
    ]);
    // Another queue's flag on the same user, and another user's CSAM flags, are untouched.
    expect((await db.query(`SELECT "needsReview" FROM "Image" WHERE id = 9001`)).rows).toEqual([
      { needsReview: 'minor' },
    ]);
    expect(await flagged(USERS.otherClean.id)).toHaveLength(3);
  });

  it('keeps the images removed', async () => {
    const id = USERS.clean.id;
    const { rows } = await db.query<{ ingestion: string }>(
      `SELECT ingestion FROM "Image" WHERE id IN ($1, $2)`,
      [id * 10 + 1, id * 10 + 2]
    );
    expect(rows.map((r) => r.ingestion)).toEqual(['Blocked', 'Blocked']);
  });

  it('clears nothing when the count differs from what the moderator confirmed', async () => {
    const id = USERS.mismatch.id;

    expect(await clear(id, 1)).toEqual({ ok: false, reason: 'changed' });

    expect(await flagged(id)).toHaveLength(3);
    expect(await activityFor([id * 10 + 1, id * 10 + 2])).toEqual([]);
  });

  it('clears a user whose only listed image is one the clear does not touch', async () => {
    expect(await clear(USERS.otherImageReported.id)).toEqual({
      ok: true,
      cleared: 2,
      remaining: 1,
    });
  });

  it.each(['otherBanPlain', 'harassmentBan'])(
    'clears a user banned for another reason (%s)',
    async (key) => {
      expect(await clear(USERS[key].id)).toMatchObject({ ok: true, cleared: 2 });
    }
  );
});

const HELD = [
  'subjectSent',
  'subjectUnsent',
  'secondary',
  'minorBan',
  'minorTrainingBan',
  'noReasonBan',
  'otherBanNoted',
  'reportedImage',
];

describe('a held user', () => {
  it.each(HELD)('is refused, and keeps every flag (%s)', async (key) => {
    const id = USERS[key].id;

    expect(await clear(id)).toEqual({ ok: false, reason: 'held' });

    expect(await flagged(id)).toHaveLength(3);
    expect(await activityFor([id * 10 + 1, id * 10 + 2])).toEqual([]);
  });

  // The pre-check and the UPDATE each carry the hold; this pins the UPDATE's on its own.
  it.each(HELD)('is skipped by the update itself (%s)', async (key) => {
    const kysely = dbHandle.current as Kysely<never>;
    expect(await clearRemovedFlagsUnlessHeld(kysely as never, USERS[key].id, 'none')).toEqual([]);
    expect(await flagged(USERS[key].id)).toHaveLength(3);
  });
});

describe('the ban-notes pattern', () => {
  afterAll(() => {
    delete process.env.MOD_HOLD_BAN_NOTES_PATTERN;
  });

  it('is read from the deployment, not only the default', async () => {
    const id = USERS.notedByDeployedPattern.id;
    process.env.MOD_HOLD_BAN_NOTES_PATTERN = `${FALLBACK_BAN_NOTES_PATTERN}|\\mzzfixture`;

    expect(await clear(id)).toEqual({ ok: false, reason: 'held' });
    expect(await flagged(id)).toHaveLength(3);

    // The same notes clear under the default pattern.
    delete process.env.MOD_HOLD_BAN_NOTES_PATTERN;
    expect(await clear(id)).toMatchObject({ ok: true, cleared: 2 });
  });

  it('falls back, and says so, when the deployed pattern misses a fallback term', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.MOD_HOLD_BAN_NOTES_PATTERN = '\\mzzfixture';

    // Notes only the fallback matches still hold.
    expect(await clear(USERS.otherBanNoted.id)).toEqual({ ok: false, reason: 'held' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('misses a fallback term'));
    error.mockRestore();
  });
});

describe('a hold marker', () => {
  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE "${HOLD_MARKER_TABLE}" (
        "id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "releasedAt" TIMESTAMP(3),
        "releaseAt" TIMESTAMP(3), "extendedUntil" TIMESTAMP(3)
      );
      -- The view's WHERE as the migration that adds it writes it: released and expired holds drop out.
      CREATE VIEW "${HOLD_MARKER_VIEW}" AS
        SELECT "userId" FROM "${HOLD_MARKER_TABLE}"
        WHERE "releasedAt" IS NULL
          AND ("releaseAt" IS NULL OR "releaseAt" > now() OR "extendedUntil" > now())
        GROUP BY "userId";
      INSERT INTO "${HOLD_MARKER_TABLE}" ("userId", "releasedAt", "releaseAt", "extendedUntil") VALUES
        (130, NULL, NULL, NULL),
        (131, '2026-01-01', NULL, NULL),
        (132, NULL, now() - interval '1 day', NULL),
        (133, '2026-01-01', NULL, NULL),
        (134, NULL, now() - interval '1 day', now() + interval '1 day');
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "details") VALUES (133, NULL, '{}');
    `);
  });

  afterAll(async () => {
    await db.exec(`DROP VIEW IF EXISTS "${HOLD_MARKER_VIEW}"; DROP TABLE "${HOLD_MARKER_TABLE}"`);
  });

  it('refuses a user the marker view holds', async () => {
    const id = USERS.held.id;

    expect(await clear(id)).toEqual({ ok: false, reason: 'held' });
    expect(await flagged(id)).toHaveLength(3);
  });

  it('is skipped by the update itself', async () => {
    const kysely = dbHandle.current as Kysely<never>;
    expect(await clearRemovedFlagsUnlessHeld(kysely as never, USERS.held.id, 'view')).toEqual([]);
  });

  // A released marker is how Legal lets a user go; the view is the one definition of held.
  it('clears a user whose marker was released', async () => {
    expect(await clear(USERS.heldReleased.id)).toMatchObject({ ok: true, cleared: 2 });
  });

  it('clears a user whose marker expired unreleased', async () => {
    expect(await clear(USERS.heldExpired.id)).toMatchObject({ ok: true, cleared: 2 });
  });

  it('refuses a user whose expired marker was extended', async () => {
    expect(await clear(USERS.heldExtended.id)).toEqual({ ok: false, reason: 'held' });
  });

  // A release lets the marker go, never a report.
  it('refuses a user whose marker was released but who is named on a report', async () => {
    expect(await clear(USERS.releasedWithReport.id)).toEqual({ ok: false, reason: 'held' });
    expect(await flagged(USERS.releasedWithReport.id)).toHaveLength(3);
  });

  it('still clears a user with no hold', async () => {
    expect(await clear(USERS.otherClean.id)).toMatchObject({ ok: true, cleared: 2 });
  });

  it('refuses everyone while the table exists without its view', async () => {
    await db.exec(`DROP VIEW "${HOLD_MARKER_VIEW}"`);
    const id = USERS.driftProbe.id;

    expect(await clear(id)).toEqual({ ok: false, reason: 'held' });
    expect(await flagged(id)).toHaveLength(3);
  });
});
