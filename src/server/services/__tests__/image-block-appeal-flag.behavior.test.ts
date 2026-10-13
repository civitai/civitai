import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as NotificationService from '~/server/services/notification.service';
import type * as EmailTemplates from '~/server/email/templates';
import type * as BuzzService from '~/server/services/buzz.service';

/**
 * The appeals queue lists images by `needsReview = 'appeal'`, and the blocked-image purge spares only
 * those rows. A main-app write that clears the flag while the Appeal is still Pending leaves an appeal
 * nobody can reach on an image the purge is free to delete. Rows decide it, so they live in Postgres.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { createNotification, sendEmail, refundTransaction, refundMultiAccountTransaction } =
  vi.hoisted(() => ({
    createNotification: vi.fn(async () => undefined),
    sendEmail: vi.fn(async () => undefined),
    refundTransaction: vi.fn(async () => undefined),
    refundMultiAccountTransaction: vi.fn(async () => undefined),
  }));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundTransaction,
  refundMultiAccountTransaction,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/email/templates', async (importOriginal) => {
  const actual = await importOriginal<typeof EmailTemplates>();
  return { ...actual, moderationActionEmail: { ...actual.moderationActionEmail, send: sendEmail } };
});

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const run = async (flat: { text: string; values: unknown[] }) =>
  holder.db.query(flat.text, flat.values as unknown[]);

/** Prisma `updateMany` on the columns these writers set, applied to the PGlite stand-in. */
const updateMany =
  (table: 'Image' | 'Appeal') =>
  async ({ where, data }: { where: Record<string, any>; data: Record<string, unknown> }) => {
    const values: unknown[] = [];
    const param = (v: unknown) => {
      values.push(v instanceof Date ? v.toISOString() : v);
      return `$${values.length}`;
    };
    const set = Object.entries(data)
      .map(([col, v]) => `"${col}" = ${param(v)}`)
      .join(', ');
    const conds = Object.entries(where).map(([col, v]) =>
      v && typeof v === 'object' && 'in' in v
        ? `"${col === 'id' ? 'id' : col}" = ANY(${param(v.in)})`
        : `"${col}" = ${param(v)}`
    );
    const { affectedRows } = await holder.db.query(
      `UPDATE "${table}" SET ${set} WHERE ${conds.join(' AND ')}`,
      values
    );
    return { count: affectedRows ?? 0 };
  };

const APPEALED = 41;
const FLAGGED = 42;
const DECIDED = 43;
const REVIEW_FLAGGED = 44;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int,
      ingestion text,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      "updatedAt" timestamp(3)
    );
    -- Enums as in prod, so a literal outside the enum fails here too.
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      "userId" int NOT NULL DEFAULT 7,
      "buzzTransactionId" text,
      status "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedBy" int,
      "resolvedAt" timestamp(3),
      "internalNotes" text,
      "resolvedMessage" text
    );
  `);
});

beforeEach(async () => {
  createNotification.mockClear();
  sendEmail.mockClear();
  refundTransaction.mockClear();
  refundMultiAccountTransaction.mockClear();
  dbMock.dbRead.user.findMany.mockResolvedValue([
    { id: 7, email: 'appellant@example.com', username: 'appellant' },
  ] as never);
  dbMock.dbWrite.image.updateMany.mockImplementation(updateMany('Image') as never);
  dbMock.dbWrite.appeal.updateMany.mockImplementation(updateMany('Appeal') as never);
  // resolveEntityAppeal's claim, so a close routed through it is observed rather than crashing.
  dbMock.dbWrite.appeal.updateManyAndReturn.mockImplementation((async ({ where, data }: any) => {
    await updateMany('Appeal')({ where, data });
    return (
      await holder.db.query(
        `SELECT id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId"
         FROM "Appeal" WHERE "entityId" = ANY($1) AND status = $2`,
        [where.entityId.in, data.status]
      )
    ).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    // Only the statements that write the review flag; the other raw writers touch columns this
    // stand-in does not have.
    if (!/"Appeal"|SET "needsReview"/.test(flat.text)) return 0;
    return (await run(flat)).affectedRows ?? 0;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview") VALUES
      (${APPEALED}, 7, 'Blocked', 'moderated', 32, 'appeal'),
      (${FLAGGED}, 8, 'Scanned', NULL, 4, 'minor'),
      (${DECIDED}, 9, 'Blocked', 'moderated', 32, NULL),
      (${REVIEW_FLAGGED}, 10, 'Scanned', NULL, 4, 'csam');
    -- APPEALED also carries an earlier, decided appeal; FLAGGED shares its id with a post's appeal.
    INSERT INTO "Appeal" ("entityType", "entityId", "userId", status, "buzzTransactionId") VALUES
      ('Image', ${APPEALED}, 7, 'Approved', NULL),
      ('Image', ${APPEALED}, 7, 'Pending', 'appeal-7-1790000000000-abcd1234'),
      ('Post', ${FLAGGED}, 8, 'Pending', NULL),
      ('Image', ${DECIDED}, 9, 'Rejected', NULL);
  `);
  dbMock.dbRead.image.findMany.mockImplementation((async ({ where }: any) => {
    const ids: number[] = where?.id?.in ?? [];
    return (
      await holder.db.query(
        `SELECT id, "userId", NULL::bigint AS "pHash", NULL::int AS "postId", "nsfwLevel", "blockedFor", "needsReview" FROM "Image" WHERE id = ANY($1)`,
        [ids]
      )
    ).rows.map((row) => ({ ...row, reports: [] }));
  }) as never);
});

