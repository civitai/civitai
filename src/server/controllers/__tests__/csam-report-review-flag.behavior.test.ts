import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CsamService from '~/server/services/csam.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';
import type * as UserService from '~/server/services/user.service';

/**
 * Filing a report hands each reported image from the moderator-only review flag to the purge hold
 * keyed on the owner's open report. Neither may lapse first: the flag must still be on until that
 * hold covers the image, and must not come off an image the hold does not cover.
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

const { createCsamReport, softDeleteUser } = vi.hoisted(() => ({
  createCsamReport: vi.fn(async ({ userId }: { userId: number }) => {
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [
      userId === -1 ? null : userId,
    ]);
  }),
  softDeleteUser: vi.fn(async ({ id }: { id: number }) => {
    await holder.db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE "userId" = $1`, [id]);
  }),
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  bulkAddBlockedImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus: vi.fn(async () => undefined),
}));

const OWNER = 8;
const OTHER_OWNER = 9;
const PRIOR_REPORT_OWNER = 10;

const OWNED = 61;
const OTHER_OWNERS = 62;
const UNBLOCKED_HELD = 63;
const OTHER_FLAG = 64;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  holder.db = pg;
  await pg.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int,
      ingestion text,
      "needsReview" text
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
  `);
});

beforeEach(async () => {
  createCsamReport.mockClear();
  softDeleteUser.mockClear();
  await pg.exec(`
    TRUNCATE "Image", "CsamReport";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${OWNED}, ${OWNER}, 'Scanned', 'csam'),
      (${OTHER_OWNERS}, ${OTHER_OWNER}, 'Blocked', 'csam'),
      (${UNBLOCKED_HELD}, ${PRIOR_REPORT_OWNER}, 'Scanned', 'csam'),
      (${OTHER_FLAG}, ${OWNER}, 'Blocked', 'appeal');
    -- A report on the other owner that has finished: it holds nothing.
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
      (${OTHER_OWNER}, now(), now()),
      (${PRIOR_REPORT_OWNER}, NULL, NULL);
  `);
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
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

  // Held by an earlier report, but this one (no owner) blocked nothing: the flag is what keeps it out
  // of every feed.
  it('keeps the flag on an image that is not removed', async () => {
    await report(-1, [UNBLOCKED_HELD]);

    expect(await flag(UNBLOCKED_HELD)).toBe('csam');
  });

  it('leaves any other flag alone', async () => {
    await report(OWNER, [OTHER_FLAG]);

    expect(await flag(OTHER_FLAG)).toBe('appeal');
  });

  it('keeps the flag when removing the account fails', async () => {
    softDeleteUser.mockRejectedValueOnce(new Error('connection lost'));

    await expect(report(OWNER, [OWNED])).rejects.toThrow('connection lost');

    expect(await flag(OWNED)).toBe('csam');
  });

  it('keeps the flag when filing the report fails', async () => {
    createCsamReport.mockRejectedValueOnce(new Error('connection lost'));

    await expect(report(OWNER, [OWNED])).rejects.toThrow('connection lost');

    expect(await flag(OWNED)).toBe('csam');
  });
});
