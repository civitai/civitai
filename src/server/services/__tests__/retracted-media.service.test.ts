import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CSAM_LINK_TABLES_SQL,
  CSAM_RESTRICTION_CASES,
  csamCaseCleanupSql,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * Which images `/api/mod/retracted-media` serves, and to whom: the shared `retracted-media-tier`
 * SQL, run against real SQL. Each case differs from an `anyMod` one in a single column or row, so each
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
  hits: new Set<number>(),
}));
const readScannerVerdict = vi.hoisted(() =>
  vi.fn(async (id: number) => (scanner.hits.has(id) ? 'hit' : scanner.verdict))
);
vi.mock('~/server/services/review-batch/review-batch.service', () => ({
  readScannerCsamVerdict: readScannerVerdict,
}));

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
  await pg.exec(CSAM_LINK_TABLES_SQL);
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
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb, images jsonb, "reportSentAt" timestamp);
    CREATE TABLE "EvidenceHeldUser" ("userId" int);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
    CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL);
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

/** Who sees the image: `none` (refused to every moderator), `anyMod` (any moderator) or `cleared`
 *  (only a moderator cleared for CSAM review). */
const tierOf = async (id: number) => {
  const cleared = await getRetractedMedia(id, { csamReview: true });
  const anyModAnswer = await getRetractedMedia(id, { csamReview: false });
  const anyMod = typeof anyModAnswer === 'string' ? null : anyModAnswer;
  if (!cleared) {
    expect(anyMod).toBeNull();
    return 'none';
  }
  return anyMod ? 'anyMod' : 'cleared';
};

const expectTiers = async (tier: string, ids: number[]) => {
  for (const id of ids) expect({ id, tier: await tierOf(id) }).toEqual({ id, tier });
};

