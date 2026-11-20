import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const scanner = vi.hoisted(() => ({ verdict: 'clear' as 'hit' | 'clear' | 'none' | null }));
vi.mock('../review-batch', () => ({ readScannerCsamVerdict: async () => scanner.verdict }));

const { getRetractedMedia, recordRetractedView, scannerVerdicts } = await import(
  '../retracted-media'
);
beforeEach(() => scannerVerdicts.clear());

const SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'image', "mimeType" TEXT,
  ingestion TEXT NOT NULL DEFAULT 'Blocked', "needsReview" TEXT, "blockedFor" TEXT,
  minor BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 4, "pHash" BIGINT, "userId" INTEGER NOT NULL, "postId" INTEGER
);
CREATE TABLE "Post" (id INTEGER PRIMARY KEY, metadata JSONB, "modelVersionId" INTEGER);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, meta JSONB, "modelId" INTEGER);
CREATE TABLE "Model" (id INTEGER PRIMARY KEY, meta JSONB);
CREATE TABLE "User" (id INTEGER PRIMARY KEY, meta JSONB);
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
  id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB, images JSONB, "reportSentAt" TIMESTAMP
);
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

    -- The CDN-refusal leg. Each differs from 7 (scanned, url retracted, the url's only row) in one fact.
    INSERT INTO "Image" (id, url, "userId", ingestion, "postId", minor) VALUES
      (7, 'key-7', 307, 'Scanned', NULL, false),
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
      (24, 'key-24', 324, 'Scanned', NULL, false);
    INSERT INTO "ImageCdnAccess" (url, state) VALUES
      ('key-7', 'Retracted'), ('key-8', 'Denied'), ('key-10', 'Retracted'), ('key-11', 'Retracted'),
      ('key-12', 'Retracted'), ('key-13', 'Retracted'), ('key-14', 'Retracted'),
      ('key-15', 'Retracted'), ('key-16', 'Retracted'), ('key-17', 'Retracted'),
      ('key-18', 'Retracted'), ('key-19', 'Retracted'), ('key-20', 'Retracted'),
      ('key-21', 'Retracted'), ('key-23', 'Retracted'), ('key-24', 'Retracted'),
      ('key-25', 'Retracted'), ('key-26', 'Retracted'), ('key-27', 'Retracted');
    INSERT INTO "Model" (id, meta) VALUES
      (15, '{"unpublishedReason": "mature-underage"}'), (99, '{}'),
      (26, '{"unpublishedReason": "photo-real-underage"}');
    INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES
      (14, '{"unpublishedReason": "mature-underage"}', 99), (15, '{}', 15),
      (25, '{"unpublishedReason": "photo-real-underage"}', 99), (26, '{}', 26);
    INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES
      (13, '{"unpublishedReason": "csam-text-hold"}', NULL), (14, '{}', 14), (15, '{}', 15),
      (20, '{"unpublishedReason": "photo-real-underage"}', NULL), (25, '{}', 25), (26, '{}', 26);
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
  return anyMod ? 'plain' : 'suspect';
};

