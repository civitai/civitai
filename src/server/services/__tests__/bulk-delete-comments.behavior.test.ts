import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, pointsRemoved } = vi.hoisted(() => ({
  pointsRemoved: vi.fn(async (_comments: unknown[]) => undefined),
  holder: { db: null as unknown as PGlite },
}));

vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  onTopicCommentsRemoved: pointsRemoved,
}));

import {
  bulkClearCommentV3TosViolation,
  bulkDeleteComments,
  setFlagsInBatches,
} from '~/server/services/commentv3/moderation.service';

const A = 1;
const B = 2;

/** Runs just before the first statement whose text includes `on`. */
let hook: { on: string; run: () => Promise<unknown> } | null = null;

const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

const SCHEMA = `
    CREATE EXTENSION ltree;
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Dismissed');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Other');
    CREATE TABLE "Report" (id int PRIMARY KEY, status "ReportStatus" NOT NULL, reason "ReportReason" NOT NULL);
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      "parentId" int REFERENCES "CommentV3"(id), "replyToId" int, path ltree NOT NULL, "rootId" int GENERATED ALWAYS AS (ltree2text(subpath(path, 0, 1))::int) STORED,
      "userId" int NOT NULL, content text NOT NULL, "tosViolation" boolean NOT NULL DEFAULT false,
      hidden boolean NOT NULL DEFAULT false, "pinnedAt" timestamptz,
      "deletedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now(), "legacyV1Id" int
    );
    CREATE TABLE "CommentV3Report" (
      "reportId" int PRIMARY KEY, "commentId" int NOT NULL REFERENCES "CommentV3"(id) ON DELETE CASCADE
    );
`;

beforeAll(async () => {
  holder.db = new PGlite({ extensions: { ltree } });
  await holder.db.exec(SCHEMA);
});

// Article comments 81 to 83 (83 a reply under 82), and a model comment 84.
beforeEach(async () => {
  vi.clearAllMocks();
  hook = null;
  await holder.db.exec(`
    TRUNCATE "Report", "CommentV3Report", "CommentV3";
    INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content) VALUES
      (81, 'article', 1, NULL, '81', ${A}, 'zzfixture'),
      (82, 'article', 1, NULL, '82', ${A}, 'zzfixture'),
      (83, 'article', 1, 82, '82.83', ${B}, 'zzfixture'),
      (84, 'model', 7, NULL, '84', ${A}, 'zzfixture');
  `);

  const beforeRun = async (text: string) => {
    if (hook && text.includes(hook.on)) {
      const { run } = hook;
      hook = null;
      await run();
    }
  };
  const queryRaw = async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = asSql(first, values);
    await beforeRun(sql.text);
    return (await holder.db.query(sql.text, sql.values)).rows;
  };
  const queryRawUnsafe = async (text: string, ...params: unknown[]) => {
    await beforeRun(text);
    return (await holder.db.query(text, params)).rows;
  };
  // The stand-in has one connection, so a statement sent outside the transaction would still land
  // inside it. In production it would run on another connection, outside the transaction and its
  // rollback, so one sent there is an error here.
  let inTransaction = false;
  const outside =
    <A extends unknown[]>(run: (...args: A) => Promise<unknown>) =>
    async (...args: A) => {
      if (inTransaction) throw new Error('a statement went outside the transaction');
      return run(...args);
    };
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(outside(queryRaw) as never);
  vi.mocked(dbMock.dbWrite.$queryRawUnsafe).mockImplementation(outside(queryRawUnsafe) as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    await holder.db.query('BEGIN');
    inTransaction = true;
    try {
      const result = await fn({ $queryRaw: queryRaw, $queryRawUnsafe: queryRawUnsafe });
      inTransaction = false;
      await holder.db.query('COMMIT');
      return result;
    } catch (e) {
      inTransaction = false;
      await holder.db.query('ROLLBACK');
      throw e;
    }
  }) as never);
});

const comments = async () =>
  (
    await holder.db.query<{ id: number; content: string; deletedAt: unknown }>(
      `SELECT id, content, "deletedAt" FROM "CommentV3" ORDER BY id`
    )
  ).rows;

