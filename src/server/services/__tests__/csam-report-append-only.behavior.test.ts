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
  '../../../../packages/civitai-db-schema/prisma/migrations/20261111120000_csam_report_append_only/migration.sql'
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
  return rows[0].id;
}

const audit = async (id: number) =>
  (
    await db.pg.query<{ op: string; oldDetails: unknown }>(
      `SELECT op, "oldDetails" FROM "CsamReportAudit" WHERE "csamReportId" = $1 ORDER BY id`,
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
  await db.pg.exec(`DELETE FROM "CsamReportAudit";`);
});

describe('an unsent report', () => {
  it('can be edited and deleted, and the delete is recorded', async () => {
    const id = await insertReport(null, { contents: ['a'] });
    await db.pg.query(`UPDATE "CsamReport" SET details = '{}', images = '[1]' WHERE id = $1`, [id]);
    await db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);

    expect(await exists(id)).toBe(false);
    expect(await audit(id)).toEqual([{ op: 'delete', oldDetails: {} }]);
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

  it.each([
    ['nulled details', `details = 'null'`],
    ['emptied details', `details = '{}'`],
    ['a removed key', `details = details - 'contents'`],
    ['a changed value', `details = '{"contents": ["b"]}'`],
    ['a cleared send time', `"reportSentAt" = NULL`],
    ['a changed owner', `"userId" = ${UNRELATED}`],
    ['changed images', `images = '[{"id": 1}]'`],
    ['a changed external report id', `"reportId" = 901`],
  ])('refuses %s, recording nothing', async (_case, set) => {
    const id = await insertReport(30, { contents: ['a'] });
    await expect(db.pg.exec(`UPDATE "CsamReport" SET ${set} WHERE id = ${id}`)).rejects.toThrow();
    expect(await audit(id)).toEqual([]);
  });

  it('cannot be truncated', async () => {
    await insertReport(30);
    await expect(db.pg.exec(`TRUNCATE "CsamReport"`)).rejects.toThrow();
  });

  describe('deletion', () => {
    it('is refused within a year of sending', async () => {
      await createHoldView();
      const id = await insertReport(30);
      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow();
      expect(await exists(id)).toBe(true);
    });

    it('is refused after a year while hold status cannot be read', async () => {
      const id = await insertReport(400);
      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow();
      expect(await exists(id)).toBe(true);
    });

    it('is allowed after a year with no hold, and recorded', async () => {
      await createHoldView();
      await db.pg.exec(`INSERT INTO "HeldUserFixture" VALUES (${UNRELATED})`);
      const id = await insertReport(400, { contents: ['a'] });

      await db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id]);

      expect(await exists(id)).toBe(false);
      expect(await audit(id)).toEqual([{ op: 'delete', oldDetails: { contents: ['a'] } }]);
    });

    it.each([
      ['its subject', SUBJECT],
      ['its secondary user', SECONDARY],
    ])('is refused after a year while %s is held', async (_case, heldUser) => {
      await createHoldView();
      await db.pg.exec(`INSERT INTO "HeldUserFixture" VALUES (${heldUser})`);
      const id = await insertReport(400, { secondaryUserId: SECONDARY });

      await expect(db.pg.query(`DELETE FROM "CsamReport" WHERE id = $1`, [id])).rejects.toThrow();
      expect(await exists(id)).toBe(true);
    });
  });
});
