import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A filed report takes the review flag off its owner's removed images, and with it whatever their
 * blocks put off: those effects are dropped, never fired. Only on the rows it actually cleared.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const { releaseReviewFlagsToReportHold } = await import('~/server/services/image-appeal-flag');

const CLEARED = 81; // owner 7 has a young open report
const KEPT = 82; // owner 9 has none, so the flag stays

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, ingestion text, "needsReview" text);
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]', "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ImageDeferredBlockEffect" ("imageId" int PRIMARY KEY, "violationType" text);
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await holder.db.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
  }) as never);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "Image", "CsamReport", "ImageDeferredBlockEffect";
    INSERT INTO "Image" VALUES (${CLEARED}, 7, 'Blocked', 'csam'), (${KEPT}, 9, 'Blocked', 'csam');
    INSERT INTO "CsamReport" ("userId") VALUES (7);
    INSERT INTO "ImageDeferredBlockEffect" ("imageId") VALUES (${CLEARED}), (${KEPT});
  `);
});

describe('releaseReviewFlagsToReportHold', () => {
  it('drops the deferred effects of the images it clears, and only those', async () => {
    expect(await releaseReviewFlagsToReportHold([CLEARED, KEPT])).toBe(1);

    const { rows } = await holder.db.query(
      `SELECT "imageId" FROM "ImageDeferredBlockEffect" ORDER BY 1`
    );
    expect(rows).toEqual([{ imageId: KEPT }]);
    const flags = await holder.db.query(`SELECT id, "needsReview" FROM "Image" ORDER BY id`);
    expect(flags.rows).toEqual([
      { id: CLEARED, needsReview: null },
      { id: KEPT, needsReview: 'csam' },
    ]);
  });
});