describe('bulk delete', () => {
  it('deletes the comments asked for, counting only the rows that exist', async () => {
    await expect(bulkDeleteComments({ ids: [81, 84, 999] })).resolves.toEqual({ deleted: 2 });
    expect((await comments()).map((r) => r.id)).toEqual([82, 83]);
  });

  it('leaves one with replies as a placeholder for them', async () => {
    await expect(bulkDeleteComments({ ids: [82] })).resolves.toEqual({ deleted: 1 });
    const rows = await comments();
    expect(rows.map((r) => r.id)).toEqual([81, 82, 83, 84]);
    expect(rows[1]).toMatchObject({ id: 82, content: '' });
    expect(rows[1].deletedAt).not.toBeNull();
    expect(rows[2]).toMatchObject({ id: 83, content: 'zzfixture', deletedAt: null });
  });

  it('settles points for the removed comments once the delete commits, naming each author and surface', async () => {
    await bulkDeleteComments({ ids: [81, 82, 84] });
    expect(pointsRemoved).toHaveBeenCalledTimes(1);
    // The hook finds the entity whose owner earned the points from the row, not from an id.
    const removed = [...(pointsRemoved.mock.calls[0][0] as { id: number }[])].sort(
      (x, y) => x.id - y.id
    );
    expect(removed).toEqual([
      expect.objectContaining({ id: 81, userId: A, entityType: 'article', entityId: 1 }),
      expect.objectContaining({ id: 82, userId: A, entityType: 'article', entityId: 1 }),
      expect.objectContaining({ id: 84, userId: A, entityType: 'model', entityId: 7 }),
    ]);
  });

  it('changes nothing, and settles no points, when part of the batch fails', async () => {
    // The childless 81 is deleted first; the placeholder for 82 then fails.
    hook = {
      on: 'UPDATE "CommentV3" SET "deletedAt"',
      run: async () => {
        throw new Error('connection reset');
      },
    };

    await expect(bulkDeleteComments({ ids: [81, 82] })).rejects.toThrow('connection reset');
    const rows = await comments();
    expect(rows.map((r) => r.id)).toEqual([81, 82, 83, 84]);
    expect(rows.every((r) => r.content === 'zzfixture' && r.deletedAt === null)).toBe(true);
    expect(pointsRemoved).not.toHaveBeenCalled();
  });
});

describe('flagging comments in batches', () => {
  it('flags every comment of a large set, a bounded batch per transaction', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV3" (id, "entityType", "entityId", path, "userId", content)
      SELECT g, 'article', 2, g::text::ltree, ${B}, 'zzfixture' FROM generate_series(1000, 3499) g;
    `);
    const ids = Array.from({ length: 2_500 }, (_, i) => 1000 + i);

    const changed = await setFlagsInBatches(ids, { tosViolation: true });

    expect(changed).toHaveLength(2_500);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(3);
    const flagged = await holder.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CommentV3" WHERE "tosViolation" AND id BETWEEN 1000 AND 3499`
    );
    expect(flagged.rows[0].n).toBe(2_500);
  });
});

describe('restoring comments from a ToS flag', () => {
  beforeEach(async () => {
    await holder.db.exec(`
      UPDATE "CommentV3" SET "tosViolation" = true;
      INSERT INTO "Report" (id, status, reason) SELECT id, 'Actioned', 'TOSViolation' FROM "CommentV3";
      INSERT INTO "CommentV3Report" ("commentId", "reportId") SELECT id, id FROM "CommentV3";
    `);
  });
  const hidden = async () =>
    Object.fromEntries(
      (
        await holder.db.query<{ id: number; tosViolation: boolean }>(
          `SELECT id, "tosViolation" FROM "CommentV3"`
        )
      ).rows.map((r) => [r.id, r.tosViolation])
    );
  const reports = async () =>
    Object.fromEntries(
      (
        await holder.db.query<{ id: number; status: string }>(`SELECT id, status FROM "Report"`)
      ).rows.map((r) => [r.id, r.status])
    );

  it('leaves the comments hidden and their reports as they were, counting them failed, when the reopen fails', async () => {
    await holder.db.exec(
      `ALTER TABLE "Report" ADD CONSTRAINT no_reopen CHECK (status <> 'Pending') NOT VALID`
    );
    try {
      await expect(bulkClearCommentV3TosViolation({ ids: [81, 82] })).resolves.toEqual({
        count: 0,
        reopenedReports: 0,
        failed: 2,
      });
      expect(await hidden()).toMatchObject({ 81: true, 82: true });
      expect(await reports()).toMatchObject({ 81: 'Actioned', 82: 'Actioned' });
    } finally {
      await holder.db.exec(`ALTER TABLE "Report" DROP CONSTRAINT no_reopen`);
    }
  });

  it('counts a comment that is not flagged, deleted, or missing as nothing', async () => {
    await holder.db.exec(`
      UPDATE "CommentV3" SET "tosViolation" = false WHERE id = 81;
      UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = 84;
    `);

    await expect(bulkClearCommentV3TosViolation({ ids: [81, 84, 999] })).resolves.toEqual({
      count: 0,
      reopenedReports: 0,
      failed: 0,
    });
    expect(await reports()).toMatchObject({ 81: 'Actioned', 84: 'Actioned' });
  });
});
