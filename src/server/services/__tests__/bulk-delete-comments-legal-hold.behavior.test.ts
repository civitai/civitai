import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A moderator's bulk comment delete keeps a held author's comments, hidden, and deletes the rest.
 * The hold query and the statements run as SQL against a Postgres stand-in, inside a real
 * transaction; the services are the real code.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, metrics, notify, reward } = vi.hoisted(() => ({
  holder: { db: null as unknown as PGlite },
  metrics: {
    model: { queueUpdate: vi.fn<(id: unknown) => Promise<undefined>>() },
    user: { queueUpdate: vi.fn<(id: unknown) => Promise<undefined>>() },
  },
  notify: vi.fn(async () => undefined),
  reward: vi.fn(async () => undefined),
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
// The remove-as-ToS path notifies the author and pays reporters; keeping a comment must do neither.
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createNotification: notify,
}));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  reportAcceptedReward: { apply: reward },
}));

import { bulkDeleteComments } from '~/server/services/comment.service';
import { isLegalHoldAbort } from '~/server/services/legal-hold.service';

const CLEAN = 1;
const HELD = 2; // named on a pending report
const MARKED = 3; // held by the marker view
// Comment ids are 10 * author + n; one model per author, id 100 * author.
const ids = (...authors: number[]) => authors.flatMap((a) => [a * 10 + 1, a * 10 + 2]);

/** Runs just before the first statement whose text includes `on`. */
let hook: { on: string; run: (sql: Prisma.Sql) => Promise<unknown> } | null = null;

const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text
    );
    -- A reply goes with its parent, as in production.
    CREATE TABLE "Comment" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelId" int NOT NULL, content text NOT NULL,
      "parentId" int REFERENCES "Comment"(id) ON DELETE CASCADE,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL, content text NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    -- A comment's reply thread; deleting the comment only unlinks it, as in production.
    CREATE TABLE "Thread" (
      id int PRIMARY KEY, "commentId" int UNIQUE REFERENCES "CommentV2"(id) ON DELETE SET NULL
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  hook = null;
  const authors = [CLEAN, HELD, MARKED];
  const rows = () =>
    authors
      .flatMap((a) => [1, 2].map((n) => `(${a * 10 + n}, ${a}, ${a * 100}, 'zzfixture')`))
      .join(', ');
  await holder.db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    TRUNCATE "CsamReport", "Image", "Comment", "CommentV2", "Thread", "Model";
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
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
  // inside it. In production it would not: any write on the shared client while one is open fails.
  let inTransaction = false;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    if (inTransaction) throw new Error('a statement went outside the transaction');
    return queryRaw(first, ...values);
  }) as never);
  // A real transaction on the stand-in, so a failure part-way is undone as it would be in production.
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    await holder.db.query('BEGIN');
    inTransaction = true;
    try {
      const result = await fn({ $queryRaw: queryRaw });
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
  // The ORM writes the remove-as-ToS service makes. Nothing here should reach them; if something
  // does, they answer like the real rows so its notification and rewards run and are seen.
  vi.mocked(dbMock.dbWrite.comment.update).mockImplementation((async (args: {
    where: { id: number };
  }) => ({ id: args.where.id, modelId: 100, user: { id: 1 }, model: { name: '' } })) as never);
  vi.mocked(dbMock.dbWrite.commentV2.update).mockImplementation((async (args: {
    where: { id: number };
  }) => ({ id: args.where.id, userId: 1 })) as never);
});

