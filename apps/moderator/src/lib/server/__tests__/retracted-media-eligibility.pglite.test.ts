import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSAM_LINK_TABLES_SQL,
  CSAM_RESTRICTION_CASES,
  csamCaseCleanupSql,
} from '../../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';
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
    throw new Error('eligibility reads the primary');
  },
  // Read only: the primary, so a hold the replica has not seen yet still counts.
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../blocked-for-patterns', () => ({ blockedForPatterns: () => null }));
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => envMock);
const insertModActivity = vi.hoisted(() => vi.fn(async (_row: Record<string, unknown>) => {}));
vi.mock('../mod-activity', () => ({ insertModActivity }));
const scanner = vi.hoisted(() => ({
  verdict: 'clear' as 'hit' | 'clear' | 'none' | null,
  hits: new Set<number>(),
}));
vi.mock('../review-batch', () => ({
  readScannerCsamVerdict: async (id: number) => (scanner.hits.has(id) ? 'hit' : scanner.verdict),
  readScannerCsamVerdicts: async (ids: number[]) =>
    scanner.verdict === null
      ? null
      : new Map(ids.map((id) => [id, scanner.hits.has(id) ? 'hit' : scanner.verdict])),
}));

const { getModeratorMedia, getRetractedMedia, recordRetractedView, scannerVerdicts } = await import(
  '../retracted-media'
);
const { URL_SIBLING_CAP } = await import('@civitai/shared/retracted-media-tier');
beforeEach(() => scannerVerdicts.clear());

const SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'image', "mimeType" TEXT,
  ingestion TEXT NOT NULL DEFAULT 'Blocked', "needsReview" TEXT, "blockedFor" TEXT,
  minor BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 4, "pHash" BIGINT, "userId" INTEGER NOT NULL, "postId" INTEGER
);
CREATE TABLE "Post" (id INTEGER PRIMARY KEY, metadata JSONB, "modelVersionId" INTEGER, "userId" INTEGER, "publishedAt" TIMESTAMP);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, meta JSONB, "modelId" INTEGER);
CREATE TABLE "Model" (id INTEGER PRIMARY KEY, meta JSONB);
CREATE TABLE "User" (id INTEGER PRIMARY KEY, meta JSONB);
-- An outright retraction by default; an upgraded deny sets "deniedAt" earlier.
CREATE TABLE "ImageCdnAccess" (
  url TEXT PRIMARY KEY, state TEXT NOT NULL,
  "deniedAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "retractedAt" TIMESTAMPTZ DEFAULT now()
);
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
  id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB, images JSONB, "reportSentAt" TIMESTAMP
);
CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, "textHash" TEXT, meta JSONB);
`;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(CSAM_LINK_TABLES_SQL);
  await db.exec(`
    INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview", "blockedFor", minor) VALUES
      (1, 'key-1', 301, 'Blocked', NULL, 'moderated', false),
      (31, 'key-31', 331, 'Blocked', NULL, 'moderated', false),
      (32, 'key-32', 332, 'Blocked', NULL, 'moderated', false),
      (2, 'key-2', 302, 'Blocked', NULL, 'moderated', true),
      (3, 'key-3', 303, 'Blocked', NULL, NULL, false),
      (4, 'key-4', 304, 'Blocked', 'csam', 'moderated', false),
      (5, 'key-5', 305, 'Scanned', NULL, NULL, false),
      (6, 'key-6', 306, 'Blocked', NULL, 'tos', false);

    -- The CDN-refusal leg. Each differs from 7 (scanned, url retracted, the url's only row) in one fact.
    INSERT INTO "Image" (id, url, "userId", ingestion, "postId", minor) VALUES
      (7, 'key-7', 307, 'Scanned', NULL, false),
      (28, 'key-28', 328, 'Scanned', NULL, false),
      (29, 'key-29', 329, 'Scanned', NULL, false),
      (30, 'key-30', 330, 'Scanned', NULL, false),
      (33, 'key-33', 333, 'Scanned', NULL, false),
      (8, 'key-8', 308, 'Scanned', NULL, false),
      (9, 'key-9', 309, 'Scanned', NULL, false),
      (10, 'key-10', 310, 'Pending', NULL, false),
      (11, 'key-11', 311, 'Error', NULL, false),
      (12, 'key-12', 312, 'Rescan', NULL, false),
      (13, 'key-13', 313, 'Scanned', 13, false),
      (14, 'key-14', 314, 'Scanned', 14, false),
      (15, 'key-15', 315, 'Scanned', 15, false),
      (16, 'key-16', 316, 'Scanned', NULL, false),
      (17, 'key-17', 317, 'Scanned', NULL, false),
      (18, 'key-18', 318, 'Scanned', NULL, false),
      (19, 'key-19', 319, 'Scanned', NULL, false),
      (119, 'key-19', 419, 'Scanned', NULL, true),
      (20, 'key-20', 320, 'Scanned', 20, false),
      (21, 'key-21', 321, 'Scanned', NULL, false),
      (23, 'key-23', 323, 'Scanned', NULL, false),
      (25, 'key-25', 325, 'Scanned', 25, false),
      (26, 'key-26', 326, 'Scanned', 26, false),
      (27, 'key-27', 327, 'Scanned', NULL, false),
      (24, 'key-24', 324, 'Scanned', NULL, false),
      (40, 'key-40', 340, 'Scanned', 40, true);
    INSERT INTO "ImageCdnAccess" (url, state) VALUES
      ('key-7', 'Retracted'), ('key-8', 'Denied'), ('key-10', 'Retracted'), ('key-11', 'Retracted'),
      ('key-12', 'Retracted'), ('key-13', 'Retracted'), ('key-14', 'Retracted'),
      ('key-15', 'Retracted'), ('key-16', 'Retracted'), ('key-17', 'Retracted'),
      ('key-18', 'Retracted'), ('key-19', 'Retracted'), ('key-20', 'Retracted'),
      ('key-21', 'Retracted'), ('key-23', 'Retracted'), ('key-24', 'Retracted'),
      ('key-25', 'Retracted'), ('key-26', 'Retracted'), ('key-27', 'Retracted'),
      ('key-40', 'Denied');
    INSERT INTO "ImageCdnAccess" (url, state, "deniedAt", "retractedAt") VALUES
      ('key-28', 'Retracted', now() - interval '5 minutes', now()), ('key-29', 'Retracted', now(), NULL),
      ('key-30', 'Retracted', now() - interval '30 seconds', now()),
      ('key-31', 'Retracted', now() - interval '30 seconds', now()),
      ('key-32', 'Retracted', now(), now()),
      -- Written before both stamps came from one expression: the retraction from the app's clock.
      ('key-33', 'Retracted', now(), now() - interval '5 milliseconds');
    INSERT INTO "Model" (id, meta) VALUES
      (15, '{"unpublishedReason": "mature-underage"}'), (99, '{}'),
      (26, '{"unpublishedReason": "photo-real-underage"}'), (40, '{"unpublishedReason": "mature-underage"}');
    INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES
      (14, '{"unpublishedReason": "mature-underage"}', 99), (15, '{}', 15),
      (25, '{"unpublishedReason": "photo-real-underage"}', 99), (26, '{}', 26),
      (40, '{"unpublishedReason": "mature-underage"}', 40);
    INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES
      (13, '{"unpublishedReason": "csam-text-hold"}', NULL), (14, '{}', 14), (15, '{}', 15),
      (20, '{"unpublishedReason": "photo-real-underage"}', NULL), (25, '{}', 25), (26, '{}', 26),
      (40, '{}', 40);
    INSERT INTO "User" (id, meta) VALUES (321, '{"banDetails": {"reasonCode": "SexualMinor"}}');
    -- 16: a delete on the url with no owner recorded (held). 17: a delete of a clean owner (not held).
    -- 23 and 24: a CSAM-review delete whose owner is on a sent report that lists it, verified or not.
    INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES
      (916, 'key-16', NULL, true), (917, 'key-17', 417, false),
      (923, 'key-23', 423, true), (924, 'key-24', 424, true);
    INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId", "userId") VALUES
      ('key-18', 1, NULL), ('key-27', 2, 427);
    INSERT INTO "CsamReport" ("userId", details, images, "reportSentAt") VALUES
      (423, '{"evidenceVerifiedAt": "2026-10-20T12:00:00Z"}', '[{"id": 923}]', now()),
      (424, '{}', '[{"id": 924}]', now());
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const tierOf = async (id: number) => {
  const cleared = await getRetractedMedia(id, { csamReview: true });
  const answer = await getRetractedMedia(id, { csamReview: false });
  const anyMod = typeof answer === 'string' ? null : answer;
  if (!cleared) return anyMod ? 'BROKEN' : 'none';
  return anyMod ? 'anyMod' : 'cleared';
};

describe('retracted media eligibility', () => {
  it('keeps a blocked image on a url retracted by an upgraded deny to cleared moderators', async () => {
    expect(await tierOf(31)).toBe('cleared');
    expect(await tierOf(32)).toBe('anyMod');
  });

  it('keeps an image the scanner marks, or cannot read, to moderators cleared for CSAM review', async () => {
    for (const verdict of ['hit', null] as const) {
      scanner.verdict = verdict;
      scannerVerdicts.clear();
      expect(await tierOf(1)).toBe('cleared');
    }
    scanner.verdict = 'clear';
  });

  it('serves an image the scanner has no verdict for to any moderator', async () => {
    scanner.verdict = 'none';
    expect(await tierOf(1)).toBe('anyMod');
    scanner.verdict = 'clear';
  });

  it('serves a blocked image with a known non-minor reason to any moderator', async () => {
    expect(await tierOf(1)).toBe('anyMod');
    expect(await getRetractedMedia(1, { csamReview: false })).toEqual({
      url: 'key-1',
      type: 'image',
      mimeType: null,
    });
  });

  it('serves a minor signal, and a block with no reason, to any moderator', async () => {
    expect(await tierOf(2)).toBe('anyMod');
    expect(await tierOf(3)).toBe('anyMod');
  });

  it('never serves held media, an unblocked image or a missing id', async () => {
    for (const id of [4, 5, 999])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
  });
});

describe('the CDN-refusal leg (RETRACTED_MEDIA_CDN_LEG)', () => {
  beforeEach(() => {
    envMock.env.RETRACTED_MEDIA_CDN_LEG = 'true';
    scanner.verdict = 'clear';
  });
  afterAll(() => {
    envMock.env.RETRACTED_MEDIA_CDN_LEG = undefined;
  });

  it('serves a scanned image whose url the CDN retracted, the url being its alone', async () => {
    expect(await tierOf(7)).toBe('anyMod');
  });

  it('keeps a url retracted by an upgraded deny, or with no retraction time, to cleared moderators', async () => {
    expect(await tierOf(28)).toBe('cleared');
    expect(await tierOf(29)).toBe('cleared');
    // An upgrade can land seconds after its deny: only stamps from one write read as outright.
    expect(await tierOf(30)).toBe('cleared');
    expect(await tierOf(33)).toBe('cleared');
  });

  it('is off unless the switch is exactly true', async () => {
    for (const value of [undefined, 'false', 'TRUE']) {
      envMock.env.RETRACTED_MEDIA_CDN_LEG = value;
      expect({ value, tier: await tierOf(7) }).toEqual({ value, tier: 'none' });
    }
  });

  it('takes a denied or retracted url, not one the CDN serves', async () => {
    expect(await tierOf(8)).toBe('anyMod');
    expect(await tierOf(9)).toBe('none');
  });

  it('takes only a finished scan', async () => {
    for (const id of [10, 11, 12])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
  });

  // cdn-access holds this url for its post's CSAM-hold removal; the file itself is not held.
  it('serves a url cdn-access holds only for its post to any moderator', async () => {
    expect(await tierOf(13)).toBe('anyMod');
  });

  it('serves a mature-underage removal to any moderator, though cdn-access holds its url', async () => {
    // On the version, then on the model; then a minor-flagged image of a removed model, url denied.
    for (const id of [14, 15, 40])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'anyMod' });
  });

  // A deleted or taken-down copy shares the bytes but not this row's signals, so it refuses the url
  // even when cdn-access would not hold it: deletes with no owner, a clean owner, a covering verified
  // report and an unverified one; takedowns with no owner and a clean owner.
  it('refuses a url with a deleted or taken-down copy behind it, held or not', async () => {
    for (const id of [16, 17, 23, 24, 18, 27])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
  });

  it('refuses a url another image row shares', async () => {
    expect(await tierOf(19)).toBe('none');
  });

  it('serves a minor unpublish reason, and a minor-safety ban of the owner, to any moderator', async () => {
    // On the post, on the version, on the model; then the ban.
    for (const id of [20, 25, 26, 21])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'anyMod' });
  });

  it("reads a scanned image's verdict fresh each time, since a rescan can change it", async () => {
    expect(await tierOf(7)).toBe('anyMod');
    scanner.verdict = 'hit';
    expect(await getRetractedMedia(7, { csamReview: false })).toBeNull();
  });
});

