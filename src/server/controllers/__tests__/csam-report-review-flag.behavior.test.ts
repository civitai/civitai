import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CsamService from '~/server/services/csam.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';
import type * as UserService from '~/server/services/user.service';

/**
 * Filing a report takes the moderator-only review flag off each reported image blocked as CSAM whose
 * owner it names, once that image is blocked. The flag stays on an image whose owner the report does
 * not name, and past the release cutoff on the owner's oldest open report.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
type FilingInput = { userId: number; imageIds?: number[]; blockListedImages?: boolean };
const fileInTransaction = vi.hoisted(
  () =>
    async ({ userId, imageIds = [], blockListedImages }: FilingInput) =>
      holder.db.transaction(async (tx) => {
        if (blockListedImages && imageIds.length)
          await tx.query(
            `UPDATE "Image" SET ingestion = 'Blocked', "nsfwLevel" = 32, "blockedFor" = 'CSAM' WHERE id = ANY($1)`,
            [imageIds]
          );
        const { rows } = await tx.query<{ id: number }>(
          `INSERT INTO "CsamReport" ("userId") VALUES ($1) RETURNING id`,
          [userId === -1 ? null : userId]
        );
        return rows[0];
      })
);

const { createCsamReport, createSupplementalCsamReport, softDeleteUser, afterCsamImageBlock } =
  vi.hoisted(() => ({
    afterCsamImageBlock: vi.fn(async () => undefined),
    // As the services do: the listed images are blocked in the report's own transaction.
    createSupplementalCsamReport: vi.fn(async (input: FilingInput) => fileInTransaction(input)),
    createCsamReport: vi.fn(async (input: FilingInput) => fileInTransaction(input)),
    softDeleteUser: vi.fn(async ({ id }: { id: number }) => {
      await holder.db.query(
        `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE "userId" = $1`,
        [id]
      );
    }),
  }));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/services/csam-supplemental.service', () => ({
  createSupplementalCsamReport,
  getCsamSupplementalPreview: vi.fn(),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  bulkAddBlockedImages: vi.fn(async () => undefined),
  afterCsamImageBlock,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus: vi.fn(async () => undefined),
}));

const OWNER = 8;
const OTHER_OWNER = 9;
const PRIOR_REPORT_OWNER = 10;
const EXPIRED_HOLD_OWNER = 11;
const NEAR_CEILING_OWNER = 12;
const INSIDE_MARGIN_OWNER = 13;
const PAST_MARGIN_OWNER = 14;

const OWNED = 61;
const OTHER_OWNERS = 62;
const UNBLOCKED_HELD = 63;
const OTHER_FLAG = 64;
const OTHER_OWNERS_SCANNED = 90;
const EXPIRED_HOLD = 65;
const NEAR_CEILING = 66;
const INSIDE_MARGIN = 67;
const PAST_MARGIN = 68;
const APPEALED = 69;
const APPEALED_UNLISTED = 70;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  holder.db = pg;
  await pg.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int,
      ingestion text,
      "needsReview" text,
      "blockedFor" text,
      "nsfwLevel" int,
      metadata jsonb
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]',
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ImageDeferredBlockEffect" ("imageId" int PRIMARY KEY);
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL
    );
  `);
});

beforeEach(async () => {
  createCsamReport.mockClear();
  softDeleteUser.mockClear();
  createSupplementalCsamReport.mockClear();
  afterCsamImageBlock.mockClear();
  await pg.exec(`
    TRUNCATE "Image", "CsamReport", "ImageDeferredBlockEffect", "Appeal";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${OWNED}, ${OWNER}, 'Scanned', 'csam'),
      (${OTHER_OWNERS}, ${OTHER_OWNER}, 'Blocked', 'csam'),
      (${UNBLOCKED_HELD}, ${PRIOR_REPORT_OWNER}, 'Scanned', 'csam'),
      (${OTHER_OWNERS_SCANNED}, ${OTHER_OWNER}, 'Scanned', NULL),
      (${OTHER_FLAG}, ${OWNER}, 'Blocked', 'minor'),
      (${APPEALED}, ${OTHER_OWNER}, 'Blocked', 'appeal'),
      (${APPEALED_UNLISTED}, ${OTHER_OWNER}, 'Blocked', 'appeal');
    INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES
      ('Image', ${APPEALED}, 'Pending'), ('Image', ${APPEALED_UNLISTED}, 'Pending');
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${EXPIRED_HOLD}, ${EXPIRED_HOLD_OWNER}, 'Blocked', 'csam'),
      (${NEAR_CEILING}, ${NEAR_CEILING_OWNER}, 'Blocked', 'csam'),
      (${INSIDE_MARGIN}, ${INSIDE_MARGIN_OWNER}, 'Blocked', 'csam'),
      (${PAST_MARGIN}, ${PAST_MARGIN_OWNER}, 'Blocked', 'csam');
    UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE ingestion = 'Blocked';
    -- A report on the other owner that has finished: it holds nothing.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
      (${OTHER_OWNER}, now(), now()),
      (${PRIOR_REPORT_OWNER}, NULL, NULL);
    -- Still open but past the release cutoff, so a new report leaves the flag on.
    INSERT INTO "CsamReport" ("userId", "createdAt") VALUES
      (${EXPIRED_HOLD_OWNER}, now() - interval '31 days'),
      (${NEAR_CEILING_OWNER}, now() - interval '29.9 days'),
      -- Either side of the release margin: 30 - 7 = 23 days.
      (${INSIDE_MARGIN_OWNER}, now() - interval '22 days 23 hours'),
      (${PAST_MARGIN_OWNER}, now() - interval '23 days 1 hour');
  `);
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.appeal.updateMany.mockImplementation((async ({
    where,
  }: {
    where: { entityId: { in: number[] } };
  }) => {
    const { affectedRows } = await pg.query(
      `UPDATE "Appeal" SET status = 'Rejected' WHERE "entityId" = ANY($1) AND status = 'Pending'`,
      [where.entityId.in]
    );
    return { count: affectedRows ?? 0 };
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
  }) as never);
  // The hold release's UPDATE … RETURNING.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { fileCsamReport } = await import('~/server/controllers/csam.controller');

const flag = async (id: number) =>
  (
    await pg.query<{ needsReview: string | null }>(
      `SELECT "needsReview" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0].needsReview;

const report = (userId: number, imageIds: number[]) =>
  fileCsamReport({ userId, imageIds, type: 'Image', reportedById: 2 } as never);

describe('fileCsamReport', () => {
  it('clears the review flag on a reported image its report now holds', async () => {
    await report(OWNER, [OWNED]);

    expect(await flag(OWNED)).toBeNull();
  });

  it('keeps the flag on a reported image whose owner the report does not hold', async () => {
    await report(OWNER, [OWNED, OTHER_OWNERS]);

    expect(await flag(OTHER_OWNERS)).toBe('csam');
  });

  it('keeps the flag when the report names no owner', async () => {
    await report(-1, [OTHER_OWNERS]);

    expect(await flag(OTHER_OWNERS)).toBe('csam');
  });

  // Held by an earlier report on its owner. This one names no owner, but blocks the image it lists
  // (civitai/civitai#10405), so the owner's open report takes over from the flag.
  it('blocks an image an ownerless report lists, and its owner’s open report takes the flag', async () => {
    await report(-1, [UNBLOCKED_HELD]);

    expect(await flag(UNBLOCKED_HELD)).toBeNull();
  });

  // A new report on an owner whose open report is past the release cutoff: the flag stays on.
  it("keeps the flag when the owner's open report is past the release cutoff", async () => {
    await report(EXPIRED_HOLD_OWNER, [EXPIRED_HOLD]);

    expect(await flag(EXPIRED_HOLD)).toBe('csam');
  });

  it('drops the deferred block effects of every filed image, whether or not its flag comes off', async () => {
    await pg.exec(`
      INSERT INTO "ImageDeferredBlockEffect" ("imageId") VALUES (${EXPIRED_HOLD}), (${PAST_MARGIN});
    `);
    await report(EXPIRED_HOLD_OWNER, [EXPIRED_HOLD]);

    expect(await flag(EXPIRED_HOLD)).toBe('csam');
    const { rows } = await pg.query(`SELECT "imageId" FROM "ImageDeferredBlockEffect"`);
    expect(rows).toEqual([{ imageId: PAST_MARGIN }]);
  });

  it('keeps the flag when the report updates an open report past the release cutoff', async () => {
    // As `createCsamReport` does for an unsent report: the row is rewritten, its createdAt is not.
    createCsamReport.mockImplementationOnce(async () => ({ id: 990000501 }));

    await report(EXPIRED_HOLD_OWNER, [EXPIRED_HOLD]);

    expect(await flag(EXPIRED_HOLD)).toBe('csam');
  });

  // Deliberate: the cutoff sits REPORT_HOLD_RELEASE_MARGIN_DAYS inside CSAM_HOLD_MAX_DAYS.
  it("keeps the flag when the owner's open report is near the release cutoff", async () => {
    await report(NEAR_CEILING_OWNER, [NEAR_CEILING]);

    expect(await flag(NEAR_CEILING)).toBe('csam');
  });

  it('clears the flag when the hold has more than the margin left', async () => {
    await report(INSIDE_MARGIN_OWNER, [INSIDE_MARGIN]);

    expect(await flag(INSIDE_MARGIN)).toBeNull();
  });

  it('keeps the flag when the hold has less than the margin left', async () => {
    await report(PAST_MARGIN_OWNER, [PAST_MARGIN]);

    expect(await flag(PAST_MARGIN)).toBe('csam');
  });

  it('leaves any other flag alone', async () => {
    await report(OWNER, [OTHER_FLAG]);

    expect(await flag(OTHER_FLAG)).toBe('minor');
  });

  it('takes the appeal flag off an image whose appeal the report closed', async () => {
    // A report naming no owner: it blocks nothing, so the image stays where the appeal left it.
    await report(-1, [APPEALED]);

    expect(await flag(APPEALED)).toBeNull();
    // Control: an image the report does not list keeps its pending appeal's flag.
    expect(await flag(APPEALED_UNLISTED)).toBe('appeal');
  });

  it("files a supplemental report without removing the account again, and clears its image's flag", async () => {
    // The earlier report removed the account.
    await pg.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE "userId" = $1`,
      [OWNER]
    );
    dbMock.dbWrite.user.findUnique.mockImplementationOnce((async ({
      where,
    }: {
      where: { id: number };
    }) =>
      where.id === OWNER
        ? { bannedAt: new Date(), meta: { banDetails: { reasonCode: 'SexualMinor' } } }
        : null) as never);

    await fileCsamReport({
      userId: OWNER,
      imageIds: [OWNED],
      type: 'Image',
      reportedById: 2,
      supplementalOf: 1,
    });

    expect(createSupplementalCsamReport).toHaveBeenCalledTimes(1);
    expect(createSupplementalCsamReport).toHaveBeenCalledWith(
      expect.objectContaining({ blockListedImages: true })
    );
    expect(createCsamReport).not.toHaveBeenCalled();
    expect(softDeleteUser).not.toHaveBeenCalled();
    expect(await flag(OWNED)).toBeNull();
  });

  it.each([
    ['restored since', { bannedAt: null, meta: {} }],
    [
      'since banned for something else',
      { bannedAt: new Date(), meta: { banDetails: { reasonCode: 'Other' } } },
    ],
  ])(
    'removes an account %s its earlier report when a supplemental report is filed',
    async (_, user) => {
      dbMock.dbWrite.user.findUnique.mockResolvedValueOnce(user as never);

      await fileCsamReport({
        userId: OWNER,
        imageIds: [OWNED],
        type: 'Image',
        reportedById: 2,
        supplementalOf: 1,
      });

      expect(softDeleteUser).toHaveBeenCalledWith({ id: OWNER, userId: 2 });
    }
  );

  // Search drops a listed image through its own row, so every path the filing takes must block it.
  // The services' own block is tested on PGlite in csam-report-send-append-only and
  // csam-supplemental-filing; here, that the controller asks for it on every path.
  it.each([
    ['an image of another account', OWNER, OTHER_OWNERS_SCANNED],
    ['an internal filing that removes no account', -1, UNBLOCKED_HELD],
    // softDeleteUser returns early for a moderator account; here it blocks nothing.
    ['an account whose removal blocks nothing', OWNER, OWNED],
  ])('blocks every listed image as CSAM on %s', async (_, userId, imageId) => {
    if (userId !== -1) softDeleteUser.mockImplementationOnce(async () => undefined);
    await report(userId, [imageId]);

    expect(createCsamReport).toHaveBeenCalledWith(
      expect.objectContaining({ imageIds: [imageId], blockListedImages: true })
    );
  });

  it('files with the block before removing the account, so a failed removal leaves it', async () => {
    softDeleteUser.mockRejectedValueOnce(new Error('connection lost'));

    await expect(report(OWNER, [OTHER_OWNERS_SCANNED])).rejects.toThrow('connection lost');

    expect(createCsamReport).toHaveBeenCalledWith(
      expect.objectContaining({ imageIds: [OTHER_OWNERS_SCANNED], blockListedImages: true })
    );
    expect(createCsamReport.mock.invocationCallOrder[0]).toBeLessThan(
      softDeleteUser.mock.invocationCallOrder[0]
    );
  });

  it('tells the moderator when filing fails, and can be filed again', async () => {
    const { createCsamReportHandler, CSAM_LISTED_BLOCK_FAILED_MESSAGE } = await import(
      '~/server/controllers/csam.controller'
    );
    const reports = async () =>
      Number(
        (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "CsamReport"`)).rows[0].n
      );
    const before = await reports();
    createCsamReport.mockRejectedValueOnce(new Error('write failed'));
    const file = () =>
      createCsamReportHandler({
        input: { userId: OWNER, imageIds: [OTHER_OWNERS_SCANNED], type: 'Image' },
        ctx: { user: { id: 2 } },
      } as never);

    await expect(file()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: CSAM_LISTED_BLOCK_FAILED_MESSAGE,
    });
    expect(await reports()).toBe(before);
    expect(softDeleteUser).not.toHaveBeenCalled();
    expect(afterCsamImageBlock).not.toHaveBeenCalled();

    await file();
    expect(await reports()).toBe(before + 1);
    // Search and the documents showing the images drop them only through this.
    expect(afterCsamImageBlock).toHaveBeenCalledTimes(1);
    expect(afterCsamImageBlock).toHaveBeenCalledWith({ imageIds: [OTHER_OWNERS_SCANNED] });
  });

  it('passes a refusal through unchanged, and runs no after-block steps', async () => {
    const { TRPCError } = await import('@trpc/server');
    createCsamReport.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'refused' })
    );

    await expect(report(OWNER, [OTHER_OWNERS_SCANNED])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'refused',
    });
    expect(afterCsamImageBlock).not.toHaveBeenCalled();
  });

  it('fails loudly with the flag still on when removing the account fails', async () => {
    softDeleteUser.mockRejectedValueOnce(new Error('connection lost'));

    await expect(report(OWNER, [OWNED])).rejects.toThrow('connection lost');

    expect(await flag(OWNED)).toBe('csam');
  });

  it('fails loudly with the flag still on when filing the report fails', async () => {
    createCsamReport.mockRejectedValueOnce(new Error('connection lost'));

    await expect(report(OWNER, [OWNED])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    expect(await flag(OWNED)).toBe('csam');
  });
});
