import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, metrics, pointsRemoved } = vi.hoisted(() => ({
  pointsRemoved: vi.fn(async (_comments: { userId: number; threadId: number }[]) => undefined),
  holder: { db: null as unknown as PGlite },
  metrics: {
    model: { queueUpdate: vi.fn<(id: unknown) => Promise<undefined>>() },
    user: { queueUpdate: vi.fn<(id: unknown) => Promise<undefined>>() },
  },
}));

vi.mock('~/server/metrics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  modelMetrics: metrics.model,
  userMetrics: metrics.user,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  onCommentsRemoved: pointsRemoved,
}));

import {
  bulkClearCommentTosViolation,
  bulkDeleteComments,
  deleteCommentById,
} from '~/server/services/comment.service';
import {
  bulkClearCommentV2TosViolation,
  deleteComment,
} from '~/server/services/commentsv2.service';

const A = 1;
const B = 2;
// Comment ids are 10 * author + n; one model per author, id 100 * author, owned by author + 50.
const ids = (...authors: number[]) => authors.flatMap((a) => [a * 10 + 1, a * 10 + 2]);

/** Runs just before the first statement whose text includes `on`. */
let hook: { on: string; run: (sql: Prisma.Sql) => Promise<unknown> } | null = null;

const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

const SCHEMA = `
    CREATE EXTENSION ltree;
    -- A reply goes with its parent, as in production.
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
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Dismissed');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Other');
    CREATE TABLE "Report" (id int PRIMARY KEY, status "ReportStatus" NOT NULL, reason "ReportReason" NOT NULL);
    CREATE TABLE "CommentReport" ("commentId" int NOT NULL, "reportId" int NOT NULL);
    CREATE TABLE "CommentV2Report" ("commentV2Id" int NOT NULL, "reportId" int NOT NULL);
    -- Comments on a surface that writes CommentV3 directly, which have no CommentV2 row.
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      "parentId" int REFERENCES "CommentV3"(id), "replyToId" int, path ltree NOT NULL, "rootId" int GENERATED ALWAYS AS (ltree2text(subpath(path, 0, 1))::int) STORED,
      "userId" int NOT NULL, content text NOT NULL, "tosViolation" boolean NOT NULL DEFAULT false,
      "deletedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now()
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
    TRUNCATE "Comment", "CommentV2", "Thread", "Model", "Report", "CommentReport",
      "CommentV2Report", "CommentV3", "CommentV3Report";
    INSERT INTO "Comment" (id, "userId", "modelId", content) VALUES ${rows()};
    INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES ${rows()};
    INSERT INTO "Model" (id, "userId") VALUES ${authors.map((a) => `(${a * 100}, ${a + 50})`)};
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
  vi.mocked(dbMock.dbWrite.model.findMany).mockImplementation(
    (async (args: { where: { id: { in: number[] } } }) =>
      (
        await holder.db.query(`SELECT "userId" FROM "Model" WHERE id = ANY($1::int[])`, [
          args.where.id.in,
        ])
      ).rows) as never
  );
});

async function state(table: 'Comment' | 'CommentV2' | 'CommentV3') {
  const { rows } = await holder.db.query<{ id: number; tosViolation: boolean }>(
    `SELECT id, "tosViolation" FROM "${table}" ORDER BY id`
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tosViolation ? 'hidden' : 'public']));
}

const TABLES = [
  ['Comment', 'commentDeleted', (i: number[]) => ({ commentIds: i, commentV2Ids: [] })],
  ['CommentV2', 'commentV2Deleted', (i: number[]) => ({ commentIds: [], commentV2Ids: i })],
] as const;

describe.each(TABLES)('bulk delete of %s', (table, deletedKey, input) => {
  const counts = (deleted: number) => ({
    commentDeleted: 0,
    commentV2Deleted: 0,
    [deletedKey]: deleted,
  });

  it('deletes the comments asked for and leaves the rest', async () => {
    await expect(bulkDeleteComments(input([...ids(A), B * 10 + 1]))).resolves.toEqual(counts(3));
    expect(await state(table)).toEqual({ 22: 'public' });
  });

  it('counts only the rows that exist', async () => {
    await expect(bulkDeleteComments(input([11, 999, 21, 998]))).resolves.toEqual(counts(2));
    expect(await state(table)).toEqual({ 12: 'public', 22: 'public' });
  });
});

describe('both tables in one batch', () => {
  it('undoes the legacy delete when the CommentV2 half fails', async () => {
    hook = {
      on: 'DELETE FROM "CommentV2"',
      run: async () => {
        throw new Error('connection reset');
      },
    };

    await expect(bulkDeleteComments({ commentIds: ids(A), commentV2Ids: ids(A) })).rejects.toThrow(
      'connection reset'
    );
    expect(await state('Comment')).toMatchObject({ 11: 'public', 12: 'public' });
    expect(metrics.model.queueUpdate).not.toHaveBeenCalled();
  });

  it('reports a committed delete as done when a follow-up fails', async () => {
    vi.mocked(dbMock.dbWrite.model.findMany).mockRejectedValue(new Error('replica down'));

    await expect(bulkDeleteComments({ commentIds: ids(A), commentV2Ids: ids(B) })).resolves.toEqual(
      { commentDeleted: 2, commentV2Deleted: 2 }
    );
    expect(await state('Comment')).toEqual({ 21: 'public', 22: 'public' });
    expect(await state('CommentV2')).toEqual({ 11: 'public', 12: 'public' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'comment-bulk-delete' })
    );
  });

  it('queues metrics for the models of deleted comments only', async () => {
    await bulkDeleteComments({ commentIds: ids(A), commentV2Ids: [] });

    expect(metrics.model.queueUpdate.mock.calls).toEqual([[A * 100]]);
    expect(metrics.user.queueUpdate.mock.calls).toEqual([[A + 50]]);
  });
});

describe('a comment with replies', () => {
  it('takes a legacy comment’s replies with it', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (41, ${B}, 100, 'zzfixture', 11), (51, ${B}, 100, 'zzfixture', 41);
    `);

    await expect(bulkDeleteComments({ commentIds: [11], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 1,
      commentV2Deleted: 0,
    });
    expect(await state('Comment')).toEqual({ 12: 'public', 21: 'public', 22: 'public' });
  });

  it('leaves a CommentV2’s replies, unlinking their thread from it', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "commentId") VALUES (900, 11);
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (72, ${B}, 900, 'zzfixture');
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 1,
    });
    expect(await state('CommentV2')).not.toHaveProperty('11');
    expect(await state('CommentV2')).toMatchObject({ 72: 'public' });
    const { rows } = await holder.db.query(`SELECT "commentId" FROM "Thread" WHERE id = 900`);
    expect(rows).toEqual([{ commentId: null }]);
  });
});

