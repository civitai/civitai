import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { releaseReviewFlagsToReportHold } from '~/server/services/image-appeal-flag';

/**
 * A report never names the capture account, so a report that lists a feedback page capture takes the
 * moderator-only flag off it by listing it. An ordinary image still needs a report naming its owner.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
const OWNER = 7;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      ingestion text NOT NULL,
      "needsReview" text
    );
    CREATE TABLE "ImageDeferredBlockEffect" ("imageId" int PRIMARY KEY);
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      images jsonb NOT NULL DEFAULT '[]',
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
  `);
});

const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};
const tx = {
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await run(s, ...v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await run(s, ...v)).affectedRows ?? 0,
};

beforeEach(async () => {
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "CsamReport", "ImageDeferredBlockEffect";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (1, ${CAPTURE}, 'Blocked', 'csam'),
      (2, ${CAPTURE}, 'Blocked', 'csam'),
      (3, ${OWNER}, 'Blocked', 'csam');
  `);
});

const flags = async () =>
  (
    await holder.db.query<{ id: number; needsReview: string | null }>(
      `SELECT id, "needsReview" FROM "Image" ORDER BY id`
    )
  ).rows;

describe('releaseReviewFlagsToReportHold', () => {
  it('releases a capture a report lists, and only that capture', async () => {
    await holder.db.exec(
      `INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER + 1}, '[{"id": 1}]')`
    );

    expect(await releaseReviewFlagsToReportHold([1, 2, 3])).toBe(1);
    expect(await flags()).toEqual([
      { id: 1, needsReview: null },
      { id: 2, needsReview: 'csam' },
      { id: 3, needsReview: 'csam' },
    ]);
  });

  it("never releases another owner's image a report lists beside a capture", async () => {
    await holder.db.exec(
      `INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER + 1}, '[{"id": 1}, {"id": 3}]')`
    );

    expect(await releaseReviewFlagsToReportHold([1, 3])).toBe(1);
    expect((await flags())[2]).toEqual({ id: 3, needsReview: 'csam' });
  });

  it('releases a listed capture whatever state its report is in', async () => {
    await holder.db.exec(`
      INSERT INTO "CsamReport" ("userId", images, "createdAt", "reportSentAt", "archivedAt")
        VALUES (${OWNER + 1}, '[1]', now() - interval '90 days', now(), now())
    `);

    expect(await releaseReviewFlagsToReportHold([1])).toBe(1);
  });

  it('never releases a capture on a report that names an account but lists no capture', async () => {
    // The capture account itself included: the database refuses such a report, but if one existed
    // it must not release every capture.
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER}), (${CAPTURE})`);

    expect(await releaseReviewFlagsToReportHold([1, 2])).toBe(0);
  });

  it("drops the deferred block effects of the capture it releases, and no other image's", async () => {
    await holder.db.exec(`
      INSERT INTO "ImageDeferredBlockEffect" ("imageId") VALUES (1), (2), (3);
      INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER + 1}, '[{"id": 1}]');
    `);

    expect(await releaseReviewFlagsToReportHold([1, 2, 3])).toBe(1);
    const left = await holder.db.query<{ imageId: number }>(
      `SELECT "imageId" FROM "ImageDeferredBlockEffect" ORDER BY 1`
    );
    expect(left.rows.map((r) => r.imageId)).toEqual([2, 3]);
  });

  it('still releases an ordinary image on a report naming its owner (control)', async () => {
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`);

    expect(await releaseReviewFlagsToReportHold([3])).toBe(1);
    expect((await flags())[2]).toEqual({ id: 3, needsReview: null });
  });
});