describe('retracted media eligibility', () => {
  it('keeps an image the scanner marks, or cannot read, to moderators cleared for CSAM review', async () => {
    for (const verdict of ['hit', null] as const) {
      scanner.verdict = verdict;
      scannerVerdicts.clear();
      expect(await tierOf(1)).toBe('suspect');
    }
    scanner.verdict = 'clear';
  });

  it('serves an image the scanner has no verdict for to any moderator', async () => {
    scanner.verdict = 'none';
    expect(await tierOf(1)).toBe('plain');
    scanner.verdict = 'clear';
  });

  it('serves a blocked image with a known non-minor reason to any moderator', async () => {
    expect(await tierOf(1)).toBe('plain');
    expect(await getRetractedMedia(1, { csamReview: false })).toEqual({
      url: 'key-1',
      type: 'image',
      mimeType: null,
    });
  });

  it('serves a minor signal to any moderator, and keeps a block with no reason to cleared ones', async () => {
    expect(await tierOf(2)).toBe('plain');
    expect(await tierOf(3)).toBe('suspect');
  });

  it('never serves held media, an unblocked image, an evidence-held one or a missing id', async () => {
    for (const id of [4, 5, 6, 999])
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
    expect(await tierOf(7)).toBe('plain');
  });

  it('is off unless the switch is exactly true', async () => {
    for (const value of [undefined, 'false', 'TRUE']) {
      envMock.env.RETRACTED_MEDIA_CDN_LEG = value;
      expect({ value, tier: await tierOf(7) }).toEqual({ value, tier: 'none' });
    }
  });

  it('takes only a retracted url: not a denied one, and not one the CDN serves', async () => {
    expect(await tierOf(8)).toBe('none');
    expect(await tierOf(9)).toBe('none');
  });

  it('takes only a finished scan', async () => {
    for (const id of [10, 11, 12])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
  });

  // Each of these is refused by heldUrlSql alone: heldImageSql and the sole-row guards pass them.
  // Its delete and takedown legs are pinned by the cdn-access parity suite, since a delete or
  // takedown row on the url is refused here before them.
  it('refuses a url cdn-access holds', async () => {
    // A csam-hold post removal; mature-underage on the version, then on the model.
    for (const id of [13, 14, 15])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'none' });
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

  it('serves a minor unpublish reason to any moderator, and keeps a minor-safety ban of the owner to cleared ones', async () => {
    // On the post, on the version, on the model; then the ban.
    for (const id of [20, 25, 26])
      expect({ id, tier: await tierOf(id) }).toEqual({ id, tier: 'plain' });
    expect(await tierOf(21)).toBe('suspect');
  });

  it("reads a scanned image's verdict fresh each time, since a rescan can change it", async () => {
    expect(await tierOf(7)).toBe('plain');
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
    const read = seen.findIndex((q) => /from "Image" as "i"/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(begin);
    expect(read).toBeGreaterThan(set);
  });
});

describe('copies sharing bytes with a restricted image', () => {
  // 990000101: a plain blocked image whose url another row shares. 990000103: a plain blocked image
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
      DELETE FROM "EvidenceHoldImage" WHERE "imageId" IN (990000102, 990000104);
      DELETE FROM "ImageCdnModeratorDelete" WHERE "imageId" = 990000105;
      DELETE FROM "EvidenceHeldUser" WHERE "userId" = 990100102;
      UPDATE "Image" SET "needsReview" = NULL, minor = false WHERE id = 990000102;
    `);
  });

  const report = (imageId: number) =>
    db.query(`INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100199, '{}', $1)`, [
      JSON.stringify([{ id: imageId }]),
    ]);
  const hold = (imageId: number) =>
    db.query(`INSERT INTO "EvidenceHoldImage" ("imageId") VALUES ($1)`, [imageId]);

  it('serves both images to any moderator while neither copy is reported or held', async () => {
    expect(await tierOf(990000101)).toBe('plain');
    expect(await tierOf(990000103)).toBe('plain');
  });

  it.each([
    ['a reported row on the same url', 990000101, () => report(990000102)],
    ['a reported row with the same pHash', 990000103, () => report(990000104)],
    ['a held row on the same url', 990000101, () => hold(990000102)],
    [
      'a copy on the same url whose owner is held',
      990000101,
      () => db.query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (990100102)`),
    ],
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
      expect(await tierOf(990000101)).toBe('plain');
    } finally {
      await db.query(`UPDATE "Image" SET minor = false WHERE id = 990000102`);
    }
  });
});

describe('a model version unpublished for its subject', () => {
  // 990000121: plain blocked image on post 990400121, whose version carries the reason.
  // 990000122: plain blocked image whose url a row on that post shares.
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

  it('keeps an image whose url a row with that reason shares to cleared moderators', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000122, 'key-990000122', 'Blocked', 'moderated', 990100122, NULL),
        (990000123, 'key-990000122', 'Scanned', NULL, 990100123, 990400121)
    `);
    expect(await getRetractedMedia(990000122, { csamReview: false })).toBeNull();
    expect(await getRetractedMedia(990000122, { csamReview: true })).toMatchObject({
      url: 'key-990000122',
    });
  });

  it('keeps an image whose owner is named on a report to cleared moderators', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000125, 'key-990000125', 'Blocked', 'AiNotVerified', 990100125, NULL);
      INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100125, '{}', '[]');
    `);
    try {
      expect(await getRetractedMedia(990000125, { csamReview: false })).toBeNull();
    } finally {
      await db.exec(`DELETE FROM "CsamReport" WHERE "userId" = 990100125`);
    }
    expect(await getRetractedMedia(990000125, { csamReview: false })).toMatchObject({
      url: 'key-990000125',
    });
  });

  it('keeps an image whose own post is on a CSAM hold to cleared moderators', async () => {
    await db.exec(`
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400124, '{"unpublishedReason": "csam-text-hold"}', NULL);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000124, 'key-990000124', 'Blocked', 'moderated', 990100124, 990400124)
    `);
    expect(await getRetractedMedia(990000124, { csamReview: false })).toBeNull();
    expect(await getRetractedMedia(990000124, { csamReview: true })).toMatchObject({
      url: 'key-990000124',
    });
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