describe('the eligibility read', () => {
  it('runs under a statement timeout, so a slow read refuses instead of hanging', async () => {
    const seen: string[] = [];
    const query = db.query.bind(db);
    const exec = db.exec.bind(db);
    const spyQ = vi.spyOn(db, 'query').mockImplementation(((q: string, ...rest: unknown[]) => {
      seen.push(q);
      return (query as (...a: unknown[]) => unknown)(q, ...rest);
    }) as never);
    const spyE = vi.spyOn(db, 'exec').mockImplementation(((q: string, ...rest: unknown[]) => {
      seen.push(q);
      return (exec as (...a: unknown[]) => unknown)(q, ...rest);
    }) as never);
    try {
      await getRetractedMedia(1, { csamReview: false });
    } finally {
      spyQ.mockRestore();
      spyE.mockRestore();
    }
    // Inside the transaction and before the read, so the read is the statement it bounds.
    const begin = seen.findIndex((q) => /^\s*begin/i.test(q));
    const set = seen.findIndex((q) => /SET LOCAL statement_timeout = \d+/.test(q));
    const read = seen.findIndex((q) => /from \(select \* from "Image"/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(begin);
    expect(read).toBeGreaterThan(set);
  });
});

describe('copies sharing bytes with a restricted image', () => {
  // 990000101: a blocked image with a routine reason whose url another row shares. 990000103: a blocked image with a routine reason
  // whose pHash another row has. Each test lists or holds the other row, then removes it.
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor", "pHash") VALUES
        (990000101, 'key-990000101', 990100101, 'Blocked', 'moderated', NULL),
        (990000102, 'key-990000101', 990100102, 'Scanned', NULL, NULL),
        (990000103, 'key-990000103', 990100103, 'Blocked', 'moderated', 990990990),
        (990000104, 'key-990000104', 990100104, 'Scanned', NULL, 990990990);
    `);
  });
  beforeEach(() => {
    scanner.verdict = 'clear';
  });
  afterEach(async () => {
    await db.exec(`
      DELETE FROM "CsamReport" WHERE "userId" = 990100199;
      DELETE FROM "ImageCdnModeratorDelete" WHERE "imageId" = 990000105;
      UPDATE "Image" SET "needsReview" = NULL, minor = false WHERE id = 990000102;
    `);
  });

  const report = (imageId: number) =>
    db.query(`INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100199, '{}', $1)`, [
      JSON.stringify([{ id: imageId }]),
    ]);

  it('serves both images to any moderator while neither copy is reported or held', async () => {
    expect(await tierOf(990000101)).toBe('anyMod');
    expect(await tierOf(990000103)).toBe('anyMod');
  });

  it.each([
    ['a reported row on the same url', 990000101, () => report(990000102)],
    ['a reported row with the same pHash', 990000103, () => report(990000104)],
    [
      'an unreported copy on the same url in review',
      990000101,
      () => db.query(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 990000102`),
    ],
    [
      'a reported, deleted copy on the same url',
      990000101,
      async () => {
        await db.query(
          `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES (990000105, 'key-990000101', 990100105, false)`
        );
        await report(990000105);
      },
    ],
  ])('keeps an image with %s to moderators cleared for CSAM review', async (_label, id, mark) => {
    await mark();
    expect(await getRetractedMedia(id, { csamReview: false })).toBeNull();
    expect(await getRetractedMedia(id, { csamReview: true })).toMatchObject({ url: `key-${id}` });
  });
});

