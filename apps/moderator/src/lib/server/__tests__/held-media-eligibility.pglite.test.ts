import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Which images `/api/held-media` serves. It bypasses the public CDN, so the refusals are the point:
 * an image is served only while it is in the CSAM queue or its owner is held by a CSAM report or an
 * evidence hold. Anything wider is a way to read any image past the CDN.
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
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "bannedAt" TIMESTAMP(3), "meta" JSONB);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'image',
  "mimeType" TEXT,
  "needsReview" TEXT,
  "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
  "userId" INTEGER NOT NULL
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB, "images" JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE "EvidenceHold" ("userId" INTEGER);
CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
`;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  // 201 nothing; 202 reported; 203 secondary on a report; 204 nothing; 205 banned for a reason that
  // holds a bulk clear, with no report; 206 evidence hold.
  await db.exec(`
    INSERT INTO "User" ("id") VALUES (201), (202), (203), (204), (205), (206);
    UPDATE "User" SET "bannedAt" = '2026-01-01',
      "meta" = '{"banDetails": {"reasonCode": "SexualMinor"}}' WHERE id = 205;
    INSERT INTO "Image" ("id", "userId", "needsReview", "url", "mimeType") VALUES
      (1, 201, 'csam', 'key-1', 'image/png'),
      (2, 202, NULL, 'key-2', NULL),
      (3, 203, NULL, 'key-3', NULL),
      (4, 204, NULL, 'key-4', NULL),
      (5, 204, 'minor', 'key-5', NULL),
      (6, 205, NULL, 'key-6', NULL),
      (7, 206, NULL, 'key-7', NULL),
      (8, -1, NULL, 'key-8', NULL),
      (9, -1, 'csam', 'key-9', NULL);
    -- The second report names the placeholder owner of deleted accounts' kept content.
    INSERT INTO "CsamReport" ("userId", "details") VALUES
      (202, '{}'), (-1, '{"secondaryUserId": "203"}');
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
  it('serves the CSAM queue and images of owners held by a report or an evidence hold', async () => {
    expect(await served([1, 2, 3, 7])).toEqual([1, 2, 3, 7]);
    expect(await getHeldMedia(1)).toEqual({ url: 'key-1', type: 'image', mimeType: 'image/png' });
  });

  it('refuses an ordinary image, another queue, a missing id, and a ban that is not a CSAM hold', async () => {
    expect(await served([4, 5, 6, 999])).toEqual([]);
  });

  it('never treats the placeholder owner as held, though a report names it', async () => {
    expect(await served([8, 9])).toEqual([9]);
  });

  // Last: it drops the view. Without the view `flagClearHoldLegs` holds EVERY user, which for a bulk
  // clear fails closed and here would open every image.
  it('opens nothing more when the hold-marker view is missing', async () => {
    await db.exec(`DROP VIEW "EvidenceHeldUser"`);
    expect(await served([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([1, 2, 3, 9]);
  });
});