describe('getRetractedMedia', () => {
  it('serves a blocked image with a known non-minor reason to any moderator', async () => {
    await expectTiers('anyMod', [1, 2, 3, 5]);
    expect(await getRetractedMedia(1, { csamReview: false })).toEqual({
      url: 'key-1',
      type: 'image',
      mimeType: null,
    });
  });

  it('keeps an image the scanner marks, or cannot read, to cleared moderators', async () => {
    for (const verdict of ['hit', null] as const) {
      scanner.verdict = verdict;
      scannerVerdicts.clear();
      await expectTiers('cleared', [1]);
      expect(await getRetractedMedia(1, { csamReview: false })).toBeNull();
    }
    expect(readScannerVerdict).toHaveBeenCalledWith(1);
  });

  it('serves an image the scanner has no verdict for to any moderator', async () => {
    scanner.verdict = 'none';
    await expectTiers('anyMod', [1]);
  });

  it('survives a report with a malformed secondary user or image list', async () => {
    await expectTiers('anyMod', [1]);
  });

  it('keeps a block with no reason to cleared moderators', async () => {
    await expectTiers('cleared', [4]);
  });

  it('reads any other reason as a signal while the patterns are missing', async () => {
    await expectTiers('cleared', [10]);
  });

  it('reads a reason by the private patterns: known non-minor is open to any moderator, a signal to cleared ones', async () => {
    patterns.current = { signal: [], nonMinor: [/^scan-reason-/u] };
    await expectTiers('anyMod', [10]);
    patterns.current = { signal: [/^scan-reason-x$/u], nonMinor: [/^scan-reason-/u] };
    await expectTiers('cleared', [10]);
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

  it('serves a minor review flag to any moderator, PG included', async () => {
    await expectTiers('anyMod', [14, 15]);
  });

  it('serves a minor-marked or acceptable-minor image to any moderator', async () => {
    await expectTiers('anyMod', [16, 17, 25]);
  });

  it('serves a child-tagged image to any moderator', async () => {
    await expectTiers('anyMod', [26, 1]);
  });

  it('keeps an image whose hash is a CSAM block to cleared moderators', async () => {
    await expectTiers('cleared', [27]);
  });

  it('keeps an image whose label item is on a csam hold to cleared moderators', async () => {
    await expectTiers('cleared', [28]);
  });

  it('keeps a csam scan flag to cleared moderators, but not a minor or clean one', async () => {
    await expectTiers('cleared', [29]);
    await expectTiers('anyMod', [30, 2]);
  });

  it('keeps a csam vote to cleared moderators, but not a minor vote or another reason', async () => {
    await expectTiers('cleared', [31]);
    await expectTiers('anyMod', [32, 2]);
  });

  it('keeps an AiNotVerified image of a held or reported owner to cleared moderators', async () => {
    // Evidence-held owner, report subject, report secondary user.
    await expectTiers('cleared', [19, 21, 22]);
  });

  it('keeps an image listed on a report, in either list shape, to cleared moderators', async () => {
    await expectTiers('cleared', [23, 24]);
  });

  it('keeps an image of an owner banned for minor safety to cleared moderators', async () => {
    await pg.query(
      `INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (990000110, 'key-990000110', 'Blocked', 'moderated', 990100110)`
    );
    await pg.query(
      `INSERT INTO "User" (id, meta) VALUES (990100110, '{"banDetails": {"reasonCode": "SexualMinor"}}')`
    );
    try {
      await expectTiers('cleared', [990000110]);
      await pg.query(`UPDATE "User" SET meta = '{}' WHERE id = 990100110`);
      await expectTiers('anyMod', [990000110]);
    } finally {
      await pg.exec(
        `DELETE FROM "Image" WHERE id = 990000110; DELETE FROM "User" WHERE id = 990100110;`
      );
    }
  });
});

describe('the eligibility read', () => {
  it('runs under a statement timeout, so a slow read refuses instead of hanging', async () => {
    // A transaction client of its own, so a SET on the pool instead of the transaction shows.
    const tx = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRaw: (...args: unknown[]) =>
        (dbMock.dbWrite.$queryRaw as unknown as (...a: unknown[]) => unknown)(...args),
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (fn: (t: typeof tx) => unknown) =>
      fn(tx)) as never);
    const queryRaw = vi.spyOn(tx, '$queryRaw');
    dbMock.dbWrite.$executeRawUnsafe.mockClear();
    await getRetractedMedia(1, { csamReview: false });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/^SET LOCAL statement_timeout = \d+$/)
    );
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
    // Before the read, so the read is the statement it bounds.
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      queryRaw.mock.invocationCallOrder[0]
    );
  });
});