async function createMarker(withView = true) {
  await holder.db.exec(`
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    INSERT INTO "EvidenceHold" VALUES (${MARKED}, NULL);
    ${
      withView
        ? `CREATE VIEW "EvidenceHeldUser" AS
             SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";`
        : ''
    }
  `);
}

/** Each remaining comment id in `table`, with whether it is flagged off the page. */
async function state(table: 'Comment' | 'CommentV2') {
  const { rows } = await holder.db.query<{ id: number; tosViolation: boolean }>(
    `SELECT id, "tosViolation" FROM "${table}" ORDER BY id`
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tosViolation ? 'hidden' : 'public']));
}

/**
 * The most times one statement ran a per-account hold check that cannot be hashed (the
 * blocked-image leg, aliased `bi`) when the first DELETE on `table` ran. The EXPLAIN is rolled
 * back, so the delete itself still runs after it.
 */
async function mostHoldChecksPerStatement(table: 'Comment' | 'CommentV2', commentIds: number[]) {
  let loops = -1;
  hook = {
    on: `DELETE FROM "${table}"`,
    run: async (sql) => {
      await holder.db.query('SAVEPOINT explain');
      const { rows } = await holder.db.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${sql.text}`,
        sql.values
      );
      await holder.db.query('ROLLBACK TO SAVEPOINT explain');
      loops = maxLoops(rows[0]['QUERY PLAN'][0].Plan, /^bi(_\d+)?$/);
    },
  };
  await bulkDeleteComments(
    table === 'Comment'
      ? { commentIds, commentV2Ids: [] }
      : { commentIds: [], commentV2Ids: commentIds }
  );
  return loops;
}

type PlanNode = { Alias?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };
const maxLoops = (node: PlanNode, alias: RegExp): number =>
  Math.max(
    node.Alias && alias.test(node.Alias) ? node['Actual Loops'] ?? 0 : 0,
    ...(node.Plans ?? []).map((child) => maxLoops(child, alias))
  );

const retainedLogs = () =>
  vi
    .mocked(loggingMock.logToAxiom)
    .mock.calls.map(([entry]) => (entry as { details?: { userId?: number } }).details?.userId)
    .filter((id) => id !== undefined);

const TABLES = [
  ['Comment', 'commentDeleted', (i: number[]) => ({ commentIds: i, commentV2Ids: [] })],
  ['CommentV2', 'commentV2Deleted', (i: number[]) => ({ commentIds: [], commentV2Ids: i })],
] as const;

describe.each(TABLES)('bulk delete of %s', (table, deletedKey, input) => {
  const counts = (deleted: number, retainedHidden: number) => ({
    commentDeleted: 0,
    commentV2Deleted: 0,
    [deletedKey]: deleted,
    retainedHidden,
  });

  it('deletes the unheld authors’ comments and keeps the held ones, hidden', async () => {
    await createMarker();

    // One of HELD's comments is not in the batch, and must not be touched.
    await expect(
      bulkDeleteComments(input([...ids(CLEAN, MARKED), HELD * 10 + 1]))
    ).resolves.toEqual(counts(2, 3));

    expect(await state(table)).toEqual({
      21: 'hidden',
      22: 'public',
      31: 'hidden',
      32: 'hidden',
    });
    expect(retainedLogs().sort()).toEqual([HELD, MARKED]);
  });

  it('neither notifies the held author nor rewards reporters, and writes nothing else', async () => {
    await bulkDeleteComments(input(ids(CLEAN, HELD)));

    expect(notify).not.toHaveBeenCalled();
    expect(reward).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(await state(table)).toMatchObject({ 21: 'hidden', 22: 'hidden' });
  });

  it('counts only the rows that exist', async () => {
    await expect(bulkDeleteComments(input([11, 999, 21, 998]))).resolves.toEqual(counts(1, 1));
    expect(await state(table)).toMatchObject({ 12: 'public', 21: 'hidden' });
  });

  it('deletes everything when no author is held, and hides nothing', async () => {
    await expect(bulkDeleteComments(input(ids(CLEAN, MARKED)))).resolves.toEqual(counts(4, 0));
    expect(await state(table)).toEqual({ 21: 'public', 22: 'public' });
    expect(retainedLogs()).toEqual([]);
  });

  it('keeps every comment while the marker table stands without its view', async () => {
    await createMarker(false);

    await expect(bulkDeleteComments(input(ids(CLEAN)))).resolves.toEqual(counts(0, 2));
    expect(await state(table)).toMatchObject({ 11: 'hidden', 12: 'hidden' });
  });

  it('keeps a comment whose author was held after the read', async () => {
    hook = { on: 'DELETE FROM', run: () => createMarker() };

    await expect(bulkDeleteComments(input(ids(CLEAN, MARKED)))).resolves.toEqual(counts(0, 4));
    expect(await state(table)).toMatchObject({
      11: 'hidden',
      12: 'hidden',
      31: 'hidden',
      32: 'hidden',
    });
  });

  it('fails as a hold abort, deleting nothing, when the view goes after the read', async () => {
    await createMarker();
    hook = { on: 'DELETE FROM', run: () => holder.db.query(`DROP VIEW "EvidenceHeldUser"`) };

    const error = await bulkDeleteComments(input(ids(CLEAN))).catch((e: unknown) => e);
    expect(isLegalHoldAbort(error)).toBe(true);
    expect(await state(table)).toMatchObject({ 11: 'public', 12: 'public' });
  });
});

