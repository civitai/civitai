import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deleted-account drain leaves every image and post of a user under a legal hold, including a
 * hold that lands mid-drain. The job's own statements run against a Postgres stand-in, so the hold
 * and the columns it is bound to are exercised as SQL. `deleteImages` is replaced by its row DELETE,
 * the statement the hold is composed into.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockDeleteImages, hooks } = vi.hoisted(() => ({
  mockDeleteImages: vi.fn(),
  hooks: {
    beforeDelete: null as null | ((ids: number[]) => Promise<void>),
    afterWorklist: null as null | (() => Promise<void>),
  },
}));

vi.mock('~/server/services/image.service', () => ({
  deleteImages: mockDeleteImages,
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
  invalidateManyImageExistence: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/post.service', () => ({
  bustCachesForPosts: vi.fn(async () => undefined),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: vi.fn(async (_key: string, defaultValue: Date) => [defaultValue, vi.fn()]),
}));

import { removeDeletedUserImages } from '~/server/jobs/remove-deleted-user-images';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const HELD = 1; // the secondary user on a report sent within the year
const UNHELD = 2;
const REPORT_SUBJECT = 3; // owns nothing
const MANY = 150; // more than one delete batch

const run = () =>
  (
    removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<unknown>
  )({ checkIfCanceled: () => undefined });

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

const holdSecondaryUser = (userId: number) =>
  holder.db.exec(`
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details)
    VALUES (${REPORT_SUBJECT}, now() - interval '30 days', now(), '{"secondaryUserId": ${userId}}');
  `);

const imagesOf = async (userId: number) =>
  (await holder.db.query(`SELECT 1 FROM "Image" WHERE "userId" = $1`, [userId])).rows.length;
const postsOf = async (userId: number) =>
  (await holder.db.query(`SELECT 1 FROM "Post" WHERE "userId" = $1`, [userId])).rows.length;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3), meta jsonb);
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "needsReview" text
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  hooks.beforeDelete = null;
  hooks.afterWorklist = null;
  redisMock.sysRedis.get.mockResolvedValue('1000');

  const query = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = toSql(first, values);
    const { rows } = await holder.db.query(sql.text, sql.values as unknown[]);
    // After the worklist that actually picked the users up (the fresh one comes back empty here).
    if (hooks.afterWorklist && sql.text.includes('m.mode') && rows.length)
      await hooks.afterWorklist();
    return rows;
  }) as never;
  const execute = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = toSql(first, values);
    return (await holder.db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(execute);

  // The row DELETE `deleteImages` runs, with `onlyWhere` composed into it the same way.
  mockDeleteImages.mockImplementation(
    async (ids: number[], _updatePosts?: boolean, opts?: { onlyWhere?: Prisma.Sql }) => {
      if (hooks.beforeDelete) await hooks.beforeDelete(ids);
      const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
      const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
      const { rows } = await holder.db.query<{ id: number }>(sql.text, sql.values as unknown[]);
      return rows;
    }
  );

  await holder.db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    TRUNCATE "User", "Post", "Image", "CsamReport";
    INSERT INTO "User" (id, "deletedAt", meta) VALUES
      (${HELD}, now() - interval '1 day', '{}'),
      (${UNHELD}, now() - interval '1 day', '{}');
    INSERT INTO "Post" (id, "userId") VALUES (901, ${HELD}), (902, ${UNHELD});
    INSERT INTO "Image" (id, "userId", "postId")
      SELECT g, ${HELD}, 901 FROM generate_series(1, ${MANY}) g;
    INSERT INTO "Image" (id, "userId", "postId")
      SELECT g, ${UNHELD}, 902 FROM generate_series(1001, 1005) g;
  `);
});

describe('remove-deleted-user-images under a legal hold', () => {
  it("leaves a held user's images and posts, and drains everyone else", async () => {
    await holdSecondaryUser(HELD);

    await run();

    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await postsOf(HELD)).toBe(1);
    // The positive control: the same run, through the same statements, drains an unheld user.
    expect(await imagesOf(UNHELD)).toBe(0);
    expect(await postsOf(UNHELD)).toBe(0);
  });

  it('never hands a held image to the delete when the hold lands after the worklist', async () => {
    hooks.afterWorklist = async () => {
      hooks.afterWorklist = null;
      await holdSecondaryUser(HELD);
    };

    await run();

    const handedOver = mockDeleteImages.mock.calls.flatMap(([ids]) => ids as number[]);
    expect(handedOver.filter((id) => id <= MANY)).toEqual([]);
    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await imagesOf(UNHELD)).toBe(0);
  });

  it('keeps every batch of images when the hold lands after they were read', async () => {
    let held = false;
    hooks.beforeDelete = async (ids) => {
      // On the held user's first batch, after the drain has read their images.
      if (!held && ids.every((id) => id <= MANY)) {
        await holdSecondaryUser(HELD);
        held = true;
      }
    };

    await run();

    expect(held).toBe(true);
    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await postsOf(HELD)).toBe(1);
    expect(await imagesOf(UNHELD)).toBe(0);
  });

  it('keeps every image of an account when one is flagged for CSAM review after they were read', async () => {
    let flagged = false;
    hooks.beforeDelete = async (ids) => {
      // On the first batch, flag an image of a later one: no report exists yet, so no hold.
      if (!flagged && ids.every((id) => id <= MANY)) {
        await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${MANY}`);
        flagged = true;
      }
    };

    await run();

    expect(flagged).toBe(true);
    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await postsOf(HELD)).toBe(1);
    expect(await imagesOf(UNHELD)).toBe(0);
  });

  it('keeps the posts when the hold lands after the images are gone', async () => {
    const deleteRows = mockDeleteImages.getMockImplementation()!;
    let held = false;
    mockDeleteImages.mockImplementation(async (...args: Parameters<typeof deleteRows>) => {
      const rows = await deleteRows(...args);
      if (!held && (await imagesOf(HELD)) === 0) {
        await holdSecondaryUser(HELD);
        held = true;
      }
      return rows;
    });

    await run();

    expect(held).toBe(true);
    expect(await imagesOf(HELD)).toBe(0);
    expect(await postsOf(HELD)).toBe(1);
    expect(await postsOf(UNHELD)).toBe(0);
  });
});

