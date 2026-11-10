import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, pointsRemoved } = vi.hoisted(() => ({
  pointsRemoved: vi.fn(async (_comments: { userId: number; threadId: number }[]) => undefined),
  holder: { db: null as unknown as PGlite },
}));

vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  onCommentsRemoved: pointsRemoved,
}));

import {
  bulkClearCommentV2TosViolation,
  bulkDeleteCommentsV2,
} from '~/server/services/commentsv2.service';

const A = 1;
const B = 2;
// Comment ids are 10 * author + n.
const ids = (...authors: number[]) => authors.flatMap((a) => [a * 10 + 1, a * 10 + 2]);

/** Runs just before the first statement whose text includes `on`. */
let hook: { on: string; run: (sql: Prisma.Sql) => Promise<unknown> } | null = null;

const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

const SCHEMA = `
    CREATE EXTENSION ltree;
    -- A model comment's v1 row, kept in step until the table is dropped.
    CREATE TABLE "Comment" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelId" int NOT NULL, content text NOT NULL,
      "parentId" int REFERENCES "Comment"(id) ON DELETE CASCADE,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL, content text NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
      metadata jsonb
    );
    -- A comment's reply thread; deleting the comment only unlinks it, as in production.
    CREATE TABLE "Thread" (
      id int PRIMARY KEY, "commentId" int UNIQUE REFERENCES "CommentV2"(id) ON DELETE SET NULL,
      "parentThreadId" int, "rootThreadId" int
    );
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Dismissed');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Other');
    CREATE TABLE "Report" (id int PRIMARY KEY, status "ReportStatus" NOT NULL, reason "ReportReason" NOT NULL);
    CREATE TABLE "CommentV2Report" ("commentV2Id" int NOT NULL, "reportId" int NOT NULL);
    -- Comments on a surface that writes CommentV3 directly, which have no CommentV2 row.
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      "parentId" int REFERENCES "CommentV3"(id), "replyToId" int, path ltree NOT NULL, "rootId" int GENERATED ALWAYS AS (ltree2text(subpath(path, 0, 1))::int) STORED,
      "userId" int NOT NULL, content text NOT NULL, "tosViolation" boolean NOT NULL DEFAULT false,
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

beforeEach(async () => {
  vi.clearAllMocks();
  hook = null;
  const authors = [A, B];
  const rows = () =>
    authors
      .flatMap((a) => [1, 2].map((n) => `(${a * 10 + n}, ${a}, ${a * 100}, 'zzfixture')`))
      .join(', ');
  await holder.db.exec(`
    TRUNCATE "Comment", "CommentV2", "Thread", "Report", "CommentV2Report", "CommentV3",
      "CommentV3Report";
    INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES ${rows()};
  `);

  const queryRaw = async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = asSql(first, values);
    if (hook && sql.text.includes(hook.on)) {
      const { run } = hook;
      hook = null;
      await run(sql);
    }
    return (await holder.db.query(sql.text, sql.values)).rows;
  };
  // The stand-in has one connection, so a statement sent outside the transaction would still land
  // inside it. In production it would run on another connection, outside the transaction and its
  // rollback, so one sent there is an error here.
  let inTransaction = false;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    if (inTransaction) throw new Error('a statement went outside the transaction');
    return queryRaw(first, ...values);
  }) as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    await holder.db.query('BEGIN');
    inTransaction = true;
    try {
      const result = await fn({
        $queryRaw: queryRaw,
        $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
          (
            await holder.db.query(sql, params)
          ).rows,
      });
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

async function state(table: 'Comment' | 'CommentV2' | 'CommentV3') {
  const { rows } = await holder.db.query<{ id: number; tosViolation: boolean }>(
    `SELECT id, "tosViolation" FROM "${table}" ORDER BY id`
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tosViolation ? 'hidden' : 'public']));
}

describe('bulk delete', () => {
  it('deletes the comments asked for, counting only the rows that exist', async () => {
    await expect(bulkDeleteCommentsV2({ ids: [...ids(A), 21, 999] })).resolves.toEqual({
      deleted: 3,
    });
    expect(await state('CommentV2')).toEqual({ 22: 'public' });
  });

  it('leaves a CommentV2’s replies, unlinking their thread from it', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "commentId") VALUES (900, 11);
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (72, ${B}, 900, 'zzfixture');
    `);

    await expect(bulkDeleteCommentsV2({ ids: [11] })).resolves.toEqual({ deleted: 1 });
    expect(await state('CommentV2')).not.toHaveProperty('11');
    expect(await state('CommentV2')).toMatchObject({ 72: 'public' });
    const { rows } = await holder.db.query(`SELECT "commentId" FROM "Thread" WHERE id = 900`);
    expect(rows).toEqual([{ commentId: null }]);
  });
});

