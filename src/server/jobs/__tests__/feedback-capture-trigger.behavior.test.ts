import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import {
  captureImageHeldSql,
  captureImageStateHeldSql,
} from '~/server/services/legal-hold.service';

/**
 * The image delete trigger as it is applied (20261019220000_evidence_hold and
 * 20261204120000_evidence_hold_image_prior_state), plus the feedback capture migrations: a capture
 * its own state keeps is kept, the record of a kept capture lasts as long as that state, the capture
 * account is never a report subject or hold owner, and nothing else about the functions changes.
 * Each case runs in a transaction that is rolled back.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');
const CAPTURE_MIGRATION = migration('20261231120100_feedback_capture_owner_hold');
const LIVE_KEEP_IMAGE = migration('20261204120000_evidence_hold_image_prior_state');
const LIVE_EVIDENCE_HOLD = migration('20261019220000_evidence_hold');
const NEVER_SUBJECT_MIGRATION = migration('20261231130000_feedback_capture_never_subject');
const LIFETIME_MIGRATION = migration('20261231130100_feedback_capture_hold_lifetime');
const OWNER_HELD_MIGRATION = migration('20261227150000_evidence_hold_owner_held');

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
const OTHER = 7;
const MARKED = 8;

const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    minor boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(LIVE_EVIDENCE_HOLD);
  await db.exec(LIVE_KEEP_IMAGE);
  await db.exec(CAPTURE_MIGRATION);
  await db.exec(NEVER_SUBJECT_MIGRATION);
  await db.exec(LIFETIME_MIGRATION);
  await db.exec(`
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED}, 'manual', 'test');
    INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor", minor) VALUES
      (1, ${CAPTURE}, 'csam', NULL, false),
      (2, ${CAPTURE}, NULL, 'CSAM', false),
      (3, ${CAPTURE}, NULL, NULL, true),
      (4, ${CAPTURE}, NULL, NULL, false),
      (5, ${CAPTURE}, NULL, NULL, false),
      (6, ${CAPTURE}, NULL, NULL, false),
      (10, ${OTHER}, 'csam', NULL, false),
      (11, ${OTHER}, NULL, NULL, false),
      (12, ${MARKED}, NULL, NULL, false);
    INSERT INTO "CsamReport" ("userId", images) VALUES (NULL, '[{"id": 4}]');
  `);
  await db.exec(`INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (5, ${CAPTURE})`);
});

beforeEach(async () => {
  await db.exec('BEGIN');
});
afterEach(async () => {
  await db.exec('ROLLBACK');
});

const present = async (id: number) =>
  (await db.query(`SELECT 1 FROM "Image" WHERE id = $1`, [id])).rows.length === 1;

describe('the image delete trigger', () => {
  it.each([
    ['under review', 1],
    ['blocked', 2],
    ['flagged minor', 3],
    ['listed on a report', 4],
    ['already kept by an evidence hold', 5],
  ])('keeps a capture %s', async (_label, id) => {
    await db.exec(`DELETE FROM "Image" WHERE id = ${id}`);
    expect(await present(id)).toBe(true);
    expect(
      (await db.query(`SELECT 1 FROM "EvidenceHoldImage" WHERE "imageId" = $1`, [id])).rows
    ).toHaveLength(1);
  });

  it('deletes a capture nothing keeps', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 6`);
    expect(await present(6)).toBe(false);
  });

  // The applied trigger holds only a marked owner's images; this migration must not widen that.
  it('still deletes an unmarked owner’s image under review, and keeps a marked owner’s', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id IN (10, 11, 12)`);
    expect(await present(10)).toBe(false);
    expect(await present(11)).toBe(false);
    expect(await present(12)).toBe(true);
  });

  it('keeps exactly what captureImageHeldSql keeps', async () => {
    const app = captureImageHeldSql('i');
    expect(app.values).toEqual([]);
    const { rows } = await db.query<{ id: number; fn: boolean; app: boolean }>(
      `SELECT i.id, evidence_hold_capture_held(i.id, i."needsReview", i."blockedFor", i.minor) AS fn,
         ${app.text} AS app
       FROM "Image" i WHERE i."userId" = $1 ORDER BY i.id`,
      [CAPTURE]
    );
    expect(rows.filter((r) => r.fn !== r.app)).toEqual([]);
    expect(rows.filter((r) => r.fn).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('20261231120100_feedback_capture_owner_hold', () => {
  const body = (sql: string) => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION evidence_hold_keep_image()');
    const end = sql.indexOf('$$ LANGUAGE plpgsql', start);
    return sql.slice(start, end);
  };

  // Written against the applied trigger, never against main's unapplied 20261227150000 functions.
  it('names nothing from the unapplied owner-held migration', () => {
    expect(CAPTURE_MIGRATION).not.toMatch(/owner_held/);
  });

  it('changes the applied trigger function only by the capture clause', () => {
    const ours = body(CAPTURE_MIGRATION).replace(
      /\n\s*OR \(OLD\."userId" = -2\n\s*AND evidence_hold_capture_held\([^)]*\)\)/,
      ''
    );
    expect(ours).toBe(body(LIVE_KEEP_IMAGE));
  });
});

describe('the record of a kept capture', () => {
  const recorded = async (id: number) =>
    (await db.query(`SELECT 1 FROM "EvidenceHoldImage" WHERE "imageId" = $1`, [id])).rows.length ===
    1;
  const sweep = () => db.exec('SELECT evidence_hold_purge_unheld()');

  it('outlives the sweep while the capture’s own state keeps it', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 3`);
    await sweep();
    expect(await recorded(3)).toBe(true);
  });

  it('cannot be deleted directly while that state keeps it', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 3`);
    await expect(db.exec(`DELETE FROM "EvidenceHoldImage" WHERE "imageId" = 3`)).rejects.toThrow(
      /while its image is held/
    );
  });

  it('goes at the next sweep once that state clears, and the capture can then be deleted', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 3`);
    await db.exec(`UPDATE "Image" SET minor = false WHERE id = 3`);
    await sweep();
    expect(await recorded(3)).toBe(false);
    await db.exec(`DELETE FROM "Image" WHERE id = 3`);
    expect(await present(3)).toBe(false);
  });

  it('goes at the sweep when the capture has no state of its own', async () => {
    await sweep();
    expect(await recorded(5)).toBe(false);
  });

  it('still goes at the sweep for an unheld owner that is not the capture account', async () => {
    await db.exec(`INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (10, ${OTHER})`);
    await sweep();
    expect(await recorded(10)).toBe(false);
  });

  it('holds exactly what captureImageStateHeldSql holds', async () => {
    const app = captureImageStateHeldSql('i');
    expect(app.values).toEqual([]);
    const { rows } = await db.query<{ id: number; fn: boolean; app: boolean }>(
      `SELECT i.id, evidence_hold_capture_state_held(i.id, i."needsReview", i."blockedFor", i.minor) AS fn,
         ${app.text} AS app
       FROM "Image" i WHERE i."userId" = $1 ORDER BY i.id`,
      [CAPTURE]
    );
    expect(rows.filter((r) => r.fn !== r.app)).toEqual([]);
    expect(rows.filter((r) => r.fn).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('the capture account as a subject', () => {
  it.each([
    ['a report subject', `INSERT INTO "CsamReport" ("userId") VALUES (${CAPTURE})`],
    [
      'a report’s secondary user',
      `INSERT INTO "CsamReport" ("userId", details) VALUES (${OTHER}, '{"secondaryUserId": ${CAPTURE}}')`,
    ],
    [
      'a report’s secondary user, as text',
      `INSERT INTO "CsamReport" ("userId", details) VALUES (${OTHER}, '{"secondaryUserId": "${CAPTURE}"}')`,
    ],
    [
      'an evidence hold owner',
      `INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${CAPTURE}, 'manual', 'test')`,
    ],
  ])('is refused as %s', async (_label, sql) => {
    await expect(db.exec(sql)).rejects.toThrow(/not_capture_owner_check/);
  });

  // A NULL subject and an empty details object are where IS DISTINCT FROM matters.
  it('leaves every other subject alone', async () => {
    await db.exec(`
      INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{}'), (${OTHER}, '{"secondaryUserId": ${MARKED}}');
      INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${OTHER}, 'manual', 'test');
    `);
    const { rows } = await db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM "CsamReport" WHERE "reportSentAt" IS NULL)::int AS n`
    );
    expect(rows[0].n).toBe(3);
  });

  it('applies again cleanly after a partial or repeated run', async () => {
    await expect(db.exec(NEVER_SUBJECT_MIGRATION)).resolves.toBeDefined();
    await expect(
      db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CAPTURE})`)
    ).rejects.toThrow(/not_capture_owner_check/);
  });

  it.each([
    ['a report subject', `INSERT INTO "CsamReport" ("userId") VALUES (${CAPTURE})`],
    [
      'a report’s secondary user',
      `INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{"secondaryUserId": ${CAPTURE}}')`,
    ],
    [
      'an evidence hold owner',
      `INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${CAPTURE}, 'manual', 'test')`,
    ],
  ])('is not applied over a row that already names it as %s', async (_label, seed) => {
    const fresh = new PGlite();
    try {
      await fresh.exec(BASE_SCHEMA);
      await fresh.exec(LIVE_EVIDENCE_HOLD);
      await fresh.exec(seed);
      await expect(fresh.exec(NEVER_SUBJECT_MIGRATION)).rejects.toThrow(/already name user -2/);
    } finally {
      await fresh.close();
    }
  });
});

// Deliberate drift pins: the migration must be the applied function plus the capture clause, so an
// edit to that clause updates the pattern here too.
describe('20261231130100_feedback_capture_hold_lifetime', () => {
  const fn = (sql: string, name: string, end: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    return sql.slice(start, sql.indexOf(end, start));
  };

  it('changes the applied sweep only by the capture clause', () => {
    const ours = fn(LIFETIME_MIGRATION, 'evidence_hold_purge_unheld', '$$ LANGUAGE sql').replace(
      /\n\s*-- Per row by primary key[^\n]*\n\s*AND NOT CASE WHEN i\."userId" = -2 THEN[\s\S]*?ELSE false END;/,
      ';'
    );
    expect(ours).toBe(fn(LIVE_EVIDENCE_HOLD, 'evidence_hold_purge_unheld', '$$ LANGUAGE sql'));
  });

  // PGlite runs the file as one implicit transaction, so this covers the single-transaction apply only.
  it('refuses to apply over 20261227150000, leaving its functions in place', async () => {
    const fresh = new PGlite();
    const defs = async () =>
      (
        await fresh.query<{ def: string }>(
          `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
           WHERE p.proname IN ('evidence_hold_purge_unheld', 'evidence_hold_guard_kept')
           ORDER BY p.proname`
        )
      ).rows.map((r) => r.def);
    try {
      await fresh.exec(BASE_SCHEMA);
      await fresh.exec(LIVE_EVIDENCE_HOLD);
      await fresh.exec(LIVE_KEEP_IMAGE);
      await fresh.exec(OWNER_HELD_MIGRATION);
      await fresh.exec(CAPTURE_MIGRATION);
      const before = await defs();
      expect(before.join()).toContain('evidence_hold_owner_held(');
      await expect(fresh.exec(LIFETIME_MIGRATION)).rejects.toThrow(/supersedes it/);
      expect(await defs()).toEqual(before);
    } finally {
      await fresh.close();
    }
  });

  it('makes 20261227150000 refuse to drop the capture clauses, leaving the functions in place', async () => {
    const fresh = new PGlite();
    const defs = async () =>
      (
        await fresh.query<{ def: string }>(
          `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
           WHERE p.proname IN ('evidence_hold_keep_image', 'evidence_hold_purge_unheld', 'evidence_hold_guard_kept')
           ORDER BY p.proname`
        )
      ).rows.map((r) => r.def);
    try {
      await fresh.exec(BASE_SCHEMA);
      await fresh.exec(LIVE_EVIDENCE_HOLD);
      await fresh.exec(LIVE_KEEP_IMAGE);
      await fresh.exec(CAPTURE_MIGRATION);
      await fresh.exec(NEVER_SUBJECT_MIGRATION);
      await fresh.exec(LIFETIME_MIGRATION);
      const before = await defs();
      expect(before).toHaveLength(3);
      await expect(fresh.exec(OWNER_HELD_MIGRATION)).rejects.toThrow(
        /does not yet carry the feedback capture clauses/
      );
      expect(await defs()).toEqual(before);
    } finally {
      await fresh.close();
    }
  });

  it('changes the applied record guard only by the capture clause', () => {
    const ours = fn(LIFETIME_MIGRATION, 'evidence_hold_guard_kept', '$$ LANGUAGE plpgsql').replace(
      /\n {2}IF TG_TABLE_NAME = 'EvidenceHoldImage' AND OLD\."userId" = -2 THEN[\s\S]*?\n {2}END IF;/,
      ''
    );
    expect(ours).toBe(fn(LIVE_EVIDENCE_HOLD, 'evidence_hold_guard_kept', '$$ LANGUAGE plpgsql'));
  });
});
