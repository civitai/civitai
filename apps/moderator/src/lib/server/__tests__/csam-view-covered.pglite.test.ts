import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The covered view: which held and blocked media a moderator without the CSAM page's grant is served.
 * Reported bytes are the line: an image listed on any CsamReport, sent or pending, or sharing a url
 * with a listed image or listed moderator delete, or carrying a listed image's pHash, is refused.
 * Everything else the routes hold back from such a moderator today is served.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    throw new Error('the covered view reads the primary');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../blocked-for-patterns', () => ({ blockedForPatterns: () => null }));
const env = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => env);
const logToAxiom = vi.hoisted(() => vi.fn(async (_line: Record<string, unknown>) => {}));
vi.mock('../axiom', () => ({ logToAxiom }));
vi.mock('../mod-activity', () => ({ insertModActivity: vi.fn(), recordModActivity: vi.fn() }));
vi.mock('../review-batch', () => ({ readScannerVerdict: async () => 'none' }));

const { getCoveredHeldMedia, getCoveredRetractedMedia, COVERED_REFUSED } = await import(
  '../csam-view'
);

const MOD = 900;
const NOT_MOD = 901;
const LISTED_PHASH = 7777;

const SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'image', "mimeType" TEXT,
  ingestion TEXT NOT NULL DEFAULT 'Scanned', "needsReview" TEXT, "blockedFor" TEXT,
  minor BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 4, "pHash" BIGINT, "userId" INTEGER NOT NULL, "postId" INTEGER
);
CREATE TABLE "Post" (id INTEGER PRIMARY KEY, metadata JSONB, "modelVersionId" INTEGER);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, meta JSONB, "modelId" INTEGER);
CREATE TABLE "Model" (id INTEGER PRIMARY KEY, meta JSONB);
CREATE TABLE "User" (id INTEGER PRIMARY KEY, meta JSONB, "isModerator" BOOLEAN);
CREATE TABLE "ImageCdnAccess" (url TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE "ImageCdnModeratorDelete" (
  "imageId" INTEGER PRIMARY KEY, url TEXT NOT NULL, "userId" INTEGER, "csamReview" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "ImageCdnShopTakedown" (url TEXT NOT NULL, "shopItemId" INTEGER NOT NULL, "userId" INTEGER);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, disabled BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "BlockedImage" (hash BIGINT, reason TEXT);
CREATE TABLE "ScanLabelItem" (id INTEGER PRIMARY KEY, "imageId" INTEGER, "voidReason" TEXT);
CREATE TABLE "ScanLabelFlag" ("itemId" INTEGER, snapshot JSONB);
CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, reason TEXT);
CREATE TABLE "CsamReport" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB, images JSONB, "reportSentAt" TIMESTAMP,
  "archivedAt" TIMESTAMP
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "EvidenceHoldImage" ("imageId" INTEGER PRIMARY KEY);
`;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, meta, "isModerator") VALUES (${MOD}, '{}', true), (${NOT_MOD}, '{}', false);

    -- Held (flagged for CSAM review), one fact each.
    INSERT INTO "Image" (id, url, "userId", "needsReview", "pHash") VALUES
      (101, 'key-101', 501, 'csam', NULL),            -- listed, report pending
      (102, 'key-102', 502, 'csam', ${LISTED_PHASH}), -- listed, report sent
      (103, 'key-103', 503, 'csam', NULL),            -- owner named on a report, image not listed
      (104, 'key-104', 504, 'csam', NULL),            -- shares its url with 105, which is listed
      (105, 'key-104', 505, NULL, NULL),
      (106, 'key-106', 506, 'csam', NULL),            -- a listed moderator delete on its url
      (107, 'key-107', 507, 'csam', ${LISTED_PHASH}), -- a listed image's pHash, on another url
      (108, 'key-108', 508, 'csam', 8888),            -- a moderator CSAM block's hash, not listed
      (109, 'key-109', 509, 'csam', 9999),            -- nothing else
      (110, 'key-110', 510, 'csam', NULL),            -- listed as a bare number
      (111, 'key-111', 511, 'csam', NULL),            -- listed as a string
      (112, 'key-112', 512, 'csam', NULL),            -- listed on an archived report
      (113, 'key-113', 513, 'csam', NULL);            -- under an evidence hold
    INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId") VALUES (906, 'key-106', 606);
    INSERT INTO "BlockedImage" (hash, reason) VALUES (8888, 'CSAM');

    -- Blocked, one fact each. None is listed unless said.
    INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor", minor, "needsReview", "pHash") VALUES
      (201, 'key-201', 601, 'Blocked', 'moderated', false, NULL, NULL), -- no scanner verdict
      (202, 'key-202', 602, 'Blocked', 'moderated', true, NULL, NULL),  -- a minor signal only
      (203, 'key-203', 603, 'Blocked', 'moderated', false, NULL, NULL), -- listed, report pending
      (204, 'key-204', 604, 'Blocked', 'moderated', false, NULL, NULL), -- under an evidence hold
      (205, 'key-205', 605, 'Blocked', 'moderated', false, 'csam', NULL), -- held media
      (206, 'key-206', 606, 'Blocked', 'moderated', false, NULL, ${LISTED_PHASH}); -- listed pHash
    INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (204), (113);

    -- The CDN-refusal leg: scanned, its url retracted. One fact each.
    INSERT INTO "Image" (id, url, "userId", ingestion) VALUES
      (301, 'key-301', 701, 'Scanned'), -- its owner held, so its url is held
      (302, 'key-302', 702, 'Scanned'), -- another row shares its url
      (312, 'key-302', 712, 'Scanned'),
      (303, 'key-303', 703, 'Scanned'), -- a moderator delete, not listed, on its url
      (304, 'key-304', 704, 'Scanned'), -- listed, report pending
      (305, 'key-305', 705, 'Scanned'); -- its url not retracted
    INSERT INTO "ImageCdnAccess" (url, state) VALUES
      ('key-301', 'Retracted'), ('key-302', 'Retracted'), ('key-303', 'Retracted'),
      ('key-304', 'Retracted'), ('key-305', 'Denied');
    INSERT INTO "EvidenceHeldUser" ("userId") VALUES (701);
    INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId") VALUES (913, 'key-303', 713);

    INSERT INTO "CsamReport" ("userId", details, images, "reportSentAt") VALUES
      (501, '{}', '[{"id": 101}, {"id": 105}, {"id": 906}, {"id": 203}, {"id": 304}]', NULL),
      -- Entries that are not ids list nothing, and break nothing.
      (510, '{}', '[110, "111", "abc", {"id": "x"}, {"id": null}, null]', NULL),
      (502, '{"evidenceVerifiedAt": "2026-10-20T12:00:00Z"}', '[{"id": 102}]', now()),
      (503, '{}', '[]', NULL);
    INSERT INTO "CsamReport" ("userId", details, images, "archivedAt") VALUES
      (512, '{}', '[{"id": 112}]', now());
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const held = (id: number, mod = MOD) => getCoveredHeldMedia(id, mod);
const retracted = (id: number, mod = MOD) => getCoveredRetractedMedia(id, mod);

describe('reported bytes are refused', () => {
  it.each([
    [101, 'listed on a pending report'],
    [102, 'listed on a sent report'],
    [104, 'its url carries a listed image'],
    [106, 'its url carries a listed moderator delete'],
    [107, "it has a listed image's pHash"],
    [110, 'listed as a bare number'],
    [111, 'listed as a string'],
    [112, 'listed on an archived report'],
  ])('held %i: %s', async (id) => {
    expect(await held(id)).toBe(COVERED_REFUSED);
  });

  it.each([
    [203, 'listed on a pending report'],
    [206, "it has a listed image's pHash"],
  ])('blocked %i: %s', async (id) => {
    expect(await retracted(id)).toBe(COVERED_REFUSED);
  });
});

describe('everything else is served', () => {
  it.each([
    [103, 'its owner is named on a report'],
    [108, "it matches a moderator's CSAM block that no report lists"],
    [109, 'held, nothing reported'],
  ])('held %i: %s', async (id) => {
    expect(await held(id)).toEqual({ url: `key-${id}`, type: 'image', mimeType: null });
  });

  it.each([
    [201, 'no scanner verdict'],
    [202, 'a minor signal, never reported'],
    [205, 'held media'],
  ])('blocked %i: %s', async (id) => {
    expect(await retracted(id)).toMatchObject({ url: `key-${id}` });
  });
});

describe('on the CDN-refusal leg', () => {
  beforeAll(() => {
    env.env.RETRACTED_MEDIA_CDN_LEG = 'true';
  });
  afterAll(() => {
    delete env.env.RETRACTED_MEDIA_CDN_LEG;
  });

  it('serves a retracted url its owner hold would keep from everyone else', async () => {
    expect(await retracted(301)).toMatchObject({ url: 'key-301' });
  });

  it('refuses a listed image', async () => {
    expect(await retracted(304)).toBe(COVERED_REFUSED);
  });

  it.each([
    [302, 'another row shares its url'],
    [303, 'a moderator delete is on its url'],
    [305, 'its url is not retracted'],
  ])('does not cover %i: %s', async (id) => {
    expect(await retracted(id)).toBeNull();
  });
});

describe('who', () => {
  it('a user who is not a moderator is not covered', async () => {
    expect(await held(109, NOT_MOD)).toBeNull();
    expect(await retracted(201, NOT_MOD)).toBeNull();
  });

  it('an image under an evidence hold, a legal one included, is never covered', async () => {
    expect(await held(113)).toBeNull();
    expect(await retracted(204)).toBeNull();
  });

  it('an image neither route holds is not covered', async () => {
    expect(await held(105)).toBeNull();
  });
});

describe('the read', () => {
  it('runs under a 2s statement timeout, in the same transaction', async () => {
    const query = db.query.bind(db);
    const seen: string[] = [];
    const spy = vi.spyOn(db, 'query').mockImplementation(((text: string, ...rest: unknown[]) => {
      seen.push(text.trim().split(/\s+/).join(' '));
      return (query as (...a: unknown[]) => unknown)(text, ...rest);
    }) as PGlite['query']);
    try {
      await held(109);
    } finally {
      spy.mockRestore();
    }
    const set = seen.indexOf("SET LOCAL statement_timeout = '2s'");
    expect(seen.slice(set - 1, set + 3)).toEqual([
      expect.stringMatching(/^begin/i),
      "SET LOCAL statement_timeout = '2s'",
      expect.stringMatching(/^select .* from "Image" as "i"/i),
      expect.stringMatching(/^commit/i),
    ]);
  });

  it('refuses when the read fails', async () => {
    const spy = vi
      .spyOn(db, 'query')
      .mockRejectedValue(new Error('canceling statement due to statement timeout'));
    try {
      expect(await held(109)).toBe(COVERED_REFUSED);
      expect(await retracted(201)).toBe(COVERED_REFUSED);
    } finally {
      spy.mockRestore();
    }
  });
});
