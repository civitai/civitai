import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Which images `/api/held-media` serves (`heldImageSql`, shared with the main app's route). It
 * bypasses the public CDN, so the refusals are the point: anything wider is a way to read any image
 * past it. The main app runs the same fragment against the same rows in
 * `src/server/services/__tests__/held-media.service.test.ts`.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    throw new Error('eligibility must not write');
  },
}));

const { getHeldMedia } = await import('../held-media');

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'image',
  "mimeType" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "userId" INTEGER NOT NULL
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB,
  "archivedAt" TIMESTAMP(3), "reportSentAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHold" ("userId" INTEGER);
CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
`;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  // Owners: 201 nothing; 202 on an archived report sent long ago; 203 secondary on a report;
  // 204 nothing; 206 evidence hold; 207 nothing; 208 nothing, one image flagged; -1 the placeholder.
  await db.exec(`
    INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "url", "mimeType") VALUES
      (1, 201, 'csam', NULL, 'key-1', 'image/png'),
      (2, 202, NULL, NULL, 'key-2', NULL),
      (3, 203, NULL, NULL, 'key-3', NULL),
      (4, 204, NULL, NULL, 'key-4', NULL),
      (5, 204, 'minor', 'moderated', 'key-5', NULL),
      (7, 206, NULL, NULL, 'key-7', NULL),
      (8, -1, NULL, NULL, 'key-8', NULL),
      (9, -1, 'csam', NULL, 'key-9', NULL),
      (10, 207, NULL, 'CSAM', 'key-10', NULL),
      (11, 208, NULL, NULL, 'key-11', NULL),
      (12, 208, 'csam', NULL, 'key-12', NULL),
      (13, 202, NULL, 'AiNotVerified', 'key-13', NULL),
      (14, 201, 'csam', 'AiNotVerified', 'key-14', NULL);
    INSERT INTO "CsamReport" ("userId", "details", "archivedAt", "reportSentAt") VALUES
      (202, '{}', '2024-01-01', '2023-01-01'),
      (-1, '{"secondaryUserId": "203"}', NULL, NULL),
      (NULL, '{"secondaryUserId": "not-a-number"}', NULL, NULL);
    INSERT INTO "EvidenceHold" ("userId") VALUES (206);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const served = async (ids: number[]) => {
  const out: number[] = [];
  for (const id of ids) if (await getHeldMedia(id)) out.push(id);
  return out;
};

describe('held media eligibility', () => {
  it('serves a flagged image, and images of owners on any report or an evidence hold', async () => {
    expect(await served([1, 2, 3, 7, 10, 12])).toEqual([1, 2, 3, 7, 10, 12]);
    expect(await getHeldMedia(1)).toEqual({ url: 'key-1', type: 'image', mimeType: 'image/png' });
  });

  it('refuses an ordinary image, another queue, and a missing id', async () => {
    expect(await served([4, 5, 999])).toEqual([]);
  });

  it("does not open an owner's other images because one of them is flagged", async () => {
    expect(await served([11, 12])).toEqual([12]);
  });

  it('skips an AiNotVerified block on the owner legs, but not when the image itself is flagged', async () => {
    expect(await served([13, 14])).toEqual([14]);
  });

  it('never treats the placeholder owner as held, though a report names it', async () => {
    expect(await served([8, 9])).toEqual([9]);
  });

  // Last: it drops the view.
  it('refuses everything when the evidence-hold view is missing, rather than skipping that leg', async () => {
    await db.exec(`DROP VIEW "EvidenceHeldUser"`);
    await expect(getHeldMedia(4)).rejects.toThrow(/EvidenceHeldUser/);
  });
});