describe('a comment that exists only in CommentV3', () => {
  // Article comments: 83 is a reply under 82. They arrive in the CommentV2 list, which is what the
  // moderator app sends.
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content) VALUES
        (81, 'article', 1, NULL, '81', ${A}, 'zzfixture'),
        (82, 'article', 1, NULL, '82', ${A}, 'zzfixture'),
        (83, 'article', 1, 82, '82.83', ${B}, 'zzfixture');
    `);
  });

  it('is deleted there, one with replies left as a placeholder for them', async () => {
    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [81, 82] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 2,
    });
    const { rows } = await holder.db.query<{ id: number; content: string; deletedAt: unknown }>(
      `SELECT id, content, "deletedAt" FROM "CommentV3" ORDER BY id`
    );
    expect(rows.map((r) => r.id)).toEqual([82, 83]);
    expect(rows[0]).toMatchObject({ content: '' });
    expect(rows[0].deletedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ content: 'zzfixture', deletedAt: null });
  });
});

describe('a member deleting their own legacy comment', () => {
  beforeEach(() => {
    vi.mocked(dbMock.dbWrite.comment.findUnique).mockResolvedValue({
      modelId: 100,
      model: { userId: A + 50 },
    } as never);
  });

  it('deletes it with its replies, and queues the model’s metrics', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (41, ${B}, 100, 'zzfixture', 11);
    `);

    await expect(deleteCommentById({ id: 11 })).resolves.toEqual({ id: 11 });
    expect(await state('Comment')).toEqual({ 12: 'public', 21: 'public', 22: 'public' });
    expect(metrics.model.queueUpdate).toHaveBeenCalledWith(100);
  });

  it('is not found when it does not exist', async () => {
    await expect(deleteCommentById({ id: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a member deleting their own CommentV2', () => {
  beforeEach(() => {
    vi.mocked(dbMock.dbWrite.commentV2.findUnique).mockImplementation(
      (async (args: { where: { id: number } }) =>
        (await holder.db.query(`SELECT * FROM "CommentV2" WHERE id = $1`, [args.where.id]))
          .rows[0]) as never
    );
  });

  it('deletes it and takes its points back', async () => {
    await expect(deleteComment({ id: 21 })).resolves.toMatchObject({ id: 21, userId: B });
    expect(await state('CommentV2')).not.toHaveProperty('21');
    expect(pointsRemoved).toHaveBeenCalledTimes(1);
    expect(pointsRemoved).toHaveBeenCalledWith([
      expect.objectContaining({ userId: B, threadId: B * 100 }),
    ]);
  });

  it('is not found when it does not exist', async () => {
    await expect(deleteComment({ id: 999 })).resolves.toBeNull();
    expect(pointsRemoved).not.toHaveBeenCalled();
  });
});

const CLEARS = [
  ['Comment', bulkClearCommentTosViolation, 'CommentReport', 'commentId'],
  ['CommentV2', bulkClearCommentV2TosViolation, 'CommentV2Report', 'commentV2Id'],
] as const;

describe.each(CLEARS)('restoring %s from a ToS flag', (table, clear, reportTable, reportKey) => {
  beforeEach(async () => {
    await holder.db.exec(`
      UPDATE "${table}" SET "tosViolation" = true;
      INSERT INTO "Report" (id, status, reason) SELECT id, 'Actioned', 'TOSViolation' FROM "${table}";
      INSERT INTO "${reportTable}" ("${reportKey}", "reportId") SELECT id, id FROM "${table}";
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