describe('a legacy comment with replies', () => {
  // HELD's reply 41 sits under CLEAN's comment 11.
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (41, ${HELD}, 100, 'zzfixture', 11);
    `);
  });

  it('is kept, hidden, while a held author replied under it', async () => {
    await expect(bulkDeleteComments({ commentIds: [11, 12], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 1,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
    // The reply was not asked for, so it is left exactly as it was.
    expect(await state('Comment')).toMatchObject({ 11: 'hidden', 41: 'public' });
    expect(await state('Comment')).not.toHaveProperty('12');
  });

  it('is kept when the held reply is in the batch too', async () => {
    await expect(bulkDeleteComments({ commentIds: [11, 41], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 2,
    });
    expect(await state('Comment')).toMatchObject({ 11: 'hidden', 41: 'hidden' });
  });

  it('is kept while a held reply sits two levels down', async () => {
    await holder.db.exec(`
      DELETE FROM "Comment" WHERE id = 41;
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (51, ${CLEAN}, 100, 'zzfixture', 11),
        (61, ${HELD}, 100, 'zzfixture', 51);
    `);

    await expect(bulkDeleteComments({ commentIds: [11], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
    expect(await state('Comment')).toMatchObject({ 11: 'hidden', 51: 'public', 61: 'public' });
  });

  it('is kept while a reply below is held only by the marker', async () => {
    await createMarker();
    await holder.db.exec(`
      DELETE FROM "Comment" WHERE id = 41;
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (42, ${MARKED}, 100, 'zzfixture', 11);
    `);

    await expect(bulkDeleteComments({ commentIds: [11], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
    expect(await state('Comment')).toMatchObject({ 11: 'hidden', 42: 'public' });
  });

  it('goes, with its replies, when no reply under it is held', async () => {
    await holder.db.exec(`
      DELETE FROM "Comment" WHERE id = 41;
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId") VALUES
        (51, ${CLEAN}, 100, 'zzfixture', 11);
    `);

    await expect(bulkDeleteComments({ commentIds: [11], commentV2Ids: [] })).resolves.toEqual({
      commentDeleted: 1,
      commentV2Deleted: 0,
      retainedHidden: 0,
    });
    expect(await state('Comment')).not.toHaveProperty('51');
  });

  it('checks each author below it once, however many replies they wrote', async () => {
    await holder.db.exec(`
      DELETE FROM "Comment" WHERE id = 41;
      INSERT INTO "Comment" (id, "userId", "modelId", content, "parentId")
        SELECT 1000 + g, 4 + g % 3, 100, 'zzfixture', CASE WHEN g = 0 THEN 11 ELSE 1000 + (g - 1) / 3 END
        FROM generate_series(0, 29) g;
    `);
    expect(await mostHoldChecksPerStatement('Comment', [11])).toBe(3);
  });
});

describe('a CommentV2 with replies', () => {
  // Comment 11's reply thread is 900. A reply in it, or in the reply thread of one of its comments,
  // is below 11.
  beforeEach(async () => {
    await holder.db.exec(`INSERT INTO "Thread" (id, "commentId") VALUES (900, 11);`);
  });

  it('is kept, hidden, while a held author replied in its thread', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (71, ${HELD}, 900, 'zzfixture');
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11, 12] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 1,
      retainedHidden: 1,
    });
    expect(await state('CommentV2')).toMatchObject({ 11: 'hidden', 71: 'public' });
    expect(await state('CommentV2')).not.toHaveProperty('12');
  });

  it('is kept while a held reply sits in the thread of a reply', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES
        (72, ${CLEAN}, 900, 'zzfixture'), (73, ${HELD}, 901, 'zzfixture');
      INSERT INTO "Thread" (id, "commentId") VALUES (901, 72);
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
    expect(await state('CommentV2')).toMatchObject({ 11: 'hidden', 72: 'public', 73: 'public' });
  });

  it('is kept while a reply below is held only by the marker', async () => {
    await createMarker();
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (74, ${MARKED}, 900, 'zzfixture');
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
  });

  it('goes when no reply below it is held, leaving its replies', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (72, ${CLEAN}, 900, 'zzfixture');
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 1,
      retainedHidden: 0,
    });
    expect(await state('CommentV2')).toMatchObject({ 72: 'public' });
    expect(await state('CommentV2')).not.toHaveProperty('11');
  });

  it('checks each author below it once, however many replies they wrote', async () => {
    // 30 replies by three authors, each in the reply thread of the one before.
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content)
        SELECT 1000 + g, 4 + g % 3, CASE WHEN g = 0 THEN 900 ELSE 2000 + g - 1 END, 'zzfixture'
        FROM generate_series(0, 29) g;
      INSERT INTO "Thread" (id, "commentId") SELECT 2000 + g, 1000 + g FROM generate_series(0, 29) g;
    `);
    expect(await mostHoldChecksPerStatement('CommentV2', [11])).toBe(3);
  });

  it('ends on a reply chain that loops back on itself, and still keeps it for a held reply', async () => {
    // 11 sits in thread 100, so thread 100 hanging off reply 72 closes a loop: 11 → 900 → 72 → 100.
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES
        (72, ${CLEAN}, 900, 'zzfixture'), (76, ${HELD}, 100, 'zzfixture');
      INSERT INTO "Thread" (id, "commentId") VALUES (100, 72);
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 0,
      retainedHidden: 1,
    });
  });

  it('goes when the held reply is in a thread already unlinked from it', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "commentId") VALUES (902, NULL);
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES (77, ${HELD}, 902, 'zzfixture');
    `);

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).resolves.toEqual({
      commentDeleted: 0,
      commentV2Deleted: 1,
      retainedHidden: 0,
    });
  });
});

describe('both tables in one batch', () => {
  it('undoes the legacy delete when the CommentV2 half fails', async () => {
    await createMarker();
    hook = {
      on: 'DELETE FROM "CommentV2"',
      run: () => holder.db.query(`DROP VIEW "EvidenceHeldUser"`),
    };

    const error = await bulkDeleteComments({
      commentIds: ids(CLEAN),
      commentV2Ids: ids(CLEAN),
    }).catch((e: unknown) => e);
    expect(isLegalHoldAbort(error)).toBe(true);
    expect(await state('Comment')).toMatchObject({ 11: 'public', 12: 'public' });
    expect(metrics.model.queueUpdate).not.toHaveBeenCalled();
  });

  it('undoes the delete when hiding the kept rows fails', async () => {
    hook = {
      on: 'UPDATE "Comment"',
      run: async () => {
        throw new Error('connection reset');
      },
    };

    await expect(
      bulkDeleteComments({ commentIds: ids(CLEAN, HELD), commentV2Ids: [] })
    ).rejects.toThrow('connection reset');
    expect(await state('Comment')).toMatchObject({
      11: 'public',
      12: 'public',
      21: 'public',
      22: 'public',
    });
  });

  it('reports a committed delete as done when a follow-up fails', async () => {
    vi.mocked(dbMock.dbWrite.model.findMany).mockRejectedValue(new Error('replica down'));

    await expect(
      bulkDeleteComments({ commentIds: ids(CLEAN), commentV2Ids: ids(HELD) })
    ).resolves.toEqual({ commentDeleted: 2, commentV2Deleted: 0, retainedHidden: 2 });
    // The CommentV2 follow-up still ran.
    expect(retainedLogs()).toEqual([HELD]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'comment-bulk-delete' })
    );
  });

  it('queues metrics for the models of deleted comments only', async () => {
    await bulkDeleteComments({ commentIds: ids(CLEAN, HELD), commentV2Ids: [] });

    expect(metrics.model.queueUpdate.mock.calls).toEqual([[CLEAN * 100]]);
    expect(metrics.user.queueUpdate.mock.calls).toEqual([[CLEAN + 50]]);
  });
});
