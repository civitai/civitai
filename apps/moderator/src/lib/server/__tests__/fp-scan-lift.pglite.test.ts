import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';
import { SYSTEM_USER_ID } from '../users.service';

/**
 * A moderator's ruling on the scan's report on a Feature Pages comment, through the queue's own
 * service: only the per-report status action, set Unactioned, lifts the scan's hide.
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
// A dismissal pays no reporter: any reward write fails the test.
vi.mock('../clickhouse', () => ({
  getClickhouse: () => {
    throw new Error('a dismissal wrote a report reward');
  },
}));
vi.mock('../redis', () => ({
  getRedis: () => ({ sAdd: vi.fn(), sRem: vi.fn(), del: vi.fn(), set: vi.fn(), get: vi.fn() }),
}));

const { getReports, setReportStatus, setReportStatuses } = await import('../reports.service');

const AUTHOR = 10;
const MOD = 7;
const COMMENT = 500;
const SCAN_REPORT = 100;
const HIDDEN_AT = '2026-11-25 01:00:00.123456+00';

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "email" TEXT,
  "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3), "muted" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY, "reason" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "statusSetAt" TIMESTAMP(3), "statusSetBy" INTEGER,
  "userId" INTEGER NOT NULL, "details" JSONB, "internalNotes" TEXT, "alsoReportedBy" INTEGER[],
  "previouslyReviewedCount" INTEGER
);
${REPORT_ENTITIES.filter((e) => e.reportTable !== 'CommentV3Report')
  .map(
    (e) =>
      `CREATE TABLE IF NOT EXISTS "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER);`
  )
  .join('\n')}
CREATE TABLE "CommentV3Report" ("reportId" INTEGER PRIMARY KEY, "commentId" INTEGER NOT NULL);
CREATE TABLE "CommentV3" ("id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false, "hiddenAt" TIMESTAMPTZ(6), "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMPTZ(6), "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now());
CREATE TABLE "FeaturePageCommentMirror" ("commentId" INTEGER PRIMARY KEY, "version" INTEGER NOT NULL DEFAULT 1,
  "goneCause" TEXT, "removeWantedAt" TIMESTAMPTZ(6), "scanHiddenAt" TIMESTAMPTZ(6), "scanHiddenVersion" INTEGER, "scanHideReportId" INTEGER, "modHideOrigin" TEXT,
  "liftGrantedAt" TIMESTAMPTZ(6), "liftGrantedBy" INTEGER, "liftGrantedVersion" INTEGER,
  "nextPushAt" TIMESTAMPTZ(6), "leaseUntil" TIMESTAMPTZ(6), "pushAttempts" INTEGER NOT NULL DEFAULT 0, "pendingDigest" TEXT,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now());
CREATE TABLE "TextScanHold" ("entityType" TEXT, "entityId" INTEGER, "label" TEXT, "status" TEXT,
  "textHash" TEXT, "meta" JSONB);
CREATE TABLE "EntityModeration" ("entityType" TEXT, "entityId" INTEGER, "status" TEXT,
  "triggeredLabels" TEXT[], "result" JSONB);
CREATE TABLE "ModActivity" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL,
  "entityType" TEXT, "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "host" TEXT,
  "credential" TEXT, "reviewBatchId" TEXT, "reviewTier" TEXT, "reviewDeclared" BOOLEAN);
INSERT INTO "User" ("id", "username") VALUES (${AUTHOR}, 'author'), (${MOD}, 'mod'),
  (${SYSTEM_USER_ID}, 'civitai');
INSERT INTO "CommentV3" VALUES (${COMMENT}, 'featurePage', ${AUTHOR}, true, '${HIDDEN_AT}', false, NULL, now());
INSERT INTO "FeaturePageCommentMirror" ("commentId", "scanHiddenAt", "scanHiddenVersion", "scanHideReportId")
  VALUES (${COMMENT}, '${HIDDEN_AT}', 1, ${SCAN_REPORT});
INSERT INTO "Report" ("id", "reason", "userId", "details") VALUES
  (${SCAN_REPORT}, 'AdminAttention', ${SYSTEM_USER_ID}, '{"reason":"Other","comment":"auto-hidden by scan"}');
INSERT INTO "CommentV3Report" VALUES (${SCAN_REPORT}, ${COMMENT});
`;

let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const comment = async () =>
  (
    await db.query<{ hidden: boolean; liftGrantedBy: number | null }>(
      `SELECT c.hidden, m."liftGrantedBy" FROM "CommentV3" c
       JOIN "FeaturePageCommentMirror" m ON m."commentId" = c.id WHERE c.id = $1`,
      [COMMENT]
    )
  ).rows[0];

describe("the scan's report on a Feature Pages comment", () => {
  it('ruled Unactioned by a moderator, one report: the comment is shown again, and the queue says so', async () => {
    const result = await setReportStatus({
      id: SCAN_REPORT,
      status: 'Unactioned',
      userId: MOD,
      liftScanHide: true,
    });
    expect(result).toEqual({ ok: true, changed: true, lifted: true });
    expect(await comment()).toEqual({ hidden: false, liftGrantedBy: MOD });

    const { items } = await getReports({
      type: 'commentV3',
      statuses: ['Unactioned'] as never,
      reasons: 'all',
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: SCAN_REPORT,
        status: 'Unactioned',
        statusSetByUsername: 'mod',
        entityId: COMMENT,
      }),
    ]);
    expect(
      (
        await db.query(`SELECT "userId", "entityType", "entityId", activity FROM "ModActivity"
         WHERE activity = 'scanLift' ORDER BY id`)
      ).rows
    ).toEqual([
      { userId: MOD, entityType: 'commentV3', entityId: COMMENT, activity: 'scanLift' },
      { userId: MOD, entityType: 'report', entityId: SCAN_REPORT, activity: 'scanLift' },
    ]);
  });

  it('already Unactioned, then asked again (a replay or a stale tab): it stays hidden', async () => {
    await db.query(
      `UPDATE "Report" SET status = 'Unactioned', "statusSetBy" = $2, "statusSetAt" = now()
       WHERE id = $1`,
      [SCAN_REPORT, MOD]
    );
    expect(
      await setReportStatus({
        id: SCAN_REPORT,
        status: 'Unactioned',
        userId: MOD,
        liftScanHide: true,
      })
    ).toEqual({ ok: true, changed: false, lifted: false });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it("someone else's open report on it: refused with why, and the scan's report stays open", async () => {
    await db.query(
      `INSERT INTO "Report" ("id", "reason", "userId") VALUES (101, 'TOSViolation', ${AUTHOR})`
    );
    await db.query(`INSERT INTO "CommentV3Report" VALUES (101, ${COMMENT})`);
    expect(
      await setReportStatus({
        id: SCAN_REPORT,
        status: 'Unactioned',
        userId: MOD,
        liftScanHide: true,
      })
    ).toEqual({
      ok: false,
      held: true,
      error: expect.stringContaining('Rule on that report first'),
    });
    expect(
      (await db.query(`SELECT status FROM "Report" WHERE id = $1`, [SCAN_REPORT])).rows[0]
    ).toEqual({ status: 'Pending' });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it('a push holds the comment: refused with why, and the report stays open', async () => {
    await db.query(
      `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '1 minute'
       WHERE "commentId" = $1`,
      [COMMENT]
    );
    expect(
      await setReportStatus({
        id: SCAN_REPORT,
        status: 'Unactioned',
        userId: MOD,
        liftScanHide: true,
      })
    ).toEqual({ ok: false, held: true, error: expect.stringContaining('Try again in a minute') });
    expect(
      (await db.query(`SELECT status FROM "Report" WHERE id = $1`, [SCAN_REPORT])).rows[0]
    ).toEqual({ status: 'Pending' });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it('a banned author: refused with why, and the report stays open', async () => {
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    expect(
      await setReportStatus({
        id: SCAN_REPORT,
        status: 'Unactioned',
        userId: MOD,
        liftScanHide: true,
      })
    ).toEqual({ ok: false, held: true, error: expect.stringContaining('banned or muted') });
    expect(
      (await db.query(`SELECT status FROM "Report" WHERE id = $1`, [SCAN_REPORT])).rows[0]
    ).toEqual({ status: 'Pending' });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it("the scan's hide replaced since (ToS): it closes, nothing is shown, and the moderator is told", async () => {
    await db.query(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [COMMENT]);
    expect(
      await setReportStatus({
        id: SCAN_REPORT,
        status: 'Unactioned',
        userId: MOD,
        liftScanHide: true,
      })
    ).toEqual({
      ok: true,
      changed: true,
      lifted: false,
      notice: expect.stringContaining('hidden by another action'),
    });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it('ruled through the batch save: skipped with why, left open, and nothing lifted', async () => {
    await db.query(
      `INSERT INTO "Report" ("id", "reason", "userId") VALUES (102, 'TOSViolation', ${AUTHOR})`
    );
    expect(
      await setReportStatuses(
        [
          { id: SCAN_REPORT, status: 'Unactioned' as never },
          { id: 102, status: 'Unactioned' as never },
        ],
        { userId: MOD }
      )
    ).toEqual({
      changed: 1,
      unchanged: 0,
      skipped: 1,
      failed: [{ id: SCAN_REPORT, error: 'Scan-hidden reports must be dismissed one at a time.' }],
    });
    expect(
      (await db.query(`SELECT status FROM "Report" WHERE id = $1`, [SCAN_REPORT])).rows[0]
    ).toEqual({ status: 'Pending' });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it('ruled by a caller that does not ask: it stays hidden', async () => {
    expect(await setReportStatus({ id: SCAN_REPORT, status: 'Unactioned', userId: MOD })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });

  it('ruled Actioned, or by the system user: it stays hidden', async () => {
    await setReportStatus({ id: SCAN_REPORT, status: 'Actioned', userId: MOD, liftScanHide: true });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });

    await db.query(`UPDATE "Report" SET status = 'Pending' WHERE id = $1`, [SCAN_REPORT]);
    await setReportStatus({
      id: SCAN_REPORT,
      status: 'Unactioned',
      userId: SYSTEM_USER_ID,
      liftScanHide: true,
    });
    expect(await comment()).toEqual({ hidden: true, liftGrantedBy: null });
  });
});
