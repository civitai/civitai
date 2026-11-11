import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { BlockedReason } from '~/server/common/enums';
import type * as NotificationService from '~/server/services/notification.service';
import type * as EmailTemplates from '~/server/email/templates';
import type * as BuzzService from '~/server/services/buzz.service';

/**
 * The appeals queue lists images by `needsReview = 'appeal'`, and the blocked-image purge spares only
 * those rows. A main-app write that clears the flag while the Appeal is still Pending leaves an appeal
 * nobody can reach on an image the purge is free to delete. Rows decide it, so they live in Postgres.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The re-removal hold reads through Kysely, which this file does not route to PGlite; no image here
// has an approved appeal, so the hold lets everything through (covered by its own tests).
vi.mock('~/server/services/image-removal-hold.service', () => ({
  canConfirmReRemoval: async () => false,
  holdRemovals: async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  }),
  heldRemovalSummary: () => [],
}));
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
      v === null
        ? `"${col}" IS NULL`
        : v && typeof v === 'object' && 'in' in v
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
      "postId" int,
      "pHash" bigint,
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
      "resolvedMessage" text,
      "resolvedReason" text,
      "entityRemovedAt" timestamp(3),
      category text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY);
  `);
  for (const migration of [
    '20261209120000_csam_queue_set_aside',
    '20261229120000_image_deferred_block_effect',
  ])
    await holder.db.exec(
      readFileSync(
        new URL(
          `../../../../packages/civitai-db-schema/prisma/migrations/${migration}/migration.sql`,
          import.meta.url
        ),
        'utf8'
      )
    );
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
        `SELECT id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId", "createdAt"
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
    if (
      !/"Appeal"|SET "needsReview"|"CsamQueueSetAside"|"blockedFor" = CASE|"ImageDeferredBlockEffect"/.test(
        flat.text
      )
    )
      return 0;
    return (await run(flat)).affectedRows ?? 0;
  }) as never);
  // The block, the approval's held check and the ruling's image write return rows; every other raw
  // read here has its own fake.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    if (!/"CsamQueueSetAside"|SELECT id FROM "Image"|RETURNING "postId", "pHash"/.test(flat.text))
      return [];
    return (await run(flat)).rows;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal", "CsamQueueSetAside", "ImageDeferredBlockEffect" CASCADE;
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

describe('a re-block keeps the original block reason', () => {
  const BLOCKED_WITH_REASON = 45;
  const OTHER_REASON = 46;
  const blockedFor = async (id: number) =>
    (
      await holder.db.query<{ blockedFor: string | null }>(
        `SELECT "blockedFor" FROM "Image" WHERE id = $1`,
        [id]
      )
    ).rows[0].blockedFor;
  const tosBlock = async (id: number) => {
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      nsfwLevel: 32,
      userId: 11,
      postId: null,
      pHash: null,
      post: null,
    } as never);
    await setTosViolationHandler({
      input: { id },
      ctx: { user: { id: 2, isModerator: true }, ip: '127.0.0.1', track: { images: vi.fn() } },
    } as never);
  };

  beforeEach(async () => {
    await holder.db.query(
      `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES
        ($1, 11, 'Blocked', $2, 32), ($3, 11, 'Blocked', $4, 32)`,
      [BLOCKED_WITH_REASON, BlockedReason.CSAM, OTHER_REASON, BlockedReason.AiNotVerified]
    );
  });

  it('handleBlockImages', async () => {
    await handleBlockImages({ ids: [BLOCKED_WITH_REASON, OTHER_REASON, FLAGGED] });

    expect(await blockedFor(BLOCKED_WITH_REASON)).toBe(BlockedReason.CSAM);
    expect(await blockedFor(OTHER_REASON)).toBe(BlockedReason.Moderated);
    expect(await blockedFor(FLAGGED)).toBe(BlockedReason.Moderated);
  });

  it('handleBlockImages over a whole account', async () => {
    dbMock.dbRead.image.findMany.mockImplementationOnce(
      (async () =>
        (
          await holder.db.query(
            `SELECT id, "userId", NULL::bigint AS "pHash", NULL::int AS "postId", "nsfwLevel", "blockedFor", "needsReview" FROM "Image" WHERE "userId" = 11`
          )
        ).rows) as never
    );

    await handleBlockImages({ userId: 11 });

    expect(await blockedFor(BLOCKED_WITH_REASON)).toBe(BlockedReason.CSAM);
    expect(await blockedFor(OTHER_REASON)).toBe(BlockedReason.Moderated);
  });

  it('setTosViolationHandler', async () => {
    await tosBlock(BLOCKED_WITH_REASON);

    expect(await blockedFor(BLOCKED_WITH_REASON)).toBe(BlockedReason.CSAM);
  });

  it('setTosViolationHandler still blocks any other image as moderated', async () => {
    await tosBlock(OTHER_REASON);

    expect(await blockedFor(OTHER_REASON)).toBe(BlockedReason.Moderated);
  });
});

describe('reportCsamImages', () => {
  const moderator = { id: 2, isModerator: true } as never;

  it('leaves a pending appeal Pending', async () => {
    // FLAGGED's id is shared by a post's pending appeal, which a CSAM report on the image must not touch.
    await reportCsamImages({ imageIds: [APPEALED, FLAGGED], user: moderator });

    expect(await appeals()).toEqual([
      { status: 'Approved', internalNotes: null },
      { status: 'Pending', internalNotes: null },
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

  it('keeps the flag through a rejection of the pending appeal', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    await resolveEntityAppeal({
      ids: [APPEALED],
      entityType: 'Image',
      status: 'Rejected',
      userId: 2,
    } as never);

    expect((await imageRow(APPEALED)).needsReview).toBe('csam');
  });

  it('refuses an approval of the pending appeal, which stays Pending', async () => {
    await reportCsamImages({ imageIds: [APPEALED], user: moderator });

    await expect(
      resolveEntityAppeal({
        ids: [APPEALED],
        entityType: 'Image',
        status: 'Approved',
        userId: 2,
      } as never)
    ).rejects.toThrow('cannot put it back');

    expect(await imageRow(APPEALED)).toMatchObject({ needsReview: 'csam', ingestion: 'Blocked' });
    expect((await appeals())[1]).toEqual({ status: 'Pending', internalNotes: null });
  });
});

describe('approving an image appeal', () => {
  const approve = () =>
    resolveEntityAppeal({
      ids: [APPEALED],
      entityType: 'Image',
      status: 'Approved',
      userId: 2,
    } as never);
  const pendingAppeals = async () =>
    (
      await holder.db.query(
        `SELECT id FROM "Appeal" WHERE "entityType" = 'Image' AND "entityId" = $1 AND status = 'Pending'`,
        [APPEALED]
      )
    ).rows.length;

  it('is refused for an image blocked for CSAM, and leaves the appeal pending', async () => {
    await holder.db.query(`UPDATE "Image" SET "blockedFor" = $1 WHERE id = $2`, [
      BlockedReason.CSAM,
      APPEALED,
    ]);

    await expect(approve()).rejects.toThrow('cannot put it back');

    expect(await pendingAppeals()).toBe(1);
    expect(await imageRow(APPEALED)).toMatchObject({ ingestion: 'Blocked' });
  });

  it('still restores an image blocked for another reason', async () => {
    await approve();

    expect(await pendingAppeals()).toBe(0);
    expect(await imageRow(APPEALED)).toMatchObject({ ingestion: 'Scanned' });
  });

  /** The held check reads an image not yet held; the CSAM block lands before the ruling's write. */
  const turnHeldAfterCheck = async () => {
    dbMock.dbWrite.$executeRaw.mockClear();
    loggingMock.logToAxiom.mockClear();
    // The shared claim fake returns every row now in the target status; here it must return only
    // the rows this claim moved out of Pending, as Prisma does.
    dbMock.dbWrite.appeal.updateManyAndReturn.mockImplementationOnce(
      (async ({ where, data }: any) =>
        (
          await holder.db.query(
            `UPDATE "Appeal" SET status = $3 WHERE "entityId" = ANY($1) AND "entityType" = $2
             AND status = 'Pending'
             RETURNING id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId", "createdAt"`,
            [where.entityId.in, where.entityType, data.status]
          )
        ).rows) as never
    );
    await holder.db.query(
      `UPDATE "Appeal" SET "buzzTransactionId" = 'appeal-7-1' WHERE "entityId" = $1`,
      [APPEALED]
    );
    const fake = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...v: unknown[]
    ) => {
      const flat = Prisma.sql(strings, ...(v as never[]));
      if (/^\s*SELECT id FROM "Image"/.test(flat.text)) {
        await holder.db.query(`UPDATE "Image" SET "blockedFor" = $1 WHERE id = $2`, [
          BlockedReason.CSAM,
          APPEALED,
        ]);
        return [];
      }
      return fake(strings, ...(v as never[]));
    }) as never);
  };

  it('reopens, rather than approves, an appeal whose image turned held after its check', async () => {
    await turnHeldAfterCheck();
    await approve();

    expect(await imageRow(APPEALED)).toMatchObject({ ingestion: 'Blocked' });
    const restoreWrites = dbMock.dbWrite.$executeRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('"nsfwLevelLocked" = FALSE')
    );
    expect(restoreWrites).toEqual([]);
    expect(loggingMock.logToAxiom.mock.calls.map(([e]) => (e as { name?: string }).name)).toContain(
      'appeal-approval-not-restored'
    );
    expect(await pendingAppeals()).toBe(1);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('neither refunds nor tells when putting it back to Pending fails', async () => {
    await turnHeldAfterCheck();
    dbMock.dbWrite.appeal.updateMany.mockRejectedValueOnce(new Error('connection lost'));

    await approve();

    expect(await imageRow(APPEALED)).toMatchObject({ ingestion: 'Blocked' });
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reopens, and neither refunds nor tells, when the image write itself fails', async () => {
    await turnHeldAfterCheck();
    const fake = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...v: unknown[]
    ) => {
      if (/^\s*UPDATE "Image"/.test(Prisma.sql(strings, ...(v as never[])).text))
        throw new Error('lock timeout');
      return fake(strings, ...(v as never[]));
    }) as never);

    await approve();

    expect(await imageRow(APPEALED)).toMatchObject({ ingestion: 'Blocked' });
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Pending' }) })
    );
  });
});