describe('a copy with only a minor flag', () => {
  it('leaves the image open to any moderator', async () => {
    scanner.verdict = 'clear';
    await db.query(`UPDATE "Image" SET minor = true WHERE id = 990000102`);
    try {
      expect(await tierOf(990000101)).toBe('anyMod');
    } finally {
      await db.query(`UPDATE "Image" SET minor = false WHERE id = 990000102`);
    }
  });
});

describe('a model version unpublished for its subject', () => {
  // 990000121: a blocked image with a routine reason on post 990400121, whose version carries the reason.
  // 990000122: a blocked image with a routine reason whose url a row on that post shares.
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (990300121, '{"unpublishedReason": "mature-underage"}', NULL);
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400121, '{}', 990300121);
    `);
  });

  it('leaves the image itself open to any moderator', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000121, 'key-990000121', 'Blocked', 'moderated', 990100121, 990400121)
    `);
    expect(await getRetractedMedia(990000121, { csamReview: false })).toMatchObject({
      url: 'key-990000121',
    });
  });

  it('serves an image on a model a CSAM hold removed to any moderator', async () => {
    await db.exec(`
      INSERT INTO "Model" (id, meta) VALUES (990500126, '{"unpublishedReason": "mature-underage"}');
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (990300126, '{}', 990500126);
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400126, '{}', 990300126);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000126, 'key-990000126', 'Blocked', 'moderated', 990100126, 990400126);
    `);
    for (const status of ['Pending', 'Confirmed']) {
      await db.exec(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Model', 990500126, 'csam', '${status}')`
      );
      try {
        expect({
          status,
          served: !!(await getRetractedMedia(990000126, { csamReview: false })),
        }).toEqual({ status, served: true });
      } finally {
        await db.exec(`DELETE FROM "TextScanHold" WHERE "entityId" = 990500126`);
      }
    }
  });

  it('leaves an image whose url a row with that reason shares open to any moderator', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000122, 'key-990000122', 'Blocked', 'moderated', 990100122, NULL),
        (990000123, 'key-990000122', 'Scanned', NULL, 990100123, 990400121)
    `);
    expect(await getRetractedMedia(990000122, { csamReview: false })).toMatchObject({
      url: 'key-990000122',
    });
  });

  it('serves an image whose owner is named on a report to any moderator', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000125, 'key-990000125', 'Blocked', 'AiNotVerified', 990100125, NULL);
      INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100125, '{}', '[]');
    `);
    try {
      expect(await getRetractedMedia(990000125, { csamReview: false })).toMatchObject({
        url: 'key-990000125',
      });
    } finally {
      await db.exec(`DELETE FROM "CsamReport" WHERE "userId" = 990100125`);
    }
  });

  it('serves an image on a post a CSAM hold removed to any moderator', async () => {
    await db.exec(`
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400129, '{"unpublishedReason": "csam-text-hold"}', NULL);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000129, 'key-990000129', 'Blocked', 'moderated', 990100129, 990400129);
      INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Post', 990400129, 'csam', 'Confirmed');
    `);
    try {
      expect(await getRetractedMedia(990000129, { csamReview: false })).toMatchObject({
        url: 'key-990000129',
      });
    } finally {
      await db.exec(`DELETE FROM "TextScanHold" WHERE "entityId" = 990400129`);
    }
  });
});

