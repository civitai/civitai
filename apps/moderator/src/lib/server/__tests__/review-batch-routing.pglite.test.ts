import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Which images a review batch may show on the general tier (`suspectImageSql`, `unreadableImageSql`
 * and the blockedFor allowlist, shared with the main app's mint). Every image this lets through is
 * shown outside the held route, so the misses are the point: each signal leg is a row that must route
 * held, beside a twin that differs only in that leg and must not.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    throw new Error('routing must read the primary');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../redis', () => ({ getSysRedis: () => ({}) }));

process.env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS = '# signal\n^sig.*$\n# known-non-minor\n^benign$';
const { getBatchMedia } = await import('../review-batch');

const CHILD_TAG = 5351;

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'key',
  "type" TEXT NOT NULL DEFAULT 'image',
  "mimeType" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "userId" INTEGER NOT NULL DEFAULT 1,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "pHash" BIGINT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned'
);
CREATE TABLE "CsamReport" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB);
CREATE TABLE "EvidenceHold" ("userId" INTEGER);
CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE "BlockedImage" ("hash" BIGINT PRIMARY KEY, "reason" TEXT NOT NULL);
CREATE TABLE "ScanLabelItem" ("id" SERIAL PRIMARY KEY, "imageId" INTEGER UNIQUE, "voidReason" TEXT);
CREATE TABLE "ScanLabelFlag" ("itemId" INTEGER, "snapshot" JSONB);
CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, "userId" INTEGER, "reason" TEXT);
`;

// Pairs: the first id carries one leg and must route held; the second differs only there.
const CASES: [string, number, number][] = [
  ['heldImageSql (needsReview csam)', 10, 11],
  ['the minor flag', 20, 21],
  ['the minor review queue', 12, 11],
  ['an accepted minor', 22, 21],
  ['a child-type tag on a mature image', 30, 31],
  ['a child-type tag that is enabled', 32, 33],
  ['a child-type tag on an unrated image', 34, 31],
  ['a CSAM hash block', 40, 41],
  ['a scan flag reporting CSAM', 50, 51],
  ['a scan flag reporting a minor', 52, 51],
  ['a moderator vote naming a minor', 60, 61],
  ['a CSAM-realistic vote', 62, 61],
  ['a CSAM hold on the label item', 70, 71],
  ['a scan that has not finished', 80, 81],
  ['a blockedFor value matching no known-non-minor pattern', 90, 91],
  ['a blockedFor signal pattern', 92, 93],
];

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Image" ("id", "needsReview", "minor", "nsfwLevel", "pHash", "ingestion", "blockedFor") VALUES
      (10, 'csam', FALSE, 1, NULL, 'Scanned', NULL), (11, 'poi', FALSE, 1, NULL, 'Scanned', NULL),
      (12, 'minor', FALSE, 1, NULL, 'Scanned', NULL),
      (20, NULL, TRUE, 1, NULL, 'Scanned', NULL), (21, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (22, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (30, NULL, FALSE, 8, NULL, 'Scanned', NULL), (31, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (32, NULL, FALSE, 4, NULL, 'Scanned', NULL), (33, NULL, FALSE, 4, NULL, 'Scanned', NULL),
      (34, NULL, FALSE, 0, NULL, 'Scanned', NULL),
      (40, NULL, FALSE, 1, 4000, 'Scanned', NULL), (41, NULL, FALSE, 1, 4100, 'Scanned', NULL),
      (50, NULL, FALSE, 1, NULL, 'Scanned', NULL), (51, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (52, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (60, NULL, FALSE, 1, NULL, 'Scanned', NULL), (61, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (62, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (70, NULL, FALSE, 1, NULL, 'Scanned', NULL), (71, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (80, NULL, FALSE, 1, NULL, 'Pending', NULL), (81, NULL, FALSE, 1, NULL, 'Blocked', 'moderated'),
      (90, NULL, FALSE, 1, NULL, 'Blocked', 'never seen'), (91, NULL, FALSE, 1, NULL, 'Blocked', 'benign'),
      (92, NULL, FALSE, 1, NULL, 'Blocked', 'signal word'), (93, NULL, FALSE, 1, NULL, 'Blocked', 'tos');
    UPDATE "Image" SET "acceptableMinor" = TRUE WHERE id = 22;
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", "disabled") VALUES
      (30, ${CHILD_TAG}, FALSE), (31, ${CHILD_TAG}, FALSE),
      (32, ${CHILD_TAG}, FALSE), (33, ${CHILD_TAG}, TRUE), (34, ${CHILD_TAG}, FALSE);
    INSERT INTO "BlockedImage" ("hash", "reason") VALUES (4000, 'CSAM'), (4100, 'TOS');
    INSERT INTO "ScanLabelItem" ("id", "imageId", "voidReason") VALUES
      (500, 50, NULL), (510, 51, NULL), (520, 52, NULL), (600, 60, NULL), (610, 61, NULL),
      (620, 62, NULL), (700, 70, 'csam-hold'), (710, 71, 'other');
    INSERT INTO "ScanLabelFlag" ("itemId", "snapshot") VALUES
      (500, '{"csam": true, "minorDetected": false}'),
      (510, '{"csam": false, "minorDetected": false}'),
      (520, '{"csam": null, "minorDetected": true}');
    INSERT INTO "ScanLabelVote" ("itemId", "userId", "reason") VALUES
      (600, 9, 'minor-sexual'), (610, 9, 'real-person'), (620, 9, 'csam-realistic');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const batchOf = (id: number) => ({
  ids: [id],
  tier: 'general' as const,
  declared: false,
  viewer: 1,
  createdBy: 2,
  keyId: 3,
  seat: null,
  createdAt: 0,
});
const routesHeld = async (id: number) => (await getBatchMedia(batchOf(id), 0))?.held;

describe('review batch routing', () => {
  it.each(CASES)('%s routes held; its twin does not', async (_leg, held, twin) => {
    expect({ id: held, held: await routesHeld(held) }).toEqual({ id: held, held: true });
    expect({ id: twin, held: await routesHeld(twin) }).toEqual({ id: twin, held: false });
  });

  it('an image that is gone, or an index past the batch, gives nothing to serve', async () => {
    expect(await getBatchMedia(batchOf(999), 0)).toBeNull();
    expect(await getBatchMedia(batchOf(21), 1)).toBeNull();
  });
});