describe('copies sharing bytes with a restricted image', () => {
  // 990000101: a blocked image with a routine reason whose url another row shares. 990000103: a blocked image with a routine reason
  // whose pHash another row has. Each test lists or holds the other row, then removes it.
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", minor, "nsfwLevel", "userId", "pHash") VALUES
        (990000101, 'key-990000101', 'Blocked', 'moderated', false, 4, 990100101, NULL),
        (990000102, 'key-990000101', 'Scanned', NULL, false, 4, 990100102, NULL),
        (990000103, 'key-990000103', 'Blocked', 'moderated', false, 4, 990100103, 990990990),
        (990000104, 'key-990000104', 'Scanned', NULL, false, 4, 990100104, 990990990);
    `);
  });
  afterEach(async () => {
    await pg.exec(`
      DELETE FROM "CsamReport" WHERE "userId" = 990100199;
      DELETE FROM "EvidenceHoldImage" WHERE "imageId" IN (990000102, 990000105);
      DELETE FROM "ImageCdnModeratorDelete" WHERE "imageId" = 990000105;
      DELETE FROM "EvidenceHeldUser" WHERE "userId" = 990100102;
      UPDATE "Image" SET "needsReview" = NULL, minor = false WHERE id = 990000102;
    `);
  });

  const report = (imageId: number) =>
    pg.query(`INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100199, '{}', $1)`, [
      JSON.stringify([{ id: imageId }]),
    ]);
  const deletedCopy = () =>
    pg.query(
      `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES (990000105, 'key-990000101', 990100105, false)`
    );

  it('serves both images to any moderator while no copy is reported or held', async () => {
    await expectTiers('anyMod', [990000101, 990000103]);
  });

  it.each([
    ['a reported row on the same url', 990000101, () => report(990000102)],
    ['a reported row with the same pHash', 990000103, () => report(990000104)],
    [
      'a reported, deleted copy on the same url',
      990000101,
      async () => {
        await deletedCopy();
        await report(990000105);
      },
    ],
    [
      'an unreported copy on the same url in review',
      990000101,
      () => pg.query(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 990000102`),
    ],
    [
      'a copy on the same url whose owner is held',
      990000101,
      () => pg.query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (990100102)`),
    ],
    [
      'a sent report listing it',
      990000101,
      () =>
        pg.query(
          `INSERT INTO "CsamReport" ("userId", details, images, "reportSentAt") VALUES (990100199, '{}', '[990000101]', now())`
        ),
    ],
    [
      'a held row on the same url',
      990000101,
      () => pg.query(`INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (990000102)`),
    ],
  ])('keeps an image with %s to cleared moderators', async (_label, id, mark) => {
    await mark();
    await expectTiers('cleared', [id]);
  });
});

describe('a model version unpublished for its subject', () => {
  // 990000121: a blocked image with a routine reason on post 990400121, whose version carries the reason.
  // 990000122: a blocked image with a routine reason whose url a row on that post shares.
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (990300121, '{"unpublishedReason": "mature-underage"}', NULL);
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400121, '{}', 990300121);
    `);
  });

  it('leaves the image itself open to any moderator', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000121, 'key-990000121', 'Blocked', 'moderated', 990100121, 990400121)
    `);
    expect(await getRetractedMedia(990000121, { csamReview: false })).toMatchObject({
      url: 'key-990000121',
    });
  });

  it('keeps an image on a model a confirmed CSAM hold removed to cleared moderators', async () => {
    await pg.exec(`
      INSERT INTO "Model" (id, meta) VALUES (990500126, '{"unpublishedReason": "mature-underage"}');
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (990300126, '{}', 990500126);
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400126, '{}', 990300126);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000126, 'key-990000126', 'Blocked', 'moderated', 990100126, 990400126),
        (990000127, 'key-990000127', 'Blocked', 'moderated', 990100127, NULL),
        (990000128, 'key-990000127', 'Scanned', NULL, 990100128, 990400126);
    `);
    // Removed by a moderator for its subject alone: the image itself is open, and an image whose
    // url a row on that model shares is kept, by the held-url rule.
    expect(await getRetractedMedia(990000126, { csamReview: false })).toMatchObject({
      url: 'key-990000126',
    });
    expect(await getRetractedMedia(990000127, { csamReview: false })).toBeNull();
    // A hold that does not mark this model as CSAM leaves it open.
    for (const hold of [
      `('Model', 990500126, 'csam', 'Dismissed')`,
      `('Model', 990500126, 'other', 'Confirmed')`,
      `('Article', 990500126, 'csam', 'Confirmed')`,
      `('Model', 990500999, 'csam', 'Confirmed')`,
    ]) {
      await pg.exec(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ${hold}`
      );
      try {
        expect({
          hold,
          served: !!(await getRetractedMedia(990000126, { csamReview: false })),
        }).toEqual({
          hold,
          served: true,
        });
      } finally {
        await pg.exec(
          `DELETE FROM "TextScanHold" WHERE "entityId" IN (990500126, 990500999, 990400129, 990400999)`
        );
      }
    }
    // A pending hold restricts too.
    await pg.exec(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Model', 990500126, 'csam', 'Pending')`
    );
    try {
      expect(await getRetractedMedia(990000126, { csamReview: false })).toBeNull();
    } finally {
      await pg.exec(
        `DELETE FROM "TextScanHold" WHERE "entityId" IN (990500126, 990500999, 990400129, 990400999)`
      );
    }
    await pg.exec(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Model', 990500126, 'csam', 'Confirmed')`
    );
    try {
      expect(await getRetractedMedia(990000126, { csamReview: false })).toBeNull();
      expect(await getRetractedMedia(990000126, { csamReview: true })).toMatchObject({
        url: 'key-990000126',
      });
    } finally {
      await pg.exec(`DELETE FROM "TextScanHold" WHERE "entityId" = 990500126`);
    }
  });

  it('keeps an image whose url a row with that reason shares to cleared moderators', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000122, 'key-990000122', 'Blocked', 'moderated', 990100122, NULL),
        (990000123, 'key-990000122', 'Scanned', NULL, 990100123, 990400121)
    `);
    expect(await getRetractedMedia(990000122, { csamReview: false })).toBeNull();
    expect(await getRetractedMedia(990000122, { csamReview: true })).toMatchObject({
      url: 'key-990000122',
    });
  });

  it('keeps an image on a post a CSAM hold removed, after the post is republished', async () => {
    await pg.exec(`
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400129, '{"unpublishedReason": "csam-text-hold"}', NULL);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000129, 'key-990000129', 'Blocked', 'moderated', 990100129, 990400129);
      INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Post', 990400129, 'csam', 'Confirmed');
    `);
    try {
      expect(await getRetractedMedia(990000129, { csamReview: false })).toBeNull();
      // With the post's reason cleared, the hold still restricts.
      await pg.exec(`UPDATE "Post" SET metadata = '{}' WHERE id = 990400129`);
      expect(await getRetractedMedia(990000129, { csamReview: false })).toBeNull();
      await pg.exec(`UPDATE "TextScanHold" SET status = 'Pending' WHERE "entityId" = 990400129`);
      expect(await getRetractedMedia(990000129, { csamReview: false })).toBeNull();
      // A hold that does not mark this post as CSAM leaves it open.
      for (const hold of [
        `'Post', 990400129, 'csam', 'Dismissed'`,
        `'Post', 990400129, 'other', 'Confirmed'`,
        `'Model', 990400129, 'csam', 'Confirmed'`,
        `'Post', 990400999, 'csam', 'Confirmed'`,
      ]) {
        await pg.exec(`DELETE FROM "TextScanHold" WHERE "entityId" IN (990400129, 990400999)`);
        await pg.exec(
          `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES (${hold})`
        );
        expect({
          hold,
          served: !!(await getRetractedMedia(990000129, { csamReview: false })),
        }).toEqual({
          hold,
          served: true,
        });
      }
    } finally {
      await pg.exec(
        `DELETE FROM "TextScanHold" WHERE "entityId" IN (990500126, 990500999, 990400129, 990400999)`
      );
    }
  });

  it('keeps an image whose own post is on a CSAM hold to cleared moderators', async () => {
    await pg.exec(`
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