const { handleBlockImages, reportCsamImages } = await import('~/server/services/image.service');
const { setTosViolationHandler } = await import('~/server/controllers/image.controller');
const { resolveEntityAppeal } = await import('~/server/services/report.service');

/** Pending image appeals the queue cannot see: the closing condition of the ticket, as a query. */
const strandedAppeals = async () =>
  (
    await holder.db.query<{ id: number; needsReview: string | null }>(
      `SELECT a."entityId" AS id, i."needsReview"
       FROM "Appeal" a JOIN "Image" i ON i.id = a."entityId"
       WHERE a."entityType" = 'Image' AND a.status = 'Pending'
         AND i."needsReview" IS DISTINCT FROM 'appeal'`
    )
  ).rows;

const imageRow = async (id: number) =>
  (
    await holder.db.query<{ needsReview: string | null; ingestion: string }>(
      `SELECT "needsReview", ingestion FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const appeals = async () =>
  (
    await holder.db.query<{ status: string; internalNotes: string | null }>(
      `SELECT status, "internalNotes" FROM "Appeal" ORDER BY id`
    )
  ).rows;

describe('handleBlockImages', () => {
  it('does not leave a pending appeal the appeals queue cannot reach', async () => {
    await handleBlockImages({ ids: [APPEALED, FLAGGED] });

    expect(await strandedAppeals()).toEqual([]);
    expect((await imageRow(APPEALED)).ingestion).toBe('Blocked');
  });

  it('still clears another review flag on an image with no pending appeal of its own', async () => {
    await handleBlockImages({ ids: [APPEALED, FLAGGED] });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });

  it('does not put an image whose appeal was already decided back in the appeals queue', async () => {
    await handleBlockImages({ ids: [DECIDED] });

    expect(await imageRow(DECIDED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });
});

// Only that flag's own queue or a filed report may clear it; the purge holds the image until then.
describe('blocking keeps the moderator-only review flag', () => {
  it('handleBlockImages', async () => {
    await handleBlockImages({ ids: [REVIEW_FLAGGED, FLAGGED] });

    expect(await imageRow(REVIEW_FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });

  it('setTosViolationHandler', async () => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      nsfwLevel: 4,
      userId: 10,
      postId: null,
      pHash: null,
      post: null,
    } as never);

    await setTosViolationHandler({
      input: { id: REVIEW_FLAGGED },
      ctx: { user: { id: 2, isModerator: true }, ip: '127.0.0.1', track: { images: vi.fn() } },
    } as never);

    expect(await imageRow(REVIEW_FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });
});

describe('setTosViolationHandler', () => {
  it('does not leave a pending appeal the appeals queue cannot reach', async () => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      nsfwLevel: 32,
      userId: 7,
      postId: null,
      pHash: null,
      post: null,
    } as never);

    await setTosViolationHandler({
      input: { id: APPEALED },
      ctx: { user: { id: 2, isModerator: true }, ip: '127.0.0.1', track: { images: vi.fn() } },
    } as never);

    expect(await strandedAppeals()).toEqual([]);
    expect((await imageRow(APPEALED)).ingestion).toBe('Blocked');
  });

  it('still clears another review flag', async () => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      nsfwLevel: 4,
      userId: 8,
      postId: null,
      pHash: null,
      post: null,
    } as never);

    await setTosViolationHandler({
      input: { id: FLAGGED },
      ctx: { user: { id: 2, isModerator: true }, ip: '127.0.0.1', track: { images: vi.fn() } },
    } as never);

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });
});

describe('reportCsamImages', () => {
  const moderator = { id: 2, isModerator: true } as never;

  it('closes the pending appeal as Rejected so the CSAM queue owns the image', async () => {
    // FLAGGED's id is shared by a post's pending appeal, which a CSAM report on the image must not touch.
    await reportCsamImages({ imageIds: [APPEALED, FLAGGED], user: moderator });

    expect(await strandedAppeals()).toEqual([]);
    expect(await appeals()).toEqual([
      { status: 'Approved', internalNotes: null },
      { status: 'Rejected', internalNotes: 'Closed by CSAM report' },
      { status: 'Pending', internalNotes: null },
      { status: 'Rejected', internalNotes: null },
    ]);
    expect((await imageRow(APPEALED)).needsReview).toBe('csam');
  });

  it('does not notify the appellant', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not refund the appeal fee', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  // An appeal that commits while the report is being made, just before the flag lands. The flag
  // has to be written before the appeals are closed, or this one survives it.
  it('closes an appeal that lands just before the flag', async () => {
    await holder.db.exec(`DELETE FROM "Appeal" WHERE "entityId" = ${APPEALED}`);
    const flag = updateMany('Image');
    dbMock.dbWrite.image.updateMany.mockImplementation((async (args: any) => {
      if (args.data?.needsReview === 'csam')
        await holder.db.exec(
          `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', ${APPEALED}, 'Pending')`
        );
      return flag(args);
    }) as never);

    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    expect(await strandedAppeals()).toEqual([]);
    expect((await imageRow(APPEALED)).needsReview).toBe('csam');
  });

  it('does not leave the flag behind when closing the appeals fails', async () => {
    // A real transaction on the stand-in, so a write that is not inside it survives the rollback.
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (cb: (tx: unknown) => unknown) => {
      await holder.db.exec('BEGIN');
      try {
        const result = await cb(dbMock.dbWrite);
        await holder.db.exec('COMMIT');
        return result;
      } catch (e) {
        await holder.db.exec('ROLLBACK');
        throw e;
      }
    }) as never);
    dbMock.dbWrite.appeal.updateMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(reportCsamImages({ imageIds: [APPEALED], user: moderator })).rejects.toThrow(
      'connection lost'
    );

    expect((await imageRow(APPEALED)).needsReview).toBe('appeal');
  });

  it('leaves no pending appeal whose resolution could clear the flag', async () => {
    // The shared claim fake returns every row now in the target status; here it must return only
    // the rows this claim moved out of Pending, as Prisma does.
    dbMock.dbWrite.appeal.updateManyAndReturn.mockImplementation(
      (async ({ where, data }: any) =>
        (
          await holder.db.query(
            `UPDATE "Appeal" SET status = $3 WHERE "entityId" = ANY($1) AND "entityType" = $2
             AND status = 'Pending'
           RETURNING id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId"`,
            [where.entityId.in, where.entityType, data.status]
          )
        ).rows) as never
    );
    // A resolution that did reach the image would write it here, so the flag's survival is observed.
    dbMock.dbWrite.image.update.mockImplementation((async ({ where, data }: any) => {
      await updateMany('Image')({ where: { id: where.id }, data });
      return { postId: null, pHash: null };
    }) as never);
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    await resolveEntityAppeal({
      ids: [APPEALED],
      entityType: 'Image',
      status: 'Rejected',
      userId: 2,
    } as never);

    expect((await imageRow(APPEALED)).needsReview).toBe('csam');
  });
});
