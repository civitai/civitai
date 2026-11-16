import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Which images `/api/mod/retracted-media` serves: the shared `retractedImageSql`, run against real
 * SQL. Each refused case differs from a served one in a single column or row, so each assertion pins
 * one leg of the statement.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;

type Row = {
  id: number;
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
  minor?: boolean;
  acceptableMinor?: boolean;
  pHash?: number;
  nsfwLevel?: number;
  userId?: number;
};

// Each image has its own owner unless a case says otherwise, so an owner-level leg hits one image.
const rows: Row[] = [
  { id: 1, blockedFor: 'moderated' },
  { id: 2, blockedFor: 'tos' },
  { id: 3, blockedFor: 'AiNotVerified' },
  { id: 4, blockedFor: null },
  { id: 5, blockedFor: 'Moderated' },
  { id: 10, blockedFor: 'scan-reason-x' },
  { id: 11, blockedFor: 'CSAM' },
  { id: 12, ingestion: 'Scanned' },
  { id: 13, needsReview: 'csam' },
  { id: 14, needsReview: 'minor', nsfwLevel: 4 },
  { id: 15, needsReview: 'minor', nsfwLevel: 2 },
  { id: 16, minor: true, nsfwLevel: 8 },
  { id: 17, minor: true, nsfwLevel: 1 },
  { id: 18 },
  { id: 19, blockedFor: 'AiNotVerified' },
  { id: 20 },
  { id: 21, blockedFor: 'AiNotVerified' },
  { id: 22, blockedFor: 'AiNotVerified' },
  { id: 23 },
  { id: 24 },
  { id: 25, acceptableMinor: true, nsfwLevel: 1 },
  { id: 26 },
  { id: 27, pHash: 777 },
  { id: 28 },
  { id: 29 },
  { id: 30 },
  { id: 31 },
  { id: 32 },
];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, type "MediaType" NOT NULL DEFAULT 'image',
      "mimeType" text, ingestion text NOT NULL, "needsReview" text, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 4, "userId" int NOT NULL,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "pHash" bigint
    );
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE "BlockedImage" (hash bigint, reason text);
    CREATE TABLE "ScanLabelItem" (id int PRIMARY KEY, "imageId" int, "voidReason" text);
    CREATE TABLE "ScanLabelFlag" ("itemId" int, snapshot jsonb);
    CREATE TABLE "ScanLabelVote" ("itemId" int, reason text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb, images jsonb);
    CREATE TABLE "EvidenceHeldUser" ("userId" int);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
  `);
  for (const r of rows)
    await pg.query(
      `INSERT INTO "Image" (id, url, ingestion, "needsReview", "blockedFor", minor, "nsfwLevel", "userId",
         "acceptableMinor", "pHash")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.id,
        `key-${r.id}`,
        r.ingestion ?? 'Blocked',
        r.needsReview ?? null,
        r.blockedFor === undefined ? 'moderated' : r.blockedFor,
        r.minor ?? false,
        r.nsfwLevel ?? 4,
        r.userId ?? 500 + r.id,
        r.acceptableMinor ?? false,
        r.pHash ?? null,
      ]
    );
  await pg.exec(`
    INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (18);
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES (26, ${childBrowsingTagIds[0]});
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", disabled) VALUES (1, ${childBrowsingTagIds[0]}, true);
    INSERT INTO "BlockedImage" (hash, reason) VALUES (777, 'CSAM');
    INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES
      (1, 28, 'csam-hold'), (2, 29, NULL), (3, 30, NULL), (4, 31, NULL), (5, 32, NULL), (6, 2, NULL);
    INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES
      (2, '{"csam": "true"}'), (3, '{"minorDetected": "true"}'), (6, '{"csam": "false"}');
    INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES (4, 'csam-realistic'), (5, 'minor-other'), (6, 'other');
    INSERT INTO "EvidenceHeldUser" ("userId") VALUES (519);
    INSERT INTO "CsamReport" ("userId", details, images) VALUES
      (520, '{}', '[]'),
      (NULL, '{"secondaryUserId": "522"}', '[]'),
      (NULL, '{}', '[{"id": 23}]'),
      (NULL, '{}', '[24]'),
      (521, '{}', '[]'),
      (NULL, '{"secondaryUserId": "abc"}', '{"a": 1}'),
      (NULL, '{"secondaryUserId": "123456789012345678901"}', '7');
  `);
});

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { getRetractedMedia } = await import('~/server/services/retracted-media.service');

