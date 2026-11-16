import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Which images `/api/retracted-media` serves, and to whom. The SQL is shared with the main app's
 * route, whose `retracted-media.service.test.ts` pins each leg; this pins this app's read of it and
 * the CSAM-review tier.
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
vi.mock('../blocked-for-patterns', () => ({ blockedForPatterns: () => null }));
const insertModActivity = vi.hoisted(() => vi.fn(async (_row: Record<string, unknown>) => {}));
vi.mock('../mod-activity', () => ({ insertModActivity }));

const { getRetractedMedia, recordRetractedView } = await import('../retracted-media');

const SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'image', "mimeType" TEXT,
  ingestion TEXT NOT NULL DEFAULT 'Blocked', "needsReview" TEXT, "blockedFor" TEXT,
  minor BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 4, "pHash" BIGINT, "userId" INTEGER NOT NULL
);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, disabled BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "BlockedImage" (hash BIGINT, reason TEXT);
CREATE TABLE "ScanLabelItem" (id INTEGER PRIMARY KEY, "imageId" INTEGER, "voidReason" TEXT);
CREATE TABLE "ScanLabelFlag" ("itemId" INTEGER, snapshot JSONB);
CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, reason TEXT);
CREATE TABLE "CsamReport" (id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB, images JSONB);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "EvidenceHoldImage" ("imageId" INTEGER PRIMARY KEY);
`;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview", "blockedFor", minor) VALUES
      (1, 'key-1', 301, 'Blocked', NULL, 'moderated', false),
      (2, 'key-2', 302, 'Blocked', NULL, 'moderated', true),
      (3, 'key-3', 303, 'Blocked', NULL, NULL, false),
      (4, 'key-4', 304, 'Blocked', 'csam', 'moderated', false),
      (5, 'key-5', 305, 'Scanned', NULL, NULL, false),
      (6, 'key-6', 306, 'Blocked', NULL, 'tos', false);
    INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (6);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const tierOf = async (id: number) => {
  const cleared = await getRetractedMedia(id, { csamReview: true });
  const anyMod = await getRetractedMedia(id, { csamReview: false });
  if (!cleared) return anyMod ? 'BROKEN' : 'none';
  return anyMod ? 'plain' : 'suspect';
};

describe('retracted media eligibility', () => {
  it('serves a blocked image with a known non-minor reason to any moderator', async () => {
    expect(await tierOf(1)).toBe('plain');
    expect(await getRetractedMedia(1, { csamReview: false })).toEqual({
      url: 'key-1',
      type: 'image',
      mimeType: null,
      tier: 'plain',
    });
  });

  it('keeps a minor signal or a block with no reason to moderators cleared for CSAM review', async () => {
    expect(await tierOf(2)).toBe('suspect');
    expect(await tierOf(3)).toBe('suspect');
  });

  it('never serves held media, an unblocked image, an evidence-held one or a missing id', async () => {
    for (const id of [4, 5, 6, 999])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
  });
});

describe('recordRetractedView', () => {
  // The main app's shown record looks for exactly this activity on the moderator's serve row.
  it("writes the moderator's serve row under the retracted-media activity", async () => {
    await recordRetractedView(42, 7);
    expect(insertModActivity).toHaveBeenCalledWith({
      userId: 42,
      entityType: 'image',
      entityId: 7,
      activity: 'retractedMedia:view',
    });
  });
});
