import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A sent CSAM report is append-only, and every change to one is recorded. Runs the migration itself
 * against a Postgres stand-in.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations/20261112120000_csam_report_append_only/migration.sql'
);

const db = { pg: null as unknown as PGlite };

const SUBJECT = 21;
const SECONDARY = 22;
const UNRELATED = 23;

async function createHoldView() {
  await db.pg.exec(`
    CREATE TABLE "HeldUserFixture" ("userId" int PRIMARY KEY);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId", NULL::timestamp AS "heldUntil" FROM "HeldUserFixture";
  `);
}

async function dropHoldView() {
  await db.pg.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "HeldUserFixture";
  `);
}

async function insertReport(sentDaysAgo: number | null, details: object | null = {}) {
  const { rows } = await db.pg.query<{ id: number }>(
    `INSERT INTO "CsamReport" ("userId", "reportedById", "reportSentAt", "reportId", details)
     VALUES ($1, 1, CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) END,
       CASE WHEN $2::int IS NULL THEN NULL ELSE 900 END, $3::jsonb)
     RETURNING id`,
    [SUBJECT, sentDaysAgo, JSON.stringify(details)]
  );
  const id = rows[0].id;
  const sent = await db.pg.query<{ at: string | null }>(
    `SELECT "reportSentAt"::text AS at FROM "CsamReport" WHERE id = $1`,
    [id]
  );
  sentAt.set(id, sent.rows[0].at);
  return id;
}

const audit = async (id: number) =>
  (
    await db.pg.query<{ op: string; oldDetails: unknown }>(
      `SELECT op, "oldDetails" FROM "CsamReportAudit" WHERE "csamReportId" = $1 ORDER BY id`,
      [id]
    )
  ).rows;

/** The audit's record of the send time matches the report's own. */
const auditedSendTimes = async (id: number) =>
  (
    await db.pg.query<{ recorded: boolean }>(
      `SELECT a."oldReportSentAt" IS NOT DISTINCT FROM $2::timestamp(3) AS recorded
       FROM "CsamReportAudit" a WHERE a."csamReportId" = $1 ORDER BY a.id`,
      [id, sentAt.get(id) ?? null]
    )
  ).rows.map((r) => r.recorded);

const sentAt = new Map<number, string | null>();

const auditIdentity = async (id: number) =>
  (
    await db.pg.query(
      `SELECT "oldUserId", "oldReportId", "oldType", "oldImageCount"
       FROM "CsamReportAudit" WHERE "csamReportId" = $1 ORDER BY id`,
      [id]
    )
  ).rows;

const exists = async (id: number) =>
  (await db.pg.query(`SELECT 1 FROM "CsamReport" WHERE id = $1`, [id])).rows.length === 1;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CsamReportType" AS ENUM ('Image', 'TrainingData', 'GeneratedImage', 'ExternalLink');
    CREATE TABLE "CsamReport" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "reportedById" INTEGER NOT NULL,
      "reportSentAt" TIMESTAMP(3),
      "archivedAt" TIMESTAMP(3),
      "contentRemovedAt" TIMESTAMP(3),
      "reportId" INTEGER,
      "details" JSONB NOT NULL DEFAULT '{}',
      "images" JSONB NOT NULL DEFAULT '[]',
      "type" "CsamReportType" NOT NULL DEFAULT 'Image'
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await dropHoldView();
  // Audit rows cannot be removed; each case reads only its own report's rows.
});

describe('an unsent report', () => {
  it('can be edited and deleted, and the delete is recorded', async () => {
    const id = await insertReport(null, { contents: ['a'] });
    await db.pg.query(`UPDATE "CsamReport" SET details = '{}', images = '[1]' WHERE id = $1`, [id]);
    await db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);

    expect(await exists(id)).toBe(false);
    expect(await audit(id)).toEqual([{ op: 'delete', oldDetails: null }]);
    expect(await auditIdentity(id)).toEqual([
      { oldUserId: SUBJECT, oldReportId: null, oldType: 'Image', oldImageCount: 1 },
    ]);
  });

  it('can be sent, setting details in the same update', async () => {
    const id = await insertReport(null, { modelVersionIds: [1] });
    await db.pg.query(
      `UPDATE "CsamReport" SET "reportSentAt" = now(), "reportId" = 5,
        details = details || '{"trainingData": []}' WHERE id = $1`,
      [id]
    );
    expect(await audit(id)).toEqual([]);
  });
});

describe('a sent report', () => {
  it('accepts details that only gain keys, and the archive stamps, recording each', async () => {
    const id = await insertReport(30, { contents: ['a'] });
    await db.pg.query(
      `UPDATE "CsamReport" SET details = details || '{"archiveSkipped": "x"}' WHERE id = $1`,
      [id]
    );
    await db.pg.query(`UPDATE "CsamReport" SET "archivedAt" = now() WHERE id = $1`, [id]);

    expect(await audit(id)).toEqual([
      { op: 'update', oldDetails: { contents: ['a'] } },
      { op: 'update', oldDetails: { contents: ['a'], archiveSkipped: 'x' } },
    ]);
  });

  it('accepts an object over details that hold nothing', async () => {
    const id = await insertReport(30, null);
    await db.pg.query(`UPDATE "CsamReport" SET details = '{"restored": true}' WHERE id = $1`, [id]);
    expect(await audit(id)).toEqual([{ op: 'update', oldDetails: null }]);
  });

  it('refuses a non-object over details that hold nothing', async () => {
    const id = await insertReport(30, null);
    await expect(
      db.pg.query(`UPDATE "CsamReport" SET details = '[1]' WHERE id = $1`, [id])
    ).rejects.toThrow('may only gain keys');
    expect(await audit(id)).toEqual([]);
  });

  it.each([
    ['nulled details', `details = 'null'`, 'may only gain keys'],
    ['emptied details', `details = '{}'`, 'may only gain keys'],
    ['a removed key', `details = details - 'contents'`, 'may only gain keys'],
    ['a changed value', `details = '{"contents": ["b"]}'`, 'may only gain keys'],
    ['a cleared send time', `"reportSentAt" = NULL`, 'was sent; only details'],
    [
      'a moved send time',
      `"reportSentAt" = "reportSentAt" - interval '400 days'`,
      'was sent; only details',
    ],
    ['a changed owner', `"userId" = ${UNRELATED}`, 'was sent; only details'],
    ['a cleared owner', `"userId" = NULL`, 'was sent; only details'],
    ['a changed reporter', `"reportedById" = 2`, 'was sent; only details'],
    [
      'a changed creation time',
      `"createdAt" = "createdAt" - interval '1 day'`,
      'was sent; only details',
    ],
    ['a changed type', `type = 'TrainingData'`, 'was sent; only details'],
    ['a changed id', `id = id + 100000`, 'was sent; only details'],
    ['changed images', `images = '[{"id": 1}]'`, 'was sent; only details'],
    ['a changed external report id', `"reportId" = 901`, 'was sent; only details'],
    ['a cleared external report id', `"reportId" = NULL`, 'was sent; only details'],
  ])('refuses %s, recording nothing', async (_case, set, message) => {
    const id = await insertReport(30, { contents: ['a'] });
    await expect(db.pg.exec(`UPDATE "CsamReport" SET ${set} WHERE id = ${id}`)).rejects.toThrow(
      message
    );
    expect(await audit(id)).toEqual([]);
  });

  it('records the send time of each change it allows', async () => {
    const id = await insertReport(30);
    await db.pg.query(`UPDATE "CsamReport" SET "archivedAt" = now() WHERE id = $1`, [id]);
    expect(await auditedSendTimes(id)).toEqual([true]);
    expect(await auditIdentity(id)).toEqual([
      { oldUserId: SUBJECT, oldReportId: 900, oldType: 'Image', oldImageCount: 0 },
    ]);
  });

  it('cannot be truncated', async () => {
    await insertReport(30);
    await expect(db.pg.exec(`TRUNCATE "CsamReport"`)).rejects.toThrow('cannot be truncated');
  });

  it.each([
    ['changed', `UPDATE "CsamReportAudit" SET op = 'x'`],
    ['deleted', `DELETE FROM "CsamReportAudit"`],
    ['truncated', `TRUNCATE "CsamReportAudit"`],
  ])('keeps its audit rows: they cannot be %s', async (_case, statement) => {
    const id = await insertReport(30);
    await db.pg.query(`UPDATE "CsamReport" SET "archivedAt" = now() WHERE id = $1`, [id]);
    await expect(db.pg.exec(statement)).rejects.toThrow('cannot be changed or removed');
    expect(await audit(id)).toHaveLength(1);
  });

  describe('deletion', () => {
    it('is refused within a year of sending', async () => {
      await createHoldView();
      const id = await insertReport(30);
      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow(
        'less than a year ago'
      );
      expect(await exists(id)).toBe(true);
    });

    it.each([
      [364, false],
      [367, true],
    ])('at %i days after sending, with no hold, is allowed: %s', async (days, allowed) => {
      await createHoldView();
      const id = await insertReport(days);
      const deleting = db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);
      if (allowed) await deleting;
      else await expect(deleting).rejects.toThrow('less than a year ago');
      expect(await exists(id)).toBe(!allowed);
    });

    it('is refused after a year while hold status cannot be read', async () => {
      const id = await insertReport(400);
      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow(
        'hold status is unavailable'
      );
      expect(await exists(id)).toBe(true);
    });

    it('is allowed after a year with no hold, and recorded', async () => {
      await createHoldView();
      await db.pg.exec(`INSERT INTO "HeldUserFixture" VALUES (${UNRELATED})`);
      const id = await insertReport(400, { contents: ['a'] });

      await db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);

      expect(await exists(id)).toBe(false);
      expect(await audit(id)).toEqual([{ op: 'delete', oldDetails: null }]);
      const { rows } = await db.pg.query(
        `SELECT "oldUserId", "oldReportId", "oldType", "oldImageCount"
         FROM "CsamReportAudit" WHERE "csamReportId" = $1`,
        [id]
      );
      expect(rows).toEqual([
        { oldUserId: SUBJECT, oldReportId: 900, oldType: 'Image', oldImageCount: 0 },
      ]);
      expect(await auditedSendTimes(id)).toEqual([true]);
    });

    it('is allowed after a year when neither the subject nor the secondary user is held', async () => {
      await createHoldView();
      await db.pg.exec(`INSERT INTO "HeldUserFixture" VALUES (${UNRELATED})`);
      const id = await insertReport(400, { secondaryUserId: SECONDARY });

      await db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);

      expect(await exists(id)).toBe(false);
    });

    it.each([
      ['its subject', SUBJECT],
      ['its secondary user', SECONDARY],
    ])('is refused after a year while %s is held', async (_case, heldUser) => {
      await createHoldView();
      await db.pg.exec(`INSERT INTO "HeldUserFixture" VALUES (${heldUser})`);
      const id = await insertReport(400, { secondaryUserId: SECONDARY });

      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow(
        'under an evidence hold'
      );
      expect(await exists(id)).toBe(true);
    });
  });
});