describe('reportCsamImages and images set aside from the CSAM queue', () => {
  const moderator = { id: 2, isModerator: true } as never;

  beforeEach(async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(
      (async (strings: TemplateStringsArray, ...v: unknown[]) =>
        (await run(Prisma.sql(strings, ...(v as never[])))).rows) as never
    );
    // REVIEW_FLAGGED already carries the CSAM flag, so reporting it changes nothing on the image.
    await holder.db.exec(`
      INSERT INTO "CsamQueueSetAside" ("imageId", "userId", outcome, "moderatorId") VALUES
        (${REVIEW_FLAGGED}, 10, 'Dismissed', 1), (${DECIDED}, 9, 'Dismissed', 1);
    `);
  });

  const setAsideIds = async () =>
    (
      await holder.db.query<{ imageId: number }>(
        `SELECT "imageId" FROM "CsamQueueSetAside" ORDER BY 1`
      )
    ).rows.map((r) => r.imageId);

  it('puts a reported image back in the queue, and only that image', async () => {
    await reportCsamImages({ imageIds: [REVIEW_FLAGGED], user: moderator });

    expect(await setAsideIds()).toEqual([DECIDED]);
    expect((await imageRow(REVIEW_FLAGGED)).needsReview).toBe('csam');
  });

  it('still reports before the migration is applied', async () => {
    await holder.db.exec(`
      ALTER TABLE "Image" DISABLE TRIGGER "Image_csam_queue_set_aside_end";
      ALTER TABLE "CsamQueueSetAside" RENAME TO "CsamQueueSetAsideAway";
    `);
    try {
      await reportCsamImages({ imageIds: [FLAGGED], user: moderator });
      expect((await imageRow(FLAGGED)).needsReview).toBe('csam');
    } finally {
      await holder.db.exec(`
        ALTER TABLE "CsamQueueSetAsideAway" RENAME TO "CsamQueueSetAside";
        ALTER TABLE "Image" ENABLE TRIGGER "Image_csam_queue_set_aside_end";
      `);
    }
  });

  // A role with every grant but the ones named, as an app role whose grants were missed.
  const asRoleWithout = async (revoke: string, fn: () => Promise<void>) => {
    await holder.db.exec(`
      DROP ROLE IF EXISTS app_role;
      CREATE ROLE app_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO app_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_role;
      ${revoke};
      SET ROLE app_role;
    `);
    try {
      await fn();
    } finally {
      await holder.db.exec(`
        ROLLBACK;
        RESET ROLE;
        DROP OWNED BY app_role;
        DROP ROLE app_role;
      `);
    }
  };

  it('still reports when the role may not delete set-asides, and says the grant is missing', async () => {
    loggingMock.logToAxiom.mockClear();
    await asRoleWithout(`REVOKE DELETE ON "CsamQueueSetAside" FROM app_role`, async () => {
      await reportCsamImages({ imageIds: [REVIEW_FLAGGED], user: moderator });
    });
    expect((await imageRow(REVIEW_FLAGGED)).needsReview).toBe('csam');
    expect(await setAsideIds()).toEqual([DECIDED, REVIEW_FLAGGED]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'csam-queue-set-aside-not-deletable' })
    );
  });

  it('ends a set-aside on a flag change by a role with no grant on the table', async () => {
    await asRoleWithout(`REVOKE ALL ON "CsamQueueSetAside" FROM app_role`, async () => {
      await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${DECIDED}`);
    });
    expect(await setAsideIds()).toEqual([REVIEW_FLAGGED]);
  });

  it('lets no role attach the set-aside function to a table of its own', async () => {
    await asRoleWithout(`SELECT 1`, async () => {
      await expect(
        holder.db.exec(`
          CREATE TEMP TABLE own (id int);
          CREATE TRIGGER own_end AFTER UPDATE ON own FOR EACH ROW
            EXECUTE FUNCTION csam_queue_set_aside_end();
        `)
      ).rejects.toThrow(/permission denied for function/);
    });
  });
});

// Scan Labels: a csam-realistic vote can come after a 2-of-3 block already acted. The hold it sends
// is this report, and it must still take the plain-blocked image out of the purge.
describe('reportCsamImages on an image a plain block already removed', () => {
  const moderator = { id: 2, isModerator: true } as never;

  it('holds it and the blocked-image purge keeps it', async () => {
    const { reviewHeldBlockedImagesSql } = await import('~/server/jobs/image-ingestion');
    // The stand-in keeps ingestion as text; the purge's query casts to the enum's name.
    await holder.db.exec(`CREATE DOMAIN "ImageIngestionStatus" AS text`);
    const held = async () =>
      (await run(reviewHeldBlockedImagesSql)).rows.map((r) => (r as { id: number }).id);
    expect(await held()).not.toContain(DECIDED);

    await reportCsamImages({ imageIds: [DECIDED], user: moderator });

    expect(await imageRow(DECIDED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
    expect(await held()).toContain(DECIDED);
  });
});
