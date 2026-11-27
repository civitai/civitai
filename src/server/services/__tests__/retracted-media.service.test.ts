import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
  CSAM_RESTRICTION_CASES,
  csamCaseCleanupSql,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';
import { POST_PENDING_DELETE_REASON } from '@civitai/db-queries/content-deletion';
import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  heldImageSql,
  heldUserSql,
} from '@civitai/shared/held-media';
import { heldUrlSql } from '@civitai/shared/held-url';
import { semanticImageHeldText } from '~/server/services/semantic-image-flags.sql';

/**
 * Which images `/api/mod/retracted-media` serves, and to whom: the shared `retracted-media-tier`
 * SQL, run against real SQL. Each case differs from an `anyMod` one in a single column or row, so each
 * assertion pins one leg of the statement.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;

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
    ${WITHHELD_TABLES_SQL}
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
    INSERT INTO "ImageCdnAccess" (url, state) VALUES ('key-12', 'Retracted');
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES (26, ${childBrowsingTagIds[0]});
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", disabled) VALUES (1, ${childBrowsingTagIds[0]}, true);
    INSERT INTO "BlockedImage" (hash, reason) VALUES (777, 'CSAM');
    INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES
      (1, 28, 'csam-hold'), (2, 29, NULL), (3, 30, NULL), (4, 31, NULL), (5, 32, NULL), (6, 2, NULL);
    INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES
      (2, '{"csam": "true"}'), (3, '{"minorDetected": "true"}'), (6, '{"csam": "false"}');
    INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES (4, 'csam-realistic'), (5, 'minor-other'), (6, 'other');
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
  scanner.verdict = 'clear';
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { getRetractedMedia, getOwnRetractedMedia } = await import(
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
      held: false,
    });
  });

  // The moderator-view rule reads Postgres only: no scanner verdict, read or missing, withholds.
  it('serves an image to any moderator whatever the scanner says, or when it cannot answer', async () => {
    for (const verdict of ['hit', null, 'none'] as const) {
      scanner.verdict = verdict;
      expect({ verdict, tier: await tierOf(1) }).toEqual({ verdict, tier: 'anyMod' });
    }
    expect(readScannerVerdict).not.toHaveBeenCalled();
  });

  it('survives a report with a malformed secondary user or image list', async () => {
    await expectTiers('anyMod', [1]);
  });

  // civitai/civitai#10202: only item-level CSAM signals withhold from a moderator without the grant.
  it('serves a block with no reason to any moderator', async () => {
    await expectTiers('anyMod', [4]);
  });

  // civitai/civitai#10377: only a CSAM block reason withholds.
  it('serves any block reason but CSAM to any moderator', async () => {
    await expectTiers('anyMod', [10]);
  });

  it('keeps an image a CSAM report lists to cleared moderators, whatever its block reason', async () => {
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

  it.each([
    ['a CSAM block reason', 11, 'none'],
    // civitai/civitai#10202: a block with no reason no longer withholds.
    ['a block with no reason', 4, 'anyMod'],
    ['moderated', 1, 'anyMod'],
    ['tos', 2, 'anyMod'],
    ['AiNotVerified', 3, 'anyMod'],
    ['an unlisted reason', 10, 'anyMod'],
  ])('gives %s the access the rule names', async (_, id, tier) => {
    await expectTiers(tier, [id]);
  });

  it('never serves held media, which the held-media route serves', async () => {
    // CSAM block, CSAM review flag.
    await expectTiers('none', [11, 13]);
  });

  // civitai/civitai#10202: answered to any moderator as an ordinary account's would be.
  it("serves the image of a report's subject to any moderator, grant or not, as held media", async () => {
    expect(await getRetractedMedia(20, { csamReview: false })).toMatchObject({ held: true });
    expect(await getRetractedMedia(20, { csamReview: true })).toMatchObject({ held: true });
  });

  it('refuses a missing id', async () => {
    await expectTiers('none', [999]);
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

  it('serves an image whose label item is on a csam hold to any moderator', async () => {
    await expectTiers('anyMod', [28]);
  });

  it('serves an image with only an automated review flag, minor or clean, to any moderator', async () => {
    await expectTiers('anyMod', [29, 30, 2]);
  });

  it('keeps a csam vote to cleared moderators, but not a minor vote or another reason', async () => {
    await expectTiers('cleared', [31]);
    await expectTiers('anyMod', [32, 2]);
  });

  // civitai/civitai#10202: only item-level CSAM signals withhold from a moderator without the grant.
  it('serves an AiNotVerified image of a reported owner to any moderator', async () => {
    // Report subject, report secondary user.
    await expectTiers('anyMod', [21, 22]);
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

  it('serves a blocked image on it, on one with no retraction time, or on an outright retraction to any moderator', async () => {
    await expectTiers('anyMod', [990000301, 990000302, 990000304, 990000303]);
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
      DELETE FROM "ImageCdnModeratorDelete" WHERE "imageId" = 990000105;
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

  it('serves both images to any moderator while no copy is reported', async () => {
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

  // civitai/civitai#10202: only item-level CSAM signals withhold from a moderator without the grant.
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

  // civitai/civitai#10202: only item-level CSAM signals withhold from a moderator without the grant.
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

  it('serves a scanned image on a url retracted by an upgraded deny, or with no retraction time, to any moderator', async () => {
    await expectTiers('anyMod', [ids.upgraded, ids.noRetractTime], leg);
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

  // The route answers a null with 404: a moderator not cleared for CSAM review must not reach the
  // image of a report's owner through this leg.
  it('serves the image of a CsamReport owner to a moderator not cleared for CSAM review, as held media', async () => {
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100204, '{}', '[]')`
    );
    expect(
      await getRetractedMedia(ids.retracted, { csamReview: false, cdnLeg: true })
    ).toMatchObject({ held: true });
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

// civitai/civitai#10202: the shape of a reported case. A moderator unpublished the post, and the
// model was pulled, so the CDN denies the url. With the leg off, any moderator still sees it.
describe('a scanned image whose post someone other than its owner unpublished', () => {
  const OWNER = 990100310;
  const ids = {
    pulled: 990000310,
    signal: 990000311,
    item: 990000312,
    shop: 990000313,
    deleted: 990000314,
    live: 990000315,
    ownPull: 990000316,
    keptDelete: 990000317,
  };
  const all = Object.values(ids);
  const posts: Record<number, number> = {
    [ids.live]: 990400315,
    [ids.ownPull]: 990400316,
    [ids.keptDelete]: 990400317,
  };
  const post = (id: number) => posts[id] ?? 990400310;
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "Post" (id, metadata, "modelVersionId", "userId", "publishedAt") VALUES
        (990400310, '{"unpublishedAt": "2026-11-18", "unpublishedBy": "990100399"}', NULL, ${OWNER}, NULL),
        (990400315, '{}', NULL, ${OWNER}, now()),
        (990400316, '{"unpublishedAt": "2026-11-18", "unpublishedBy": "${OWNER}"}', NULL, ${OWNER}, NULL),
        (990400317, '{"unpublishedAt": "2026-11-18", "unpublishedBy": "990100399", "unpublishedReason": "${POST_PENDING_DELETE_REASON}"}', NULL, ${OWNER}, NULL);
      INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId", "userId") VALUES ('key-${ids.shop}', 1, ${OWNER});
      INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview")
        VALUES (${ids.deleted}, 'key-${ids.deleted}', ${OWNER}, false);
      INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ids.signal}, ${ids.signal}, 'csam-hold');
    `);
    for (const id of all)
      await pg.query(
        `INSERT INTO "Image" (id, url, ingestion, "needsReview", minor, "nsfwLevel", "userId", "postId")
         VALUES ($1, $2, 'Scanned', $3, true, 2, $4, $5)`,
        [id, `key-${id}`, id === ids.item ? 'csam' : null, OWNER, post(id)]
      );
    await pg.query(
      `INSERT INTO "ImageCdnAccess" (url, state) SELECT 'key-' || id, 'Denied' FROM unnest($1::int[]) id`,
      [all]
    );
  });

  it('serves it to any moderator, with the leg off', async () => {
    await expectTiers('anyMod', [ids.pulled]);
    expect(await getRetractedMedia(ids.pulled, { csamReview: false })).toEqual({
      url: `key-${ids.pulled}`,
      type: 'image',
      mimeType: null,
      held: false,
    });
  });

  it('refuses it with a CSAM mark of its own, or held for itself', async () => {
    await expectTiers('none', [ids.signal, ids.item]);
  });

  it('refuses a url a shop takedown or a moderator delete also refuses', async () => {
    await expectTiers('none', [ids.shop, ids.deleted]);
  });

  it('refuses a denied url no unpublish by someone else explains', async () => {
    await expectTiers('none', [ids.live, ids.ownPull]);
  });

  it('refuses a post a delete its case keeps unpublished', async () => {
    await expectTiers('none', [ids.keptDelete]);
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

  it('serves an image whose url a row the scanner marks shares to any moderator', async () => {
    await pg.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion) VALUES (990900001, 'key-990900000', 990910001, 'Scanned')`
    );
    scanner.hits.add(990900001);
    try {
      expect(await getRetractedMedia(target.id, { csamReview: false })).toMatchObject({
        url: target.url,
      });
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

  // civitai/civitai#10202: held media is answered to any moderator, grant or not, as its twin would
  // be, marked held for the audit.
  it.each(CSAM_RESTRICTION_CASES.filter((c) => c.held))(
    'serves an image with $label to any moderator, as held media',
    async ({ mark }) => {
      await pg.exec(mark(target));
      for (const csamReview of [false, true])
        expect(await getRetractedMedia(target.id, { csamReview })).toMatchObject({
          url: target.url,
          held: true,
        });
    }
  );

  it.each(CSAM_RESTRICTION_CASES.filter((c) => !c.restricts && !c.held))(
    'serves an image with $label to any moderator',
    async ({ mark }) => {
      await pg.exec(mark(target));
      expect(await getRetractedMedia(target.id, { csamReview: false })).toMatchObject({
        url: target.url,
      });
    }
  );
});

// civitai/civitai#10202: only the moderator routes open a held account's media.
describe("a held account's image outside the moderator routes", () => {
  const OWNER = 990100300;
  const IMAGE = 990000300;
  beforeAll(async () => {
    await pg.exec(`INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${IMAGE}, 'key-${IMAGE}', 'Blocked', 'moderated', ${OWNER})`);
  });

  // heldUrlSql's default is cdn-access's rule for the public CDN; heldImageSql is the held-media rule.
  it.each([
    [
      'the subject of a CSAM report',
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (${OWNER}, '{}', '[]')`,
    ],
    [
      'the secondary user of a CSAM report',
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100301, '{"secondaryUserId": "${OWNER}"}', '[]')`,
    ],
  ])('stays held everywhere outside the moderator routes when its owner is %s', async (_, mark) => {
    await pg.exec(mark);
    try {
      const { rows } = await pg.query(`SELECT ${heldImageSql('i')} AS held,
          ${semanticImageHeldText('i')} AS semantic, ${heldUserSql('i."userId"')} AS owner,
          ${heldUrlSql('i."url"')} AS cdn
        FROM "Image" i WHERE i.id = ${IMAGE}`);
      expect(rows).toEqual([{ held: true, semantic: true, owner: true, cdn: true }]);
      expect(await getRetractedMedia(IMAGE, { csamReview: false })).toMatchObject({ held: true });
    } finally {
      await pg.exec(`DELETE FROM "CsamReport" WHERE "userId" IN (${OWNER}, 990100301)`);
    }
  });
});

describe('getOwnRetractedMedia', () => {
  const ownerOf = (id: number) => 500 + id;
  beforeAll(async () => {
    // `ownerMediaAllowedSql` compares the column as the enum it is in the real schema.
    // A moderated image whose url another row, blocked as CSAM, shares; and one with a clean sibling.
    await pg.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
      ALTER TABLE "Image" ALTER COLUMN ingestion TYPE "ImageIngestionStatus" USING ingestion::"ImageIngestionStatus";
      -- What \`imageVisibilityConditions\` reads beyond the tables above.
      DO $$ BEGIN CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE "ServiceOfferingStatus" AS ENUM ('Draft', 'Active', 'Paused', 'Removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "nsfwLevelLocked" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS "scanJobs" jsonb,
        ADD COLUMN IF NOT EXISTS "modelRestricted" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS poi boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "tosViolation" boolean NOT NULL DEFAULT false;
      ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS availability "Availability" DEFAULT 'Public',
        ADD COLUMN IF NOT EXISTS "collectionId" int;
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedAt" timestamp, ADD COLUMN IF NOT EXISTS "deletedAt" timestamp,
        ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}';
      ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS mode text, ADD COLUMN IF NOT EXISTS minor boolean,
        ADD COLUMN IF NOT EXISTS "sfwOnly" boolean, ADD COLUMN IF NOT EXISTS "gallerySettings" jsonb;
      ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS "publishedAt" timestamp,
        ADD COLUMN IF NOT EXISTS ingestion text, ADD COLUMN IF NOT EXISTS availability "Availability" DEFAULT 'Public',
        ADD COLUMN IF NOT EXISTS "userId" int;
      CREATE TABLE IF NOT EXISTS "CollectionContributor" ("collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]);
      CREATE TABLE IF NOT EXISTS "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
      CREATE TABLE IF NOT EXISTS "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
      CREATE TABLE IF NOT EXISTS "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
      ALTER TABLE "ServiceOffering" ADD COLUMN IF NOT EXISTS "sellerId" int,
        ADD COLUMN IF NOT EXISTS "allowReviewWork" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS status "ServiceOfferingStatus" NOT NULL DEFAULT 'Active';
      CREATE TABLE IF NOT EXISTS "ServiceDeal" (id int PRIMARY KEY, "offeringId" int NOT NULL, "sellerId" int NOT NULL,
        "buyerId" int NOT NULL, "maxNsfwLevel" int NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS "ServiceDealReview" (id int PRIMARY KEY, "dealId" int NOT NULL, "buyerId" int NOT NULL,
        "sellerId" int NOT NULL, "publishedAt" timestamp, "hiddenAt" timestamp);
      CREATE TABLE IF NOT EXISTS "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL UNIQUE, "sourceFileId" int);
      CREATE TABLE IF NOT EXISTS "ServiceDealFile" (id serial PRIMARY KEY, "imageId" int);
      CREATE TABLE IF NOT EXISTS "ServiceDealFileEntry" (id serial PRIMARY KEY, "fileId" int, "imageId" int);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
        (900, 'key-900', 'Blocked', 'moderated', 1400),
        (901, 'key-900', 'Blocked', 'CSAM', 1401),
        (902, 'key-902', 'Blocked', 'tos,moderated', 1402),
        (903, 'key-902', 'Scanned', NULL, 1403),
        (904, 'key-904', 'Blocked', 'moderated,csam', 1404);
      INSERT INTO "CsamReport" ("userId", details, images) VALUES (1402, '{}', '[]');
    `);
  });
  const own = (id: number, userId = ownerOf(id)) => getOwnRetractedMedia(id, userId);

  it('serves the owner a moderated or tos block with no CSAM mark', async () => {
    expect(await own(1)).toMatchObject({
      url: 'key-1',
      type: 'image',
      mimeType: null,
      nsfwLevel: 4,
    });
    expect(await own(2)).toMatchObject({ url: 'key-2', type: 'image', mimeType: null });
  });

  it('serves the owner a report-listed image with no CSAM mark, and a held owner their own', async () => {
    expect(await own(23)).not.toBeNull();
    expect(await own(24)).not.toBeNull();
    expect(await own(902)).toMatchObject({ url: 'key-902', type: 'image', mimeType: null });
  });

  it('never serves anyone else', async () => {
    expect(await own(1, ownerOf(2))).toBeNull();
    expect(await own(1, 42)).toBeNull();
  });

  it.each([
    ['blocked as CSAM', 11],
    ['in the CSAM queue', 13],
    ['a CSAM hash block', 27],
    ['a CSAM hold', 28],
    ['a CSAM scan flag', 29],
    ['a CSAM vote', 31],
    ['a url sibling blocked as CSAM', 900],
    ['csam in the list', 904],
    ['an unknown reason', 10],
    ['a differently cased reason', 5],
    ['the metadata hold, which the CDN serves', 3],
    ['no block', 4],
  ])('refuses the owner an image with %s', async (_, id) => {
    expect(await own(id)).toBeNull();
  });

  it("refuses the owner Y when a moderator deleted X, a copy on Y's url, for CSAM review", async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (905, 'key-905', 'Blocked', 'moderated', 1405);
      INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES (906, 'key-905', 1405, true);
    `);
    expect(await own(905)).toBeNull();
    expect(await getRetractedMedia(905, { csamReview: false })).toBeNull();
    await pg.exec(
      `UPDATE "ImageCdnModeratorDelete" SET "csamReview" = false WHERE "imageId" = 906`
    );
    expect(await own(905)).not.toBeNull();
  });

  // Whatever row shape makes the moderator route refuse a moderator without the CSAM grant (and
  // serve one with it), the owner route refuses too, except where the mark is the image's own
  // listing on a CSAM report, which its owner keeps by ruling.
  describe('refuses the owner whatever the moderator route keeps to the CSAM grant', () => {
    const target = { id: 990900000, url: 'key-990900000' };
    const OWNER = 990910000;
    afterEach(async () => {
      await pg.exec(csamCaseCleanupSql(target));
    });
    /** The one divergence the ruling allows: the target's own row listed on a CSAM report. */
    const ownListed = async () =>
      (
        await pg.query<{ listed: boolean }>(
          `SELECT (i.id)::text IN (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}) AS listed FROM "Image" i WHERE i.id = $1`,
          [target.id]
        )
      ).rows[0].listed;

    it('serves the owner the target with no case marked (the control)', async () => {
      expect(await getOwnRetractedMedia(target.id, OWNER)).not.toBeNull();
    });

    const grantOnly: string[] = [];
    const listedOnly: string[] = [];
    it.each(CSAM_RESTRICTION_CASES)('$label', async ({ label, mark }) => {
      await pg.exec(mark(target));
      const withheld =
        (await getRetractedMedia(target.id, { csamReview: false })) === null &&
        (await getRetractedMedia(target.id, { csamReview: true })) !== null;
      if (!withheld) return;
      grantOnly.push(label);
      if ((await getOwnRetractedMedia(target.id, OWNER)) === null) return;
      expect({ label, ownListed: await ownListed() }).toEqual({ label, ownListed: true });
      listedOnly.push(label);
    });

    it('saw the moderator route keep cases to the grant, and the owner route refuse most', () => {
      expect(grantOnly.length).toBeGreaterThan(5);
      expect(listedOnly.length).toBeLessThan(grantOnly.length);
      expect(listedOnly).toEqual(['its listing on a CSAM report']);
      expect(grantOnly).toContain('a moderator delete on its url flagged for CSAM review');
    });
  });
});
