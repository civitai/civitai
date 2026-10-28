import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
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
import { isLegalHoldAbort, logHoldRetained } from '~/server/services/legal-hold.service';

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

const SCHEMA = `
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
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(SCHEMA);
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

/**
 * Runs `sql` on a copy of the stand-in in a worker, so a statement that never ends fails the test
 * rather than hanging it: PGlite ignores statement_timeout, and blocks the thread it runs on.
 */
async function runBounded(sql: Prisma.Sql, ms: number) {
  const seed = [SCHEMA];
  for (const table of ['CsamReport', 'Image', 'CommentV2', 'Thread', 'Comment', 'Model']) {
    const { rows } = await holder.db.query(`SELECT * FROM "${table}"`);
    if (rows.length)
      seed.push(
        `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", '${JSON.stringify(
          rows
        ).replace(/'/g, "''")}')`
      );
  }
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { PGlite } = await import(workerData.pglite);
      const db = new PGlite();
      await db.exec(workerData.seed);
      const { rows } = await db.query(workerData.text, workerData.values);
      parentPort.postMessage({ deleted: rows.length });
    })().catch((e) => parentPort.postMessage({ error: e.message }));`,
    {
      eval: true,
      workerData: {
        pglite: pathToFileURL(createRequire(import.meta.url).resolve('@electric-sql/pglite')).href,
        seed: seed.join(';\n'),
        text: sql.text,
        values: sql.values,
      },
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<{ deleted?: number; error?: string }>((resolve) =>
        worker.once('message', resolve)
      ),
      new Promise<{ timedOutAfterMs: number }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOutAfterMs: ms }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

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

  it.each([
    ['keeps it for a held reply in the loop', HELD, 0],
    ['deletes it when no reply in the loop is held', CLEAN, 1],
  ])('ends on a reply chain that loops back on itself, and %s', async (_, author, deleted) => {
    // 11 sits in thread 100, so thread 100 hanging off reply 72 closes a loop: 11 → 900 → 72 → 100.
    await holder.db.exec(`
      INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES
        (72, ${CLEAN}, 900, 'zzfixture'), (76, ${author}, 100, 'zzfixture');
      INSERT INTO "Thread" (id, "commentId") VALUES (100, 72);
    `);
    let outcome: unknown;
    hook = {
      on: 'DELETE FROM "CommentV2"',
      run: async (sql) => {
        outcome = await runBounded(sql, 20_000);
        throw new Error('ran in the worker');
      },
    };

    await expect(bulkDeleteComments({ commentIds: [], commentV2Ids: [11] })).rejects.toThrow(
      'ran in the worker'
    );
    expect(outcome).toEqual({ deleted });
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

describe('logging the authors whose rows were kept', () => {
  const loggedLegs = () =>
    Object.fromEntries(
      vi
        .mocked(loggingMock.logToAxiom)
        .mock.calls.map(
          ([entry]) => (entry as { details?: { userId?: number; legs?: unknown } }).details
        )
        .filter((d) => d?.userId !== undefined)
        .map((d) => [d!.userId, d!.legs])
    );

  it('reads every author’s holds in one statement', async () => {
    await logHoldRetained('test', [CLEAN, HELD, MARKED, CLEAN, HELD, 4, 5, 6]);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(loggedLegs()).toEqual({
      [CLEAN]: [],
      [HELD]: ['report'],
      [MARKED]: [],
      4: [],
      5: [],
      6: [],
    });
  });

  it('adds one statement for the marker, whatever the number of authors', async () => {
    await createMarker();

    await logHoldRetained('test', [CLEAN, HELD, MARKED, 4, 5, 6]);

    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    expect(loggedLegs()).toMatchObject({
      [CLEAN]: [],
      [HELD]: ['report'],
      [MARKED]: ['hold-marker'],
    });
  });

  it('logs at most 200 authors, and counts the rest', async () => {
    await logHoldRetained(
      'test',
      Array.from({ length: 205 }, (_, i) => 1000 + i)
    );

    expect(Object.keys(loggedLegs())).toHaveLength(200);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'test: rows retained for 5 more authors' })
    );
  });

  it('logs every author as held when the marker table stands without its view', async () => {
    await createMarker(false);

    await logHoldRetained('test', [CLEAN, HELD]);

    expect(loggedLegs()).toEqual({ [CLEAN]: ['hold-marker'], [HELD]: ['report', 'hold-marker'] });
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
