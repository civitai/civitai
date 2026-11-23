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
import { heldImageSql, heldUserSql } from '@civitai/shared/held-media';
import { heldUrlSql } from '@civitai/shared/held-url';
import { semanticImageHeldText } from '~/server/services/semantic-held-content.sql';

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
  readScannerCsamVerdicts: async (ids: number[]) =>
    scanner.verdict === null
      ? null
      : new Map(ids.map((id) => [id, scanner.hits.has(id) ? 'hit' : scanner.verdict])),
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
    -- An outright retraction by default; an upgraded deny sets "deniedAt" earlier.
    CREATE TABLE "ImageCdnAccess" (
      url text PRIMARY KEY, state text NOT NULL,
      "deniedAt" timestamptz NOT NULL DEFAULT now(), "retractedAt" timestamptz DEFAULT now()
    );
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
    CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, "textHash" TEXT, meta JSONB);
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
const tierOf = async (id: number, { cdnLeg = false } = {}) => {
  const cleared = await getRetractedMedia(id, { csamReview: true, cdnLeg });
  const anyModAnswer = await getRetractedMedia(id, { csamReview: false, cdnLeg });
  const anyMod = typeof anyModAnswer === 'string' ? null : anyModAnswer;
  if (!cleared) {
    expect(anyMod).toBeNull();
    return 'none';
  }
  return anyMod ? 'anyMod' : 'cleared';
};

