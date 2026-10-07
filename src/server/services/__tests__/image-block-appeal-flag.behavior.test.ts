import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as NotificationService from '~/server/services/notification.service';
import type * as EmailTemplates from '~/server/email/templates';

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

const { createNotification, sendEmail } = vi.hoisted(() => ({
  createNotification: vi.fn(async () => undefined),
  sendEmail: vi.fn(async () => undefined),
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
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      "userId" int NOT NULL DEFAULT 7,
      "buzzTransactionId" text,
      status text NOT NULL DEFAULT 'Pending',
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
  dbMock.dbWrite.image.updateMany.mockImplementation(updateMany('Image') as never);
  dbMock.dbWrite.appeal.updateMany.mockImplementation(updateMany('Appeal') as never);
  // resolveEntityAppeal's claim, so a close routed through it is observed rather than crashing.
  dbMock.dbWrite.appeal.updateManyAndReturn.mockImplementation((async ({ where, data }: any) => {
    await updateMany('Appeal')({ where, data });
    return (
      await holder.db.query(
        `SELECT id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId"
         FROM "Appeal" WHERE "entityId" = ANY($1)`,
        [where.entityId.in]
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
      (${FLAGGED}, 8, 'Scanned', NULL, 4, 'minor');
    INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', ${APPEALED});
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

  it('still clears another review flag on an image with no appeal', async () => {
    await handleBlockImages({ ids: [APPEALED, FLAGGED] });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
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
});

describe('reportCsamImages', () => {
  const moderator = { id: 2, isModerator: true } as never;

  it('closes the pending appeal as Rejected so the CSAM queue owns the image', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    expect(await strandedAppeals()).toEqual([]);
    expect(await appeals()).toEqual([
      { status: 'Rejected', internalNotes: 'Closed by CSAM report' },
    ]);
    expect((await imageRow(APPEALED)).needsReview).toBe('csam');
  });

  it('does not notify the appellant', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