const served = async (id: number) => (await getRetractedMedia(id)) !== null;

describe('getRetractedMedia', () => {
  it('serves a blocked image for each listed reason', async () => {
    for (const id of [1, 2, 3, 5])
      expect({ id, served: await served(id) }).toEqual({ id, served: true });
    expect(await getRetractedMedia(1)).toEqual({ url: 'key-1', type: 'image', mimeType: null });
  });

  it('survives a report with a malformed secondary user or image list', async () => {
    expect(await served(1)).toBe(true);
  });

  // Deliberate: a block with no reason is refused. Do not re-admit it without a review of every
  // path that blocks an image.
  it('refuses a block with no reason', async () => {
    expect(await served(4)).toBe(false);
  });

  it('refuses any other block reason', async () => {
    expect(await served(10)).toBe(false);
    expect(await served(11)).toBe(false);
  });

  it('refuses an image that is not blocked, and a missing id', async () => {
    expect(await served(12)).toBe(false);
    expect(await served(999)).toBe(false);
  });

  it('refuses an image flagged for csam review', async () => {
    expect(await served(13)).toBe(false);
  });

  // Deliberate: any CSAM or minor signal keeps an image off this route, at every browsing level,
  // PG included; such images are reviewed in the queues instead.
  it('refuses a minor review flag at any level, PG included', async () => {
    expect(await served(14)).toBe(false);
    expect(await served(15)).toBe(false);
  });

  it('refuses a minor-marked image at any level, PG included', async () => {
    expect(await served(16)).toBe(false);
    expect(await served(17)).toBe(false);
  });

  it('refuses an acceptable-minor image at PG', async () => {
    expect(await served(25)).toBe(false);
  });

  it('refuses an image with a child tag, but not for a disabled one', async () => {
    expect(await served(26)).toBe(false);
    expect(await served(1)).toBe(true);
  });

  it('refuses an image whose hash is a CSAM block', async () => {
    expect(await served(27)).toBe(false);
  });

  it('refuses an image whose label item is on a csam hold', async () => {
    expect(await served(28)).toBe(false);
  });

  it('refuses an image a scan flagged for csam or a minor, but not a clean flag', async () => {
    expect(await served(29)).toBe(false);
    expect(await served(30)).toBe(false);
    expect(await served(2)).toBe(true);
  });

  it('refuses an image a moderator voted csam or minor, but not another reason', async () => {
    expect(await served(31)).toBe(false);
    expect(await served(32)).toBe(false);
    expect(await served(2)).toBe(true);
  });

  it('refuses an image under an evidence hold', async () => {
    expect(await served(18)).toBe(false);
  });

  it('refuses an AiNotVerified image whose owner is under an evidence hold', async () => {
    expect(await served(19)).toBe(false);
  });

  it('refuses an image whose owner is the subject of a report', async () => {
    expect(await served(20)).toBe(false);
  });

  it('refuses an AiNotVerified image whose owner is the subject of a report', async () => {
    expect(await served(21)).toBe(false);
  });

  it('refuses an AiNotVerified image whose owner is a report’s secondary user', async () => {
    expect(await served(22)).toBe(false);
  });

  it('refuses an image listed on a report, in either list shape', async () => {
    expect(await served(23)).toBe(false);
    expect(await served(24)).toBe(false);
  });
});
