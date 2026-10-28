import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';
import type * as Email from '~/server/email/templates';
import type * as LegalHold from '~/server/services/legal-hold.service';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as ReportService from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

/**
 * An owner's request to review a locked model setting, filed as an `Appeal` row and ruled on from the
 * moderator app's flag-appeals queue. The ruling's own SQL runs against PGlite; the hold is a stand-in
 * table behind `accountHoldSql`, so what is tested is that the ruling reads the owner's hold, not
 * which holds exist. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  settleResolvedAppeals: vi.fn(),
  createEntityAppeal: vi.fn(),
  reopenAppeal: vi.fn(),
  getLatestAppeal: vi.fn(),
  trackModActivity: vi.fn(),
  isAccountUnderLegalHold: vi.fn(),
  createNotification: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  settleResolvedAppeals: mocks.settleResolvedAppeals,
  createEntityAppeal: mocks.createEntityAppeal,
  reopenAppeal: mocks.reopenAppeal,
  getLatestAppeal: mocks.getLatestAppeal,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: mocks.trackModActivity,
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHold>()),
  accountHoldSql: (id: Prisma.Sql) =>
    Prisma.sql`EXISTS (SELECT 1 FROM "Held" h WHERE h."userId" = ${id})`,
  holdMarkerViewExists: async () => true,
  isAccountUnderLegalHold: mocks.isAccountUnderLegalHold,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof Email>()),
  moderationActionEmail: { send: mocks.sendEmail },
}));

const { resolveLockReviewAppeal, getLockReviewState, LOCK_REVIEW_HELD, LOCK_REVIEW_UNAVAILABLE } =
  await import('~/server/services/lock-review.service');
const { createEntityAppealHandler } = await import('~/server/controllers/report.controller');
const actualReport = await vi.importActual<typeof ReportService>(
  '~/server/services/report.service'
);

const MODEL = 71;
const OWNER = 82;
const NEW_OWNER = 83;
const MODERATOR = 3;
const OTHER_MODERATOR = 4;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "lockedProperties" text[] NOT NULL DEFAULT '{}',
      nsfw boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Appeal" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending',
      category text,
      context jsonb,
      "buzzTransactionId" text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "updatedAt" timestamp(3),
      "resolvedAt" timestamp(3),
      "resolvedBy" int,
      "resolvedReason" text,
      "resolvedMessage" text,
      "internalNotes" text
    );
    CREATE TABLE "Held" ("userId" int PRIMARY KEY);
  `);
  const raw = pgliteRaw(db);
  const tx = {
    $queryRaw: raw.queryRaw,
    $executeRaw: raw.executeRaw,
    model: {
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const keys = Object.keys(data);
        await db.query(
          `UPDATE "Model" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} WHERE id = $1`,
          [where.id, ...keys.map((k) => data[k])]
        );
      },
    },
  };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
});
afterAll(() => db.close());

type Seed = {
  locked: string[];
  asked?: string[];
  nsfw?: boolean;
  poi?: boolean;
  minor?: boolean;
  held?: boolean;
  owner?: number;
};

async function seed({ locked, asked = ['nsfw'], nsfw = true, poi, minor, held, owner }: Seed) {
  await db.exec(`DELETE FROM "Model"; DELETE FROM "Appeal"; DELETE FROM "Held";`);
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", nsfw, poi, minor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [MODEL, owner ?? OWNER, locked, nsfw, !!poi, !!minor]
  );
  await db.query(
    `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (1, $1, 'Model', $2, $3)`,
    [OWNER, MODEL, { kind: 'lock-review', locks: asked }]
  );
  if (held) await db.query(`INSERT INTO "Held" ("userId") VALUES ($1)`, [owner ?? OWNER]);
}

const modelRow = async () =>
  (
    await db.query<{ lockedProperties: string[]; nsfw: boolean }>(
      `SELECT "lockedProperties", nsfw FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

const appealRow = async () =>
  (
    await db.query<{ status: string; resolvedBy: number | null }>(
      `SELECT status, "resolvedBy" FROM "Appeal" WHERE id = 1`
    )
  ).rows[0];

const approve = (userId = MODERATOR) =>
  resolveLockReviewAppeal({ appealId: 1, modelId: MODEL, approve: true, userId });
const reject = (userId = MODERATOR) =>
  resolveLockReviewAppeal({ appealId: 1, modelId: MODEL, approve: false, userId });

const loggedActivities = () =>
  mocks.trackModActivity.mock.calls.map(([, input]) => (input as { activity: string }).activity);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settleResolvedAppeals.mockResolvedValue([]);
  mocks.createEntityAppeal.mockResolvedValue({ id: 1 });
  mocks.reopenAppeal.mockResolvedValue({ id: 1 });
  mocks.getLatestAppeal.mockResolvedValue(null);
  mocks.isAccountUnderLegalHold.mockResolvedValue(false);
  dbMock.dbRead.appeal.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.appeal.findFirst.mockResolvedValue(null);
});

describe('approving a lock review', () => {
  it('unlocks only the named settings still locked, and leaves their values', async () => {
    await seed({ locked: ['nsfw', 'category', 'tags'], asked: ['nsfw', 'sfwOnly'] });

    const { unlocked } = await approve();

    expect(unlocked).toEqual(['nsfw']);
    expect(await modelRow()).toEqual({ lockedProperties: ['category', 'tags'], nsfw: true });
    expect(await appealRow()).toEqual({ status: 'Approved', resolvedBy: MODERATOR });
    expect(mocks.settleResolvedAppeals).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 1, userId: OWNER, status: 'Approved' })],
      { status: AppealStatus.Approved }
    );
    expect(loggedActivities()).toEqual(['approveLockReview', 'unlockProperty:nsfw']);
  });

  it('refuses while the owner is under an evidence hold, and changes nothing', async () => {
    await seed({ locked: ['nsfw'], held: true });

    await expect(approve()).rejects.toThrow(LOCK_REVIEW_HELD);
    expect(LOCK_REVIEW_HELD).toContain('under an evidence hold');
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
    expect((await appealRow()).status).toBe('Pending');
    expect(mocks.settleResolvedAppeals).not.toHaveBeenCalled();
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
  });

  it.each([
    { poi: true },
    { minor: true },
    { locked: ['nsfw', 'minor'] },
    { locked: ['nsfw', 'poi'] },
  ])(
    'refuses once the model is flagged or locked as a real person or a minor (%o)',
    async (flag) => {
      await seed({ locked: ['nsfw'], ...flag });
      const before = (await modelRow()).lockedProperties;

      await expect(approve()).rejects.toThrow(/real person or a minor/);
      expect((await modelRow()).lockedProperties).toEqual(before);
      expect((await appealRow()).status).toBe('Pending');
    }
  );

  it('refuses a request filed by someone who no longer owns the model', async () => {
    await seed({ locked: ['nsfw'], owner: NEW_OWNER });

    await expect(approve()).rejects.toThrow(/changed owner/);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
  });

  it.each([
    ['a flag appeal', `UPDATE "Appeal" SET context = NULL`],
    ['an already rejected request', `UPDATE "Appeal" SET status = 'Rejected'`],
  ])('refuses %s', async (_, change) => {
    await seed({ locked: ['nsfw'] });
    await db.query(change);

    await expect(approve()).rejects.toThrow(/no pending locked-setting review/);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
  });

  it('leaves nothing for a second moderator to rule on', async () => {
    await seed({ locked: ['nsfw'] });

    await approve();
    await expect(reject(OTHER_MODERATOR)).rejects.toThrow(/no pending locked-setting review/);

    expect(await appealRow()).toEqual({ status: 'Approved', resolvedBy: MODERATOR });
    expect(mocks.settleResolvedAppeals).toHaveBeenCalledTimes(1);
  });
});

describe('rejecting a lock review', () => {
  it('keeps the locks and closes the request as rejected, even under a hold', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'], held: true });

    const { unlocked } = await reject();

    expect(unlocked).toEqual([]);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw', 'tags']);
    expect(await appealRow()).toEqual({ status: 'Rejected', resolvedBy: MODERATOR });
    expect(loggedActivities()).toEqual(['rejectLockReview']);
  });

  it('tells the owner in the standard rejection words, never naming a hold', async () => {
    await seed({ locked: ['nsfw'], held: true });
    await expect(approve()).rejects.toThrow(LOCK_REVIEW_HELD);
    await reject();
    const [claimed, options] = mocks.settleResolvedAppeals.mock.calls[0];

    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: OWNER, email: 'owner@example.test', username: 'owner' },
    ] as never);
    await actualReport.settleResolvedAppeals(claimed, options);

    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER,
        type: 'entity-appeal-resolved',
        details: {
          entityType: EntityType.Model,
          entityId: MODEL,
          status: AppealStatus.Rejected,
          resolvedMessage: undefined,
        },
      })
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'appeal-rejected' })
    );
    expect(
      JSON.stringify([mocks.createNotification.mock.calls, mocks.sendEmail.mock.calls])
    ).not.toMatch(/hold/i);
  });

  it('starts the 30-day cooldown while every setting asked about stays locked', async () => {
    const resolvedAt = new Date();
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      status: AppealStatus.Rejected,
      resolvedAt,
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);

    const state = await getLockReviewState({ modelId: MODEL, userId: OWNER });
    expect(state?.reopensAt?.getTime()).toBe(resolvedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    await expect(
      createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() })
    ).rejects.toThrow(/You can ask again on/);
    expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });

  it('keeps the cooldown when a newer flag-appeal row exists', async () => {
    const resolvedAt = new Date();
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockImplementation(((args: { where: object }) =>
      Promise.resolve(
        'context' in args.where
          ? {
              status: AppealStatus.Rejected,
              resolvedAt,
              context: { kind: 'lock-review', locks: ['nsfw'] },
            }
          : { status: AppealStatus.Approved, resolvedAt, context: null }
      )) as never);

    expect((await getLockReviewState({ modelId: MODEL, userId: OWNER }))?.reopensAt).not.toBeNull();
  });

  it('ends the cooldown once 30 days have passed', async () => {
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      status: AppealStatus.Rejected,
      resolvedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);

    expect((await getLockReviewState({ modelId: MODEL, userId: OWNER }))?.reopensAt).toBeNull();
  });
});

describe('a flag appeal resolving on the same model', () => {
  it('closes only flag appeals, so a lock review is not approved by a flag lift', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([] as never);

    await actualReport.resolveEntityAppeal({
      ids: [MODEL],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      modelAppealKind: 'flag',
    });

    expect(dbMock.dbWrite.appeal.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { context: { equals: Prisma.AnyNull } },
            { NOT: { context: { path: ['kind'], equals: 'lock-review' } } },
          ],
        }),
      })
    );
  });
});

const owner = () => ({ user: { id: OWNER }, features: {} } as never);
const request = (locks?: string[]) => ({
  entityId: MODEL,
  entityType: EntityType.Model,
  message: 'The model is SFW; the lock was set before I retagged it.',
  ...(locks && { locks }),
});

function ownModel(fields: Record<string, unknown> = {}) {
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    userId: OWNER,
    lockedProperties: ['nsfw'],
    poi: false,
    minor: false,
    meta: null,
    ...fields,
  } as never);
}

/** The refusal as the caller sees it: tRPC code and message. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

describe("an owner's request", () => {
  it('files an appeal naming the settings', async () => {
    ownModel();

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: MODEL,
        context: { kind: 'lock-review', locks: ['nsfw'] },
        skipFee: true,
      })
    );
  });

  it('reopens the earlier row as a lock review once the cooldown is over', async () => {
    ownModel();
    mocks.getLatestAppeal.mockResolvedValue({ id: 9, status: AppealStatus.Rejected });
    dbMock.dbRead.appeal.findFirst.mockImplementation(((args: { where: object }) =>
      Promise.resolve(
        'context' in args.where ? { id: 9, status: AppealStatus.Rejected } : null
      )) as never);

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.reopenAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, context: { kind: 'lock-review', locks: ['nsfw'] } })
    );

    dbMock.dbWrite.appeal.update.mockResolvedValue({ id: 9 } as never);
    await actualReport.reopenAppeal({
      id: 9,
      message: 'again',
      context: { kind: 'lock-review', locks: ['nsfw'] },
    });
    expect(dbMock.dbWrite.appeal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } }),
      })
    );
  });

  it.each([{ poi: true }, { minor: true }, { lockedProperties: ['nsfw', 'poi'] }])(
    'is refused on a model flagged as a real person or a minor (%o)',
    async (flag) => {
      ownModel(flag);

      expect(
        await refusal(createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() }))
      ).toEqual({ code: 'BAD_REQUEST', message: LOCK_REVIEW_UNAVAILABLE });
      expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
    }
  );

  it("reopens only the owner's flag-appeal row for a flag appeal, never a lock review", async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    mocks.getLatestAppeal.mockResolvedValue({ id: 9, status: AppealStatus.Rejected });
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      id: 4,
      status: AppealStatus.Approved,
    } as never);

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(mocks.reopenAppeal).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
    expect(dbMock.dbRead.appeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { context: { equals: Prisma.AnyNull } },
            { NOT: { context: { path: ['kind'], equals: 'lock-review' } } },
          ],
        }),
      })
    );
  });

  it('files a new row when the owner has no row of that kind yet', async () => {
    ownModel();
    mocks.getLatestAppeal.mockResolvedValue({ id: 4, status: AppealStatus.Rejected });

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } })
    );
  });

  it.each([true, null])('under a hold (%s) files exactly as without one', async (held) => {
    ownModel();
    const unheld = await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });
    const unheldRow = mocks.createEntityAppeal.mock.calls[0];

    mocks.isAccountUnderLegalHold.mockResolvedValue(held);
    const underHold = await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(underHold).toEqual(unheld);
    expect(mocks.createEntityAppeal.mock.calls[1]).toEqual(unheldRow);
  });
});

describe('a flag landing while a lock review is open', () => {
  it('lets the owner appeal the flag on the same row', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({
      id: 9,
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);
    dbMock.dbWrite.appeal.updateMany.mockResolvedValue({ count: 1 } as never);

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(dbMock.dbWrite.appeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9, status: AppealStatus.Pending }),
        data: expect.objectContaining({ context: Prisma.DbNull }),
      })
    );
  });

  it('refuses the takeover when the lock review was ruled on meanwhile', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({
      id: 9,
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);
    dbMock.dbWrite.appeal.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /changed meanwhile/
    );
  });

  it('refuses a request while an older row is pending behind a newer resolved one', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    mocks.getLatestAppeal.mockResolvedValue({ id: 12, status: AppealStatus.Rejected });
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 4, context: null } as never);

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /already under review/
    );
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });

  it('still refuses a second flag appeal', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 9, context: null } as never);

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /already under review/
    );
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });
});

describe('two pending requests on one model', () => {
  it('rules on the older one when that is the one shown', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'] });
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (2, $1, 'Model', $2, $3)`,
      [OWNER, MODEL, { kind: 'lock-review', locks: ['tags'] }]
    );

    expect(await approve()).toEqual({ unlocked: ['nsfw'] });
    expect((await modelRow()).lockedProperties).toEqual(['tags']);
  });

  it('rules on the one the moderator was shown', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'] });
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (2, $1, 'Model', $2, $3)`,
      [OWNER, MODEL, { kind: 'lock-review', locks: ['tags'] }]
    );

    const { unlocked } = await resolveLockReviewAppeal({
      appealId: 2,
      modelId: MODEL,
      approve: true,
      userId: MODERATOR,
    });

    expect(unlocked).toEqual(['tags']);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
    const { rows } = await db.query<{ id: number; status: string }>(
      `SELECT id, status FROM "Appeal" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 1, status: 'Pending' },
      { id: 2, status: 'Approved' },
    ]);
  });
});

describe('a ruling whose owner notice fails', () => {
  it('still reports the committed ruling', async () => {
    await seed({ locked: ['nsfw'] });
    mocks.settleResolvedAppeals.mockRejectedValue(new Error('notifications down'));

    await expect(approve()).resolves.toEqual({ unlocked: ['nsfw'] });
    expect((await appealRow()).status).toBe('Approved');
  });
});

describe('an owner deleting the model', () => {
  it('is told of neither a lock review nor a flag appeal closing, only of other appeals', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      {
        id: 1,
        userId: OWNER,
        entityType: EntityType.Model,
        entityId: MODEL,
        buzzTransactionId: null,
        context: { kind: 'lock-review', locks: ['nsfw'] },
      },
      {
        id: 2,
        userId: OWNER,
        entityType: EntityType.Model,
        entityId: MODEL + 1,
        buzzTransactionId: null,
        context: null,
      },
    ] as never);

    await actualReport.closeAppealsDeletedByOwner({
      entityType: EntityType.Model,
      entityIds: [MODEL, MODEL + 1],
      ownerId: OWNER,
    });

    expect(mocks.createNotification).not.toHaveBeenCalled();

    // The control: an image appeal closed the same way is still notified.
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      { id: 3, userId: OWNER, entityType: EntityType.Image, entityId: 5, buzzTransactionId: null },
    ] as never);
    await actualReport.closeAppealsDeletedByOwner({
      entityType: EntityType.Image,
      entityIds: [5],
      ownerId: OWNER,
    });
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });
});