describe('rows sharing its url, its post text and its articles', () => {
  const target = { id: 990900000, url: 'key-990900000' };
  beforeAll(async () => {
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor") VALUES (990900000, 'key-990900000', 990910000, 'Blocked', 'moderated')`
    );
  });
  beforeEach(() => {
    scanner.verdict = 'clear';
  });
  afterEach(async () => {
    await db.exec(csamCaseCleanupSql(target));
  });

  it('keeps an image whose url a row the scanner marks shares to cleared moderators', async () => {
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion) VALUES (990900001, 'key-990900000', 990910001, 'Scanned')`
    );
    scanner.hits.add(990900001);
    try {
      expect(await getRetractedMedia(target.id, { csamReview: false })).toBeNull();
      expect(await getRetractedMedia(target.id, { csamReview: true })).toMatchObject({
        url: target.url,
      });
    } finally {
      scanner.hits.clear();
    }
  });

  it('keeps an image whose url more rows share than it reads to cleared moderators', async () => {
    const ids = Array.from({ length: URL_SIBLING_CAP }, (_, n) => 990900100 + n);
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion) VALUES ${ids
        .map((id) => `(${id}, 'key-990900000', 990910001, 'Scanned')`)
        .join(', ')}`
    );
    try {
      expect(await getRetractedMedia(target.id, { csamReview: false })).toBeNull();
      await db.exec(`DELETE FROM "Image" WHERE id = ${ids[0]}`);
      expect(await getRetractedMedia(target.id, { csamReview: false })).toMatchObject({
        url: target.url,
      });
    } finally {
      await db.exec(`DELETE FROM "Image" WHERE id = ANY(ARRAY[${ids.join(', ')}])`);
    }
  });

  it('keeps an image whose url a row with an unknown signal shares to cleared moderators', async () => {
    await db.exec(`ALTER TABLE "Image" ALTER COLUMN ingestion DROP NOT NULL;
      INSERT INTO "Image" (id, url, "userId", ingestion) VALUES (990900001, 'key-990900000', 990910001, NULL)`);
    try {
      expect(await getRetractedMedia(target.id, { csamReview: false })).toBeNull();
      expect(await getRetractedMedia(target.id, { csamReview: true })).toMatchObject({
        url: target.url,
      });
    } finally {
      await db.exec(`DELETE FROM "Image" WHERE id = 990900001;
        ALTER TABLE "Image" ALTER COLUMN ingestion SET NOT NULL`);
    }
  });

  it('keeps an image whose url a row with an unfinished scan shares to cleared moderators', async () => {
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion) VALUES (990900001, 'key-990900000', 990910001, 'Pending')`
    );
    expect(await getRetractedMedia(target.id, { csamReview: false })).toBeNull();
    expect(await getRetractedMedia(target.id, { csamReview: true })).toMatchObject({
      url: target.url,
    });
  });

  it.each(CSAM_RESTRICTION_CASES.filter((c) => c.restricts))(
    'keeps an image with $label to cleared moderators',
    async ({ mark }) => {
      await db.exec(mark(target));
      expect(await getModeratorMedia(target.id, { csamReview: false })).toBeNull();
      expect(await getModeratorMedia(target.id, { csamReview: true })).toMatchObject({
        url: target.url,
      });
    }
  );

  it.each(CSAM_RESTRICTION_CASES.filter((c) => !c.restricts))(
    'serves an image with $label to any moderator',
    async ({ mark }) => {
      await db.exec(mark(target));
      expect(await getModeratorMedia(target.id, { csamReview: false })).toMatchObject({
        url: target.url,
      });
    }
  );
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

// civitai/civitai#10202: a held account's withheld media is open to any moderator, answered as
// any other account's would be.
describe("a held account's image, through /api/retracted-media's reader", () => {
  const OWNER = 990100400;
  const IMAGE = 990000400;
  // Not held: the same image of another account.
  const TWIN = 990000401;
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview") VALUES
        (${IMAGE}, 'key-${IMAGE}', ${OWNER}, 'Scanned', 'poi'),
        (${TWIN}, 'key-${TWIN}', 990100401, 'Scanned', 'poi');
      INSERT INTO "CsamReport" ("userId", details, images) VALUES (${OWNER}, '{}', '[]');
    `);
  });
  beforeEach(() => {
    scanner.verdict = 'clear';
  });
  afterAll(async () => {
    await db.exec(`DELETE FROM "Image" WHERE id IN (${IMAGE}, ${TWIN});
      DELETE FROM "CsamReport" WHERE "userId" = ${OWNER}`);
  });

  it('answers a live image of a held account as it answers any live image', async () => {
    expect(await getModeratorMedia(IMAGE, { csamReview: false })).toBeNull();
    expect(await getModeratorMedia(TWIN, { csamReview: false })).toBeNull();
    expect(await getModeratorMedia(IMAGE, { csamReview: true })).toMatchObject({ kind: 'held' });
  });

  it('serves it from storage once the CDN refuses it, as it serves any such image', async () => {
    envMock.env.RETRACTED_MEDIA_CDN_LEG = 'true';
    await db.exec(`INSERT INTO "ImageCdnAccess" (url, state) VALUES
      ('key-${IMAGE}', 'Denied'), ('key-${TWIN}', 'Denied')`);
    try {
      expect(await getModeratorMedia(IMAGE, { csamReview: false })).toEqual({
        url: `key-${IMAGE}`,
        type: 'image',
        mimeType: null,
        kind: 'held',
      });
      expect(await getModeratorMedia(TWIN, { csamReview: false })).toMatchObject({
        kind: 'retracted',
      });
    } finally {
      envMock.env.RETRACTED_MEDIA_CDN_LEG = undefined;
      await db.exec(`DELETE FROM "ImageCdnAccess" WHERE url IN ('key-${IMAGE}', 'key-${TWIN}')`);
    }
  });

  it('keeps the same image in the CSAM queue to cleared moderators', async () => {
    await db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${IMAGE}`);
    try {
      expect(await getModeratorMedia(IMAGE, { csamReview: false })).toBeNull();
      expect(await getModeratorMedia(IMAGE, { csamReview: true })).toMatchObject({ kind: 'held' });
    } finally {
      await db.exec(`UPDATE "Image" SET "needsReview" = 'poi' WHERE id = ${IMAGE}`);
    }
  });

  it('answers a blocked image of the same account as held media', async () => {
    await db.exec(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${IMAGE}`
    );
    try {
      expect(await getModeratorMedia(IMAGE, { csamReview: false })).toMatchObject({ kind: 'held' });
      expect(await getModeratorMedia(IMAGE, { csamReview: true })).toMatchObject({ kind: 'held' });
    } finally {
      await db.exec(
        `UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = ${IMAGE}`
      );
    }
  });

  it.each(['Pending', 'Error'])(
    'refuses a %s image of the account to a moderator without the grant, even once the CDN refuses it',
    async (ingestion) => {
      envMock.env.RETRACTED_MEDIA_CDN_LEG = 'true';
      await db.exec(`ALTER TABLE "Image" ALTER COLUMN ingestion DROP DEFAULT;
        UPDATE "Image" SET ingestion = '${ingestion}' WHERE id = ${IMAGE};
        INSERT INTO "ImageCdnAccess" (url, state) VALUES ('key-${IMAGE}', 'Denied')`);
      try {
        expect(await getModeratorMedia(IMAGE, { csamReview: false })).toBeNull();
        expect(await getModeratorMedia(IMAGE, { csamReview: true })).toMatchObject({
          kind: 'held',
        });
      } finally {
        envMock.env.RETRACTED_MEDIA_CDN_LEG = undefined;
        await db.exec(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = ${IMAGE};
          ALTER TABLE "Image" ALTER COLUMN ingestion SET DEFAULT 'Blocked';
          DELETE FROM "ImageCdnAccess" WHERE url = 'key-${IMAGE}'`);
      }
    }
  );

  it('keeps it to cleared moderators while the scanner marks it', async () => {
    scanner.verdict = 'hit';
    expect(await getModeratorMedia(IMAGE, { csamReview: false })).toBeNull();
  });
});

// civitai/civitai#10202: the shape of a reported case. A moderator unpublished the post, and the
// model was pulled, so the CDN denies the url. With the leg off, any moderator still sees it.
describe('a scanned image whose post someone other than its owner unpublished', () => {
  const OWNER = 990100410;
  const ids = {
    pulled: 990000410,
    signal: 990000411,
    item: 990000412,
    shop: 990000413,
    deleted: 990000414,
    live: 990000415,
    ownPull: 990000416,
  };
  const all = Object.values(ids);
  const postOf = (id: number) =>
    id === ids.live ? 990400415 : id === ids.ownPull ? 990400416 : 990400410;
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Post" (id, metadata, "modelVersionId", "userId", "publishedAt") VALUES
        (990400410, '{"unpublishedAt": "2026-11-18", "unpublishedBy": "990100499"}', NULL, ${OWNER}, NULL),
        (990400415, '{}', NULL, ${OWNER}, now()),
        (990400416, '{"unpublishedAt": "2026-11-18", "unpublishedBy": "${OWNER}"}', NULL, ${OWNER}, NULL);
      INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId", "userId") VALUES ('key-${ids.shop}', 1, ${OWNER});
      INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview")
        VALUES (${ids.deleted}, 'key-${ids.deleted}', ${OWNER}, false);
      INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ids.signal}, ${ids.signal}, 'csam-hold');
    `);
    for (const id of all)
      await db.query(
        `INSERT INTO "Image" (id, url, ingestion, "needsReview", minor, "nsfwLevel", "userId", "postId")
         VALUES ($1, $2, 'Scanned', $3, true, 2, $4, $5)`,
        [id, `key-${id}`, id === ids.item ? 'csam' : null, OWNER, postOf(id)]
      );
    await db.query(
      `INSERT INTO "ImageCdnAccess" (url, state) SELECT 'key-' || id, 'Denied' FROM unnest($1::int[]) id`,
      [all]
    );
  });
  beforeEach(() => {
    scanner.verdict = 'clear';
  });

  it('serves it to any moderator, with the leg off', async () => {
    for (const csamReview of [false, true])
      expect({ csamReview, media: await getModeratorMedia(ids.pulled, { csamReview }) }).toEqual({
        csamReview,
        media: { url: `key-${ids.pulled}`, type: 'image', mimeType: null, kind: 'retracted' },
      });
  });

  it('keeps it from a moderator without the grant with a CSAM mark of its own, or held for itself', async () => {
    expect(await getModeratorMedia(ids.signal, { csamReview: false })).toBeNull();
    // Nor is a scanned row with its own mark served to the grant through this leg.
    expect(await getModeratorMedia(ids.signal, { csamReview: true })).toBeNull();
    expect(await getModeratorMedia(ids.item, { csamReview: false })).toBeNull();
  });

  it('refuses a url a shop takedown or a moderator delete also refuses', async () => {
    for (const id of [ids.shop, ids.deleted])
      expect({ id, media: await getModeratorMedia(id, { csamReview: true }) }).toEqual({
        id,
        media: null,
      });
  });

  it('refuses a denied url no unpublish by someone else explains', async () => {
    for (const id of [ids.live, ids.ownPull])
      expect({ id, media: await getModeratorMedia(id, { csamReview: true }) }).toEqual({
        id,
        media: null,
      });
  });
});