describe('remove-deleted-user-images under any account hold', () => {
  const holdsByImage = {
    'an image flagged for CSAM review': `
      UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${MANY};
    `,
    'a CSAM-blocked image on no sent report': `
      UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE id = ${MANY};
    `,
    'an image listed on a holding report that names someone else': `
      INSERT INTO "CsamReport" ("userId", images) VALUES (${REPORT_SUBJECT}, '[{"id": ${MANY}}]');
    `,
    'a hold marker': `
      CREATE TABLE "EvidenceHold" ("userId" int);
      CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
      INSERT INTO "EvidenceHold" VALUES (${HELD});
    `,
  };

  it.each(Object.entries(holdsByImage))(
    'keeps an account held by %s, and drains everyone else',
    async (_, hold) => {
      await holder.db.exec(hold);

      await run();

      expect(await imagesOf(HELD)).toBe(MANY);
      expect(await postsOf(HELD)).toBe(1);
      expect(await imagesOf(UNHELD)).toBe(0);
      expect(await postsOf(UNHELD)).toBe(0);
    }
  );

  it.each([
    [
      'a review flag other than CSAM',
      `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = ${MANY}`,
    ],
    [
      'an image blocked for another reason',
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'AiNotVerified' WHERE id = ${MANY}`,
    ],
    [
      'a CSAM-blocked image a sent report naming them lists, past the hold',
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE id = ${MANY};
       INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images)
       VALUES (${HELD}, now() - interval '2 years', now(), '[{"id": ${MANY}}]');`,
    ],
    [
      'an image listed on a report that no longer holds',
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images)
       VALUES (${REPORT_SUBJECT}, now() - interval '2 years', now(), '[{"id": ${MANY}}]');`,
    ],
  ])('drains an account with only %s', async (_, state) => {
    await holder.db.exec(state);

    await run();

    expect(await imagesOf(HELD)).toBe(0);
    expect(await postsOf(HELD)).toBe(0);
  });

  it('keeps every image of an account when a hold lands on one after they were read', async () => {
    let held = false;
    hooks.beforeDelete = async (ids) => {
      if (!held && ids.every((id) => id <= MANY)) {
        await holder.db.exec(holdsByImage['a CSAM-blocked image on no sent report']);
        held = true;
      }
    };

    await run();

    expect(held).toBe(true);
    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await postsOf(HELD)).toBe(1);
  });

  it('holds every account while the marker table has no view', async () => {
    await holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int);`);

    await run();

    expect(await imagesOf(HELD)).toBe(MANY);
    expect(await imagesOf(UNHELD)).toBe(5);
  });

  it('holds an account once the marker view appears mid-run', async () => {
    let appeared = false;
    hooks.beforeDelete = async (ids) => {
      if (!appeared && ids.every((id) => id <= MANY)) {
        await holder.db.exec(holdsByImage['a hold marker']);
        appeared = true;
      }
    };

    await run();

    expect(appeared).toBe(true);
    expect(await imagesOf(HELD)).toBe(MANY);
  });

  it('keeps the images of the placeholder owner', async () => {
    await holder.db.exec(`
      INSERT INTO "User" (id, "deletedAt", meta) VALUES (-1, now() - interval '1 day', '{}');
      INSERT INTO "Image" (id, "userId") VALUES (5000, -1);
    `);

    await run();

    expect(await imagesOf(-1)).toBe(1);
    expect(await imagesOf(UNHELD)).toBe(0);
  });
});