const expectTiers = async (tier: string, ids: number[], opts: { cdnLeg?: boolean } = {}) => {
  for (const id of ids) expect({ id, tier: await tierOf(id, opts) }).toEqual({ id, tier });
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

  it('serves a block with no reason to any moderator', async () => {
    await expectTiers('anyMod', [4]);
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

  // A minor flag alone lets any moderator see the media; only a CSAM signal, report or hold keeps it
  // to cleared moderators. The private patterns name which block reasons are minor-only.
  describe('a block reason the patterns list as minor-only', () => {
    const MINOR = { signal: [], nonMinor: [], minor: [/^scan-reason-/u] };

    it('is open to any moderator', async () => {
      patterns.current = MINOR;
      await expectTiers('anyMod', [10]);
    });

    it('stays with cleared moderators while the patterns have no minor section', async () => {
      patterns.current = { signal: [], nonMinor: [] };
      await expectTiers('cleared', [10]);
    });

    it('stays with cleared moderators when the scanner marks the image as CSAM', async () => {
      patterns.current = MINOR;
      scanner.hits.add(10);
      try {
        await expectTiers('cleared', [10]);
      } finally {
        scanner.hits.delete(10);
      }
    });

    it('stays with cleared moderators when a CSAM report lists the image', async () => {
      patterns.current = MINOR;
      await pg.exec(`
        INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId")
          VALUES (990000120, 'key-990000120', 'Blocked', 'scan-reason-y', 990100120);
        INSERT INTO "CsamReport" ("userId", details, images) VALUES (NULL, '{}', '[990000120]');
      `);
      try {
        await expectTiers('cleared', [990000120]);
      } finally {
        await pg.exec(`
          DELETE FROM "CsamReport" WHERE images = '[990000120]';
          DELETE FROM "Image" WHERE id = 990000120;
        `);
      }
    });

    it('does not open a reason a signal pattern also matches', async () => {
      patterns.current = { ...MINOR, signal: [/^scan-reason-x$/u] };
      await expectTiers('cleared', [10]);
    });

    // The SQL and the block-reason read decide together: over the same reasons, the route gives
    // each the access the rule names.
    it.each([
      ['a CSAM block reason', 11, 'none'],
      ['a block with no reason', 4, 'anyMod'],
      ['moderated', 1, 'anyMod'],
      ['tos', 2, 'anyMod'],
      ['AiNotVerified', 3, 'anyMod'],
      ['a minor-only reason', 10, 'anyMod'],
    ])('gives %s the access the rule names', async (_, id, tier) => {
      patterns.current = MINOR;
      await expectTiers(tier, [id]);
    });
  });

  it('never serves held media, which the held-media route serves', async () => {
    // CSAM block, CSAM review flag.
    await expectTiers('none', [11, 13]);
  });

  it("serves the image of a report's subject to any moderator", async () => {
    await expectTiers('anyMod', [20]);
  });

  it('refuses a missing id', async () => {
    await expectTiers('none', [999]);
  });

  it('keeps an image under an evidence hold to cleared moderators', async () => {
    await expectTiers('cleared', [18]);
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

  it('serves an AiNotVerified image of a held or reported owner to any moderator', async () => {
    // Evidence-held owner, report subject, report secondary user.
    await expectTiers('anyMod', [19, 21, 22]);
  });

  it('keeps an image listed on a report, in either list shape, to cleared moderators', async () => {
    await expectTiers('cleared', [23, 24]);
  });

  it('serves an image of an owner banned for minor safety to any moderator', async () => {
    await pg.query(
      `INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (990000110, 'key-990000110', 'Blocked', 'moderated', 990100110)`
    );
    await pg.query(
      `INSERT INTO "User" (id, meta) VALUES (990100110, '{"banDetails": {"reasonCode": "SexualMinor"}}')`
    );
    try {
      await expectTiers('anyMod', [990000110]);
    } finally {
      await pg.exec(
        `DELETE FROM "Image" WHERE id = 990000110; DELETE FROM "User" WHERE id = 990100110;`
      );
    }
  });
});

describe('a url retracted by a deny upgraded later', () => {
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
        (990000301, 'key-990000301', 'Blocked', 'moderated', 990100301),
        (990000302, 'key-990000302', 'Blocked', 'moderated', 990100302),
        (990000303, 'key-990000303', 'Blocked', 'moderated', 990100303),
        (990000304, 'key-990000304', 'Blocked', 'moderated', 990100304);
      INSERT INTO "ImageCdnAccess" (url, state, "deniedAt", "retractedAt") VALUES
        ('key-990000301', 'Retracted', now() - interval '5 minutes', now()),
        ('key-990000302', 'Retracted', now(), NULL),
        ('key-990000303', 'Retracted', now(), now()),
        ('key-990000304', 'Retracted', now() - interval '30 seconds', now());
    `);
  });

  it('keeps a blocked image on it, or on one with no retraction time, to cleared moderators', async () => {
    await expectTiers('cleared', [990000301, 990000302, 990000304]);
  });

  it('leaves a blocked image on an outright retraction open to any moderator', async () => {
    await expectTiers('anyMod', [990000303]);
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

  it('serves an image on a model a CSAM hold removed to any moderator', async () => {
    await pg.exec(`
      INSERT INTO "Model" (id, meta) VALUES (990500126, '{"unpublishedReason": "mature-underage"}');
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (990300126, '{}', 990500126);
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (990400126, '{}', 990300126);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000126, 'key-990000126', 'Blocked', 'moderated', 990100126, 990400126);
    `);
    for (const status of ['Pending', 'Confirmed']) {
      await pg.exec(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('Model', 990500126, 'csam', '${status}')`
      );
      try {
        expect({
          status,
          served: !!(await getRetractedMedia(990000126, { csamReview: false })),
        }).toEqual({ status, served: true });
      } finally {
        await pg.exec(`DELETE FROM "TextScanHold" WHERE "entityId" = 990500126`);
      }
    }
  });

  it('leaves an image whose url a row with that reason shares open to any moderator', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "postId") VALUES
        (990000122, 'key-990000122', 'Blocked', 'moderated', 990100122, NULL),
        (990000123, 'key-990000122', 'Scanned', NULL, 990100123, 990400121)
    `);
    expect(await getRetractedMedia(990000122, { csamReview: false })).toMatchObject({
      url: 'key-990000122',
    });
  });

  it('serves an image on a post a CSAM hold removed to any moderator', async () => {
    await pg.exec(`
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
      await pg.exec(`DELETE FROM "TextScanHold" WHERE "entityId" = 990400129`);
    }
  });
});

