import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';
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
  resolveEntityAppeal: vi.fn(),
  createEntityAppeal: vi.fn(),
  reopenAppeal: vi.fn(),
  getLatestAppeal: vi.fn(),
  trackModActivity: vi.fn(),
  isAccountUnderLegalHold: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  resolveEntityAppeal: mocks.resolveEntityAppeal,
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

const { resolveLockReviewAppeal, getLockReviewState, LOCK_REVIEW_HELD, LOCK_REVIEW_UNAVAILABLE } =
  await import('~/server/services/lock-review.service');
const { createEntityAppealHandler } = await import('~/server/controllers/report.controller');
const actualReport = await vi.importActual<typeof ReportService>(
  '~/server/services/report.service'
);

const MODEL = 71;
const OWNER = 82;
const MODERATOR = 3;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
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
      status text NOT NULL DEFAULT 'Pending',
      category text,
      context jsonb
    );
    CREATE TABLE "Held" ("userId" int PRIMARY KEY);
  `);
  const raw = pgliteRaw(db);
  const tx = {
    $queryRaw: raw.queryRaw,
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
};

async function seed({ locked, asked = ['nsfw'], nsfw = true, poi, minor, held }: Seed) {
  await db.exec(`DELETE FROM "Model"; DELETE FROM "Appeal"; DELETE FROM "Held";`);
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", nsfw, poi, minor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [MODEL, OWNER, locked, nsfw, !!poi, !!minor]
  );
  await db.query(
    `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (1, $1, 'Model', $2, $3)`,
    [OWNER, MODEL, { kind: 'lock-review', locks: asked }]
  );
  if (held) await db.query(`INSERT INTO "Held" ("userId") VALUES ($1)`, [OWNER]);
}

const modelRow = async () =>
  (
    await db.query<{ lockedProperties: string[]; nsfw: boolean }>(
      `SELECT "lockedProperties", nsfw FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

const approve = () => resolveLockReviewAppeal({ modelId: MODEL, approve: true, userId: MODERATOR });
const reject = () => resolveLockReviewAppeal({ modelId: MODEL, approve: false, userId: MODERATOR });

const loggedActivities = () =>
  mocks.trackModActivity.mock.calls.map(([, input]) => (input as { activity: string }).activity);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEntityAppeal.mockResolvedValue([]);
  mocks.createEntityAppeal.mockResolvedValue({ id: 1 });
  mocks.reopenAppeal.mockResolvedValue({ id: 1 });
  mocks.getLatestAppeal.mockResolvedValue(null);
  mocks.isAccountUnderLegalHold.mockResolvedValue(false);
  dbMock.dbRead.appeal.findFirst.mockResolvedValue(null);
});

describe('approving a lock review', () => {
  it('unlocks only the named settings still locked, and leaves their values', async () => {
    await seed({ locked: ['nsfw', 'category', 'tags'], asked: ['nsfw', 'sfwOnly'] });

    const { unlocked } = await approve();

    expect(unlocked).toEqual(['nsfw']);
    expect(await modelRow()).toEqual({ lockedProperties: ['category', 'tags'], nsfw: true });
    expect(mocks.resolveEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: [MODEL],
        status: AppealStatus.Approved,
        modelAppealKind: 'lock-review',
      })
    );
    expect(loggedActivities()).toEqual(['approveLockReview', 'unlockProperty:nsfw']);
  });

  it('refuses while the owner is under an evidence hold, and changes nothing', async () => {
    await seed({ locked: ['nsfw'], held: true });

    await expect(approve()).rejects.toThrow(LOCK_REVIEW_HELD);
    expect(LOCK_REVIEW_HELD).toContain('under an evidence hold');
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
    expect(mocks.resolveEntityAppeal).not.toHaveBeenCalled();
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
  });

  it.each([{ poi: true }, { minor: true }])(
    'refuses once the model is flagged (%o), leaving its locks',
    async (flag) => {
      await seed({ locked: ['nsfw'], ...flag });

      await expect(approve()).rejects.toThrow(/real person or a minor/);
      expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
      expect(mocks.resolveEntityAppeal).not.toHaveBeenCalled();
    }
  );

  it('refuses a model whose pending appeal is a flag appeal', async () => {
    await seed({ locked: ['nsfw'] });
    await db.query(`UPDATE "Appeal" SET context = NULL`);

    await expect(approve()).rejects.toThrow(/no pending locked-setting review/);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
  });
});

describe('rejecting a lock review', () => {
  it('keeps the locks and closes the request as rejected, even under a hold', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'], held: true });

    const { unlocked } = await reject();

    expect(unlocked).toEqual([]);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw', 'tags']);
    expect(mocks.resolveEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ status: AppealStatus.Rejected, modelAppealKind: 'lock-review' })
    );
    expect(loggedActivities()).toEqual(['rejectLockReview']);
  });

  it('tells the owner through the existing appeal-resolved notification', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([
      {
        id: 1,
        entityId: MODEL,
        entityType: EntityType.Model,
        resolvedAt: new Date(),
        buzzTransactionId: null,
        status: AppealStatus.Rejected,
        userId: OWNER,
        createdAt: new Date(),
      },
    ] as never);

    await actualReport.resolveEntityAppeal({
      ids: [MODEL],
      entityType: EntityType.Model,
      status: AppealStatus.Rejected,
      userId: MODERATOR,
      modelAppealKind: 'lock-review',
    });

    expect(dbMock.dbWrite.appeal.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ context: { path: ['kind'], equals: 'lock-review' } }),
      })
    );
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER,
        type: 'entity-appeal-resolved',
        details: expect.objectContaining({ status: AppealStatus.Rejected }),
      })
    );
  });

  it('starts the 30-day cooldown while every setting asked about stays locked', async () => {
    const resolvedAt = new Date();
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      userId: OWNER,
      lockedProperties: ['nsfw'],
      poi: false,
      minor: false,
    } as never);
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

const ownModel = (fields: Record<string, unknown> = {}) =>
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    userId: OWNER,
    lockedProperties: ['nsfw'],
    poi: false,
    minor: false,
    meta: null,
    ...fields,
  } as never);

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

  it('leaves a flagged model on the flag appeal, which carries no lock review', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    mocks.getLatestAppeal.mockResolvedValue({ id: 9, status: AppealStatus.Approved });

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(mocks.reopenAppeal).toHaveBeenCalledWith(expect.objectContaining({ context: null }));
  });

  it.each([true, null])(
    'under a hold (%s) is refused exactly as an unrequestable setting is',
    async (held) => {
      ownModel({ lockedProperties: ['nsfw', 'tags'] });
      const notRequestable = await refusal(
        createEntityAppealHandler({ input: request(['category']), ctx: owner() })
      );

      mocks.isAccountUnderLegalHold.mockResolvedValue(held);
      const underHold = await refusal(
        createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() })
      );

      expect(notRequestable).toEqual({ code: 'BAD_REQUEST', message: LOCK_REVIEW_UNAVAILABLE });
      expect(underHold).toEqual(notRequestable);
      expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
    }
  );
});