describe('rows sharing its url, its post text and its articles', () => {
  const target = { id: 990900000, url: 'key-990900000' };
  beforeAll(async () => {
    await pg.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor") VALUES (990900000, 'key-990900000', 990910000, 'Blocked', 'moderated')`
    );
  });
  beforeEach(() => {
    scanner.verdict = 'clear';
  });
  afterEach(async () => {
    await pg.exec(csamCaseCleanupSql(target));
  });

  it('keeps an image whose url a row the scanner marks shares to cleared moderators', async () => {
    await pg.exec(
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

  it.each(CSAM_RESTRICTION_CASES.filter((c) => c.restricts))(
    'keeps an image with $label to cleared moderators',
    async ({ mark }) => {
      await pg.exec(mark(target));
      expect(await getRetractedMedia(target.id, { csamReview: false })).toBeNull();
      expect(await getRetractedMedia(target.id, { csamReview: true })).toMatchObject({
        url: target.url,
      });
    }
  );

  it.each(CSAM_RESTRICTION_CASES.filter((c) => !c.restricts))(
    'serves an image with $label to any moderator',
    async ({ mark }) => {
      await pg.exec(mark(target));
      expect(await getRetractedMedia(target.id, { csamReview: false })).toMatchObject({
        url: target.url,
      });
    }
  );
});
