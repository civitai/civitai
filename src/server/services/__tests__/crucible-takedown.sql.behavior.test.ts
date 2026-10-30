import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleConstants from '~/shared/constants/crucible.constants';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as PostService from '~/server/services/post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as Caches from '~/server/redis/caches';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as NotificationService from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks';
import { CRUCIBLE_ENTRY_DRAFT_METADATA_KEY } from '~/server/selectors/image.selector';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';

/** Runs the takedown's own SQL (the claim and the entry-post reset) against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const policy = vi.hoisted(() => ({ mode: 'forfeit' as 'forfeit' | 'refund' | 'hold' }));
vi.mock('~/shared/constants/crucible.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleConstants>()),
  get CRUCIBLE_TAKEDOWN_CREATOR_FUNDS() {
    return policy.mode;
  },
}));
const { queueImageSearchIndexUpdate, refreshPostCount, refreshImageCount } = vi.hoisted(() => ({
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
  refreshPostCount: vi.fn(async () => undefined),
  refreshImageCount: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: refreshPostCount },
  userImageVideoCountCaches: { refresh: refreshImageCount },
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { setTTL: vi.fn(async () => undefined) },
}));

// post.service and image.service import each other: loaded first, post.service binds to the mocked
// image.service rather than the original that image.service's own factory is still loading.
await import('~/server/services/post.service');
const { takeDownCrucible, cancelCrucible } = await import('~/server/services/crucible.service');

let db: PGlite;
const sqlOf = (strings: TemplateStringsArray, values: unknown[]) => Prisma.sql(strings, ...values);

const crucibleRow = async (id: number) =>
  (
    await db.query<{
      status: CrucibleStatus;
      takenDownAt: Date | null;
      takedownReason: string | null;
      takedownRefundsCreator: boolean;
    }>(
      `SELECT status, "takenDownAt", "takedownReason", "takedownRefundsCreator"
       FROM "Crucible" WHERE id = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible"(id int PRIMARY KEY, status "CrucibleStatus", "endAt" timestamp(3),
      "takenDownAt" timestamp(3), "takenDownById" int, "takedownReason" text,
      "takedownRefundsCreator" boolean NOT NULL DEFAULT false);
    CREATE TABLE "CrucibleEntry"(id int PRIMARY KEY, "crucibleId" int, "imageId" int);
    CREATE TABLE "Image"(id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Post"(id int PRIMARY KEY, "publishedAt" timestamp(3), metadata jsonb,
      "userId" int DEFAULT 1);
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  policy.mode = 'forfeit';
  await db.exec(`
    DELETE FROM "Crucible"; DELETE FROM "CrucibleEntry"; DELETE FROM "Image"; DELETE FROM "Post";
    INSERT INTO "Crucible"(id, status, "endAt") VALUES
      (1, 'Active', now() + interval '1 day'),
      (2, 'Completed', now() - interval '1 day'),
      (3, 'Active', now() - interval '1 minute'),
      (4, 'Cancelled', now() + interval '1 day');
    -- Crucible 1's entries: a post still scheduled for the end, one already public, and an
    -- ordinary post that is not an entry-modal one.
    INSERT INTO "Post"(id, "publishedAt", metadata) VALUES
      (10, now() + interval '1 day', '{"${CRUCIBLE_ENTRY_DRAFT_METADATA_KEY}": true}'),
      (11, now() - interval '1 day', '{"${CRUCIBLE_ENTRY_DRAFT_METADATA_KEY}": true}'),
      (12, now() + interval '1 day', '{}'),
      (13, now() + interval '1 day', '{"${CRUCIBLE_ENTRY_DRAFT_METADATA_KEY}": true}');
    INSERT INTO "Image" VALUES (100, 10), (101, 11), (102, 12), (103, 13);
    INSERT INTO "CrucibleEntry" VALUES (1, 1, 100), (2, 1, 101), (3, 1, 102), (4, 4, 103);
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...values) => {
    const sql = sqlOf(strings, values);
    return (await db.query(sql.text, sql.values)).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values
  ) => {
    const sql = sqlOf(strings, values);
    return (await db.query(sql.text, sql.values)).affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.image.findMany.mockImplementation(
    (async ({ where }: { where: { postId: { in: number[] } } }) =>
      (
        await db.query<{ id: number }>(`SELECT id FROM "Image" WHERE "postId" = ANY($1)`, [
          where.postId.in,
        ])
      ).rows) as never
  );
  dbMock.dbWrite.crucible.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({
    id: where.id,
    name: 'A crucible',
    ingestion: CrucibleIngestionStatus.Scanned,
    textNsfw: false,
    userId: 4,
    entryFee: 0,
    buzzTransactionId: null,
    seededPrizePool: 0,
    seedTransactionId: null,
    entries: [],
    ...(await crucibleRow(where.id)),
  })) as never);
});

const takeDown = (id: number, reason = 'The first reason given', releaseCreatorFunds = false) =>
  takeDownCrucible({ id, reason, moderatorId: 1, releaseCreatorFunds });

describe('the takedown claim', () => {
  it('stops a running crucible and records the reason', async () => {
    await takeDown(1);

    expect(await crucibleRow(1)).toMatchObject({
      status: CrucibleStatus.Cancelled,
      takedownReason: 'The first reason given',
      takenDownAt: expect.any(Date),
    });
  });

  it('keeps the first reason when re-run with another', async () => {
    await takeDown(1);
    await takeDown(1, 'A different, later reason');

    expect((await crucibleRow(1)).takedownReason).toBe('The first reason given');
  });

  it('leaves a Completed crucible Completed', async () => {
    await takeDown(2);

    expect(await crucibleRow(2)).toMatchObject({
      status: CrucibleStatus.Completed,
      takenDownAt: expect.any(Date),
    });
  });

  it('leaves a crucible past its end to finalize, entered or not', async () => {
    await expect(takeDown(3)).rejects.toThrow(/being finalized/);

    expect(await crucibleRow(3)).toMatchObject({
      status: CrucibleStatus.Active,
      takenDownAt: null,
    });
  });
});

describe('the entry posts', () => {
  it('returns scheduled entry posts to drafts and leaves the rest alone', async () => {
    await takeDown(1);

    const { rows } = await db.query<{ id: number; publishedAt: Date | null }>(
      `SELECT id, "publishedAt" FROM "Post" WHERE id IN (10, 11, 12, 13) ORDER BY id`
    );
    expect(rows.map((r) => [r.id, r.publishedAt === null])).toEqual([
      [10, true],
      [11, false],
      [12, false],
      [13, false], // another crucible's
    ]);
    // Indexed at submit as published from the old end, so the drafted post's image leaves search.
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [100], action: 'Delete' });
    // Its author's public post and image counts drop by the drafted post.
    expect(refreshPostCount).toHaveBeenCalledWith([1]);
    expect(refreshImageCount).toHaveBeenCalledWith([1]);
  });
});

describe('what the takedown owes the creator', () => {
  it('is nothing under forfeit, for a crucible it stops', async () => {
    await takeDown(1);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(false);
  });

  it('is the refund a cancel before it already committed to', async () => {
    await takeDown(4);
    expect((await crucibleRow(4)).takedownRefundsCreator).toBe(true);
  });

  it('is a refund under the refund policy', async () => {
    policy.mode = 'refund';
    await takeDown(1);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(true);
  });

  it('stays nothing under forfeit when re-run', async () => {
    await takeDown(1);
    await takeDown(1);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(false);
  });

  it('is a refund when held funds are released on the first call', async () => {
    policy.mode = 'hold';
    await takeDown(1, 'The first reason given', true);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(true);
  });

  it('becomes a refund when held funds are released', async () => {
    policy.mode = 'hold';
    await takeDown(1);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(false);

    await takeDown(1, 'The first reason given', true);
    expect((await crucibleRow(1)).takedownRefundsCreator).toBe(true);
  });
});

describe('a cancel racing a takedown', () => {
  it('does not reveal the entry posts of a crucible taken down after the cancel read it', async () => {
    await db.exec(`UPDATE "Crucible" SET "takenDownAt" = now() WHERE id = 4`);
    dbMock.dbWrite.crucible.updateMany.mockResolvedValue({ count: 1 } as never);
    // The cancel read the row before the takedown landed.
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({
      ...(await dbMock.dbWrite.crucible.findUnique({ where: { id: 4 } } as never)),
      takenDownAt: null,
    } as never);

    await cancelCrucible({ id: 4, userId: 1, isModerator: true });

    // The reveal ran and chose nothing, rather than failing.
    const { loggingMock } = await import('~/__tests__/mocks');
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-posts-reveal-failed' })
    );

    const { rows } = await db.query<{ publishedAt: Date | null }>(
      `SELECT "publishedAt" FROM "Post" WHERE id = 13`
    );
    expect(rows[0].publishedAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