describe('the CDN-refusal leg (modRetractedMediaCdnLeg)', () => {
  const ids = {
    retracted: 990000204,
    denied: 990000201,
    served: 990000202,
    pending: 990000203,
    upgraded: 990000205,
    noRetractTime: 990000206,
  };
  const leg = { cdnLeg: true };
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
        (990000201, 'key-990000201', 'Scanned', NULL, 990100201),
        (990000202, 'key-990000202', 'Scanned', NULL, 990100202),
        (990000203, 'key-990000203', 'Pending', NULL, 990100203),
        (990000204, 'key-990000204', 'Scanned', NULL, 990100204),
        (990000205, 'key-990000205', 'Scanned', NULL, 990100205),
        (990000206, 'key-990000206', 'Scanned', NULL, 990100206);
      INSERT INTO "ImageCdnAccess" (url, state) VALUES
        ('key-990000201', 'Denied'), ('key-990000203', 'Retracted'), ('key-990000204', 'Retracted');
      INSERT INTO "ImageCdnAccess" (url, state, "deniedAt", "retractedAt") VALUES
        ('key-990000205', 'Retracted', now() - interval '30 seconds', now()),
        ('key-990000206', 'Retracted', now(), NULL);
    `);
  });
  afterEach(async () => {
    await pg.exec(`
      DELETE FROM "CsamReport" WHERE "userId" = 990100204;
      DELETE FROM "User" WHERE id = 990100204;
    `);
  });

  it('serves a scanned image whose url the CDN retracted to any moderator', async () => {
    await expectTiers('anyMod', [ids.retracted], leg);
  });

  it('keeps a scanned image on a url retracted by an upgraded deny, or with no retraction time, to cleared moderators', async () => {
    await expectTiers('cleared', [ids.upgraded, ids.noRetractTime], leg);
  });

  it('is off unless the route asks for it', async () => {
    await expectTiers('none', [ids.retracted]);
  });

  // A removed model or a banned owner leaves its url denied. A deny capping a hold stays safe: a held
  // row is not deleted while held (owner deletes wait for the case, moderator deletes are recorded
  // and refuse the url here), and a held row still present holds the url or restricts it.
  it('serves a scanned image whose url the CDN denied to any moderator', async () => {
    await expectTiers('anyMod', [ids.denied], leg);
  });

  it('refuses a url the CDN still serves, and one whose scan is not final', async () => {
    await expectTiers('none', [ids.served, ids.pending], leg);
  });

  it("reads a scanned image's verdict fresh each time, since a rescan can change it", async () => {
    await expectTiers('anyMod', [ids.retracted], leg);
    scanner.verdict = 'hit';
    expect(await getRetractedMedia(ids.retracted, { csamReview: false, cdnLeg: true })).toBeNull();
  });

  // The route answers a null with 404: a moderator not cleared for CSAM review must not reach the
  // image of a report's owner through this leg.
  it('serves the image of a CsamReport owner to a moderator not cleared for CSAM review', async () => {
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100204, '{}', '[]')`
    );
    expect(
      await getRetractedMedia(ids.retracted, { csamReview: false, cdnLeg: true })
    ).toMatchObject({
      url: expect.any(String),
    });
  });

  // A minor-safety ban alone is a minor signal, open to any moderator.
  it('serves the image of an owner banned for minor safety to any moderator', async () => {
    await pg.query(
      `INSERT INTO "User" (id, meta) VALUES (990100204, '{"banDetails": {"reasonCode": "SexualMinor"}}')`
    );
    expect(
      await getRetractedMedia(ids.retracted, { csamReview: false, cdnLeg: true })
    ).not.toBeNull();
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

describe("a held account's image outside the moderator view", () => {
  const OWNER = 990100300;
  const IMAGE = 990000300;
  beforeAll(async () => {
    await pg.exec(`INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${IMAGE}, 'key-${IMAGE}', 'Blocked', 'moderated', ${OWNER})`);
  });

  // heldImageSql also gates the held-media route, Knights eligibility and the semantic indexes;
  // heldUrlSql's default is cdn-access's rule for the public CDN.
  it.each([
    [
      'the subject of a CSAM report',
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (${OWNER}, '{}', '[]')`,
    ],
    [
      'the secondary user of a CSAM report',
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100301, '{"secondaryUserId": "${OWNER}"}', '[]')`,
    ],
    ['under an evidence hold', `INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${OWNER})`],
  ])('stays held everywhere but the moderator view when its owner is %s', async (_, mark) => {
    await pg.exec(mark);
    try {
      const { rows } = await pg.query(`SELECT ${heldImageSql('i')} AS held,
          ${semanticImageHeldText('i')} AS semantic, ${heldUserSql('i."userId"')} AS owner,
          ${heldUrlSql('i."url"')} AS cdn
        FROM "Image" i WHERE i.id = ${IMAGE}`);
      expect(rows).toEqual([{ held: true, semantic: true, owner: true, cdn: true }]);
      // A moderator without the grant gets the media and nothing about the hold.
      expect(await getRetractedMedia(IMAGE, { csamReview: false })).toEqual({
        url: `key-${IMAGE}`,
        type: 'image',
        mimeType: null,
      });
    } finally {
      await pg.exec(`DELETE FROM "CsamReport" WHERE "userId" IN (${OWNER}, 990100301);
        DELETE FROM "EvidenceHeldUser" WHERE "userId" = ${OWNER}`);
    }
  });
});