describe('a comment on a surface that writes CommentV3', () => {
  // Article comments 81 to 83 (83 a reply under 82), and a model comment 84 whose v1 row is 31.
  // They arrive in the CommentV2 list, which is what the moderator app sends.
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content, "legacyV1Id") VALUES
        (81, 'article', 1, NULL, '81', ${A}, 'zzfixture', NULL),
        (82, 'article', 1, NULL, '82', ${A}, 'zzfixture', NULL),
        (83, 'article', 1, 82, '82.83', ${B}, 'zzfixture', NULL),
        (84, 'model', 7, NULL, '84', ${A}, 'zzfixture', 31);
      INSERT INTO "Comment" (id, "userId", "modelId", content) VALUES (31, ${A}, 7, 'zzfixture');
    `);
  });
  const v3 = async () =>
    (
      await holder.db.query<{ id: number; content: string; deletedAt: unknown }>(
        `SELECT id, content, "deletedAt" FROM "CommentV3" ORDER BY id`
      )
    ).rows;

  it('is deleted there, one with replies left as a placeholder for them', async () => {
    await expect(bulkDeleteCommentsV2({ ids: [81, 82] })).resolves.toEqual({ deleted: 2 });
    const rows = await v3();
    expect(rows.map((r) => r.id)).toEqual([82, 83, 84]);
    expect(rows[0]).toMatchObject({ content: '' });
    expect(rows[0].deletedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ content: 'zzfixture', deletedAt: null });
  });

  it('deletes a model comment by its CommentV3 id, with its v1 row', async () => {
    await expect(bulkDeleteCommentsV2({ ids: [84] })).resolves.toEqual({ deleted: 1 });
    expect((await v3()).map((r) => r.id)).toEqual([81, 82, 83]);
    expect(await state('Comment')).toEqual({});
  });

  it('undoes the CommentV3 delete when the CommentV2 half of the batch fails', async () => {
    hook = {
      on: 'DELETE FROM "CommentV2" c WHERE',
      run: async () => {
        throw new Error('connection reset');
      },
    };

    await expect(bulkDeleteCommentsV2({ ids: [81, 11] })).rejects.toThrow('connection reset');
    expect((await v3()).map((r) => r.id)).toEqual([81, 82, 83, 84]);
    expect(await state('CommentV2')).toMatchObject({ 11: 'public' });
  });
});

const table = 'CommentV2';
const clear = bulkClearCommentV2TosViolation;

describe('restoring CommentV2 from a ToS flag', () => {
  beforeEach(async () => {
    await holder.db.exec(`
      UPDATE "CommentV2" SET "tosViolation" = true;
      INSERT INTO "Report" (id, status, reason) SELECT id, 'Actioned', 'TOSViolation' FROM "CommentV2";
      INSERT INTO "CommentV2Report" ("commentV2Id", "reportId") SELECT id, id FROM "CommentV2";
    `);
  });
  const reports = async () =>
    Object.fromEntries(
      (
        await holder.db.query<{ id: number; status: string }>(`SELECT id, status FROM "Report"`)
      ).rows.map((r) => [r.id, r.status])
    );

  it('puts the comments back and reopens the reports the flag actioned', async () => {
    await expect(clear({ ids: ids(A, B) })).resolves.toEqual({
      count: 4,
      reopenedReports: 4,
      failed: 0,
    });
    expect(await state(table)).toEqual({ 11: 'public', 12: 'public', 21: 'public', 22: 'public' });
    expect(await reports()).toEqual({ 11: 'Pending', 12: 'Pending', 21: 'Pending', 22: 'Pending' });
  });

  it('keeps a comment hidden when its statement fails, reports it failed, and clears the rest', async () => {
    hook = {
      on: 'WITH target AS',
      run: async () => {
        throw new Error('canceling statement due to statement timeout');
      },
    };

    await expect(clear({ ids: ids(A) })).resolves.toEqual({
      count: 1,
      reopenedReports: 1,
      failed: 1,
    });
    expect(await state(table)).toMatchObject({ 11: 'hidden', 12: 'public' });
  });

  it('leaves the comment hidden and its report as it was, reporting it failed, when the reopen fails', async () => {
    await holder.db.exec(
      `ALTER TABLE "Report" ADD CONSTRAINT no_reopen CHECK (status <> 'Pending') NOT VALID`
    );
    try {
      await expect(clear({ ids: [11] })).resolves.toEqual({
        count: 0,
        reopenedReports: 0,
        failed: 1,
      });
      expect(await state(table)).toMatchObject({ 11: 'hidden' });
      expect(await reports()).toMatchObject({ 11: 'Actioned' });
    } finally {
      await holder.db.exec(`ALTER TABLE "Report" DROP CONSTRAINT no_reopen`);
    }
  });

  it('counts a comment that is not flagged, or is missing, as nothing', async () => {
    await holder.db.exec(`UPDATE "${table}" SET "tosViolation" = false WHERE id = 11`);

    await expect(clear({ ids: [11, 999] })).resolves.toEqual({
      count: 0,
      reopenedReports: 0,
      failed: 0,
    });
    expect(await reports()).toMatchObject({ 11: 'Actioned' });
  });
});
