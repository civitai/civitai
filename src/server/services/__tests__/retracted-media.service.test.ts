import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Which images `/api/mod/retracted-media` serves, and to whom: the shared `retracted-media-tier`
 * SQL, run against real SQL. Each case differs from a `plain` one in a single column or row, so each
 * assertion pins one leg of the statement.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;

const patterns = vi.hoisted(() => ({
  current: null as { signal: RegExp[]; nonMinor: RegExp[] } | null,
}));
vi.mock('~/server/services/blocked-for-patterns', () => ({
  blockedForPatterns: () => patterns.current,
}));
/** The scanner's verdict for every image, or null when it cannot be read. */
const scanner = vi.hoisted(() => ({
  verdict: 'clear' as 'hit' | 'clear' | 'none' | null,
}));
const readScannerVerdict = vi.hoisted(() => vi.fn(async () => scanner.verdict));
vi.mock('~/server/services/review-batch/review-batch.service', () => ({ readScannerVerdict }));

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
      "acceptableMinor" boolean NOT NULL DEFAULT false, "pHash" bigint, "postId" int
    );
    CREATE TABLE "Post" (id int PRIMARY KEY, metadata jsonb, "modelVersionId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, meta jsonb, "modelId" int);
    CREATE TABLE "Model" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "ImageCdnAccess" (url text PRIMARY KEY, state text NOT NULL);
    CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int PRIMARY KEY, url text, "userId" int, "csamReview" boolean);
    CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" int, "userId" int);
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
    INSERT INTO "ImageCdnAccess" (url, state) VALUES ('key-12', 'Retracted');
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
  patterns.current = null;
  scanner.verdict = 'clear';
  scannerVerdicts.clear();
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { getRetractedMedia, scannerVerdicts } = await import(
  '~/server/services/retracted-media.service'
);

/** Who sees the image: `none` (refused to every moderator), `plain` (any moderator) or `suspect`
 *  (only a moderator cleared for CSAM review). */
const tierOf = async (id: number) => {
  const cleared = await getRetractedMedia(id, { csamReview: true });
  const anyModAnswer = await getRetractedMedia(id, { csamReview: false });
  const anyMod = typeof anyModAnswer === 'string' ? null : anyModAnswer;
  if (!cleared) {
    expect(anyMod).toBeNull();
    return 'none';
  }
  return anyMod ? 'plain' : 'suspect';
};

const expectTiers = async (tier: string, ids: number[]) => {
  for (const id of ids) expect({ id, tier: await tierOf(id) }).toEqual({ id, tier });
};

describe('getRetractedMedia', () => {
  it('serves a blocked image with a known non-minor reason to any moderator', async () => {
    await expectTiers('plain', [1, 2, 3, 5]);
    expect(await getRetractedMedia(1, { csamReview: false })).toEqual({
      url: 'key-1',
      type: 'image',
      mimeType: null,
      tier: 'plain',
    });
  });

  it('keeps an image the scanner marks, or cannot read, to cleared moderators', async () => {
    for (const verdict of ['hit', null] as const) {
      scanner.verdict = verdict;
      scannerVerdicts.clear();
      await expectTiers('suspect', [1]);
      expect(await getRetractedMedia(1, { csamReview: false })).toBeNull();
    }
    expect(readScannerVerdict).toHaveBeenCalledWith(1);
  });

  it('answers an image with no scanner verdict as needing CSAM-queue access', async () => {
    scanner.verdict = 'none';
    expect(await getRetractedMedia(1, { csamReview: false })).toBe('needs-csam-queue');
    expect(await getRetractedMedia(1, { csamReview: true })).toMatchObject({ url: 'key-1' });
  });

  it('survives a report with a malformed secondary user or image list', async () => {
    await expectTiers('plain', [1]);
  });

  it('keeps a block with no reason to cleared moderators', async () => {
    await expectTiers('suspect', [4]);
  });

  it('reads any other reason as a signal while the patterns are missing', async () => {
    await expectTiers('suspect', [10]);
  });

  it('reads a reason by the private patterns: known non-minor is plain, a signal is suspect', async () => {
    patterns.current = { signal: [], nonMinor: [/^scan-reason-/u] };
    await expectTiers('plain', [10]);
    patterns.current = { signal: [/^scan-reason-x$/u], nonMinor: [/^scan-reason-/u] };
    await expectTiers('suspect', [10]);
  });

  it('never serves held media, which the held-media route serves', async () => {
    // CSAM block, CSAM review flag, an owner who is a report's subject.
    await expectTiers('none', [11, 13, 20]);
  });

  it('refuses an image that is not blocked, and a missing id', async () => {
    await expectTiers('none', [12, 999]);
  });

  // The CDN-refusal leg is the moderator app's alone: this app's client only asks for blocked images.
  it('refuses a scanned image even while the image CDN has retracted its url', async () => {
    await expectTiers('none', [12]);
  });

  it('refuses an image under an evidence hold', async () => {
    await expectTiers('none', [18]);
  });

  it('keeps a minor review flag to cleared moderators, PG included', async () => {
    await expectTiers('suspect', [14, 15]);
  });

  it('keeps a minor-marked or acceptable-minor image to cleared moderators', async () => {
    await expectTiers('suspect', [16, 17, 25]);
  });

  it('keeps a child-tagged image to cleared moderators, but not for a disabled tag', async () => {
    await expectTiers('suspect', [26]);
    await expectTiers('plain', [1]);
  });

  it('keeps an image whose hash is a CSAM block to cleared moderators', async () => {
    await expectTiers('suspect', [27]);
  });

  it('keeps an image whose label item is on a csam hold to cleared moderators', async () => {
    await expectTiers('suspect', [28]);
  });

  it('keeps a csam or minor scan flag to cleared moderators, but not a clean flag', async () => {
    await expectTiers('suspect', [29, 30]);
    await expectTiers('plain', [2]);
  });

  it('keeps a csam or minor vote to cleared moderators, but not another reason', async () => {
    await expectTiers('suspect', [31, 32]);
    await expectTiers('plain', [2]);
  });

  it('keeps an AiNotVerified image of a held or reported owner to cleared moderators', async () => {
    // Evidence-held owner, report subject, report secondary user.
    await expectTiers('suspect', [19, 21, 22]);
  });

  it('keeps an image listed on a report, in either list shape, to cleared moderators', async () => {
    await expectTiers('suspect', [23, 24]);
  });
});
