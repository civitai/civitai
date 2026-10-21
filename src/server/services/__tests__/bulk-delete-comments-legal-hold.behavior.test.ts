import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A moderator's bulk comment delete keeps a held author's comments, hidden, and deletes the rest.
 * The hold query and the statements run as SQL against a Postgres stand-in; the two services are
 * the real code.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, metrics, notify, reward } = vi.hoisted(() => ({
  holder: { db: null as unknown as { query: PGlite['query'] } },
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
import { bulkDeleteCommentsV2 } from '~/server/services/commentsv2.service';
import { isLegalHoldAbort } from '~/server/services/legal-hold.service';

const CLEAN = 1;
const HELD = 2; // named on a pending report
const MARKED = 3; // held by the marker view
// Comment ids are 10 * author + n; one model per author, id 100 * author.
const ids = (...authors: number[]) => authors.flatMap((a) => [a * 10 + 1, a * 10 + 2]);

/** Runs just before the guarded DELETE: a hold change between the read and the statement. */
let beforeDelete: (() => Promise<unknown>) | null = null;

const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  const db = new PGlite();
  holder.db = db;
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Comment" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelId" int NOT NULL, content text NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL, content text NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  beforeDelete = null;
  const authors = [CLEAN, HELD, MARKED];
  const rows = () =>
    authors
      .flatMap((a) => [1, 2].map((n) => `(${a * 10 + n}, ${a}, ${a * 100}, 'zzfixture')`))
      .join(', ');
  await holder.db.query(`DROP VIEW IF EXISTS "EvidenceHeldUser"`);
  await holder.db.query(`DROP TABLE IF EXISTS "EvidenceHold"`);
  await (holder.db as PGlite).exec(`
    TRUNCATE "CsamReport", "Image", "Comment", "CommentV2", "Model";
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "Comment" (id, "userId", "modelId", content) VALUES ${rows()};
    INSERT INTO "CommentV2" (id, "userId", "threadId", content) VALUES ${rows()};
    INSERT INTO "Model" (id, "userId") VALUES ${authors.map((a) => `(${a * 100}, ${a + 50})`)};
  `);

  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    if (beforeDelete && sql.text.includes('DELETE FROM')) {
      await beforeDelete();
      beforeDelete = null;
    }
    return (await holder.db.query(sql.text, sql.values)).rows;
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

async function createMarker(withView = true) {
  await (holder.db as PGlite).exec(`
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

const retainedLogs = () =>
  vi
    .mocked(loggingMock.logToAxiom)
    .mock.calls.map(([entry]) => (entry as { details?: { userId?: number } }).details?.userId)
    .filter((id) => id !== undefined);

describe.each([
  ['Comment', bulkDeleteComments],
  ['CommentV2', bulkDeleteCommentsV2],
] as const)('bulk delete of %s', (table, bulkDelete) => {
  it('deletes the unheld authors’ comments and keeps the held ones, hidden', async () => {
    await createMarker();

    // One of HELD's comments is not in the batch, and must not be touched.
    await expect(bulkDelete({ ids: [...ids(CLEAN, MARKED), HELD * 10 + 1] })).resolves.toEqual({
      count: 2,
      retainedHidden: 3,
    });

    expect(await state(table)).toEqual({
      21: 'hidden',
      22: 'public',
      31: 'hidden',
      32: 'hidden',
    });
    expect(retainedLogs().sort()).toEqual([HELD, MARKED]);
    expect(notify).not.toHaveBeenCalled();
    expect(reward).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('deletes everything when no author is held, and hides nothing', async () => {
    await expect(bulkDelete({ ids: ids(CLEAN, MARKED) })).resolves.toEqual({
      count: 4,
      retainedHidden: 0,
    });
    expect(await state(table)).toEqual({ 21: 'public', 22: 'public' });
    expect(retainedLogs()).toEqual([]);
  });

  it('keeps every comment while the marker table stands without its view', async () => {
    await createMarker(false);

    await expect(bulkDelete({ ids: ids(CLEAN) })).resolves.toEqual({
      count: 0,
      retainedHidden: 2,
    });
    expect(await state(table)).toMatchObject({ 11: 'hidden', 12: 'hidden' });
  });

  it('keeps a comment whose author was held after the read', async () => {
    beforeDelete = () => createMarker();

    await expect(bulkDelete({ ids: ids(CLEAN, MARKED) })).resolves.toEqual({
      count: 0,
      retainedHidden: 4,
    });
    expect(await state(table)).toMatchObject({
      11: 'hidden',
      12: 'hidden',
      31: 'hidden',
      32: 'hidden',
    });
  });

  it('fails as a hold abort, deleting nothing, when the view goes after the read', async () => {
    await createMarker();
    beforeDelete = () => holder.db.query(`DROP VIEW "EvidenceHeldUser"`);

    const error = await bulkDelete({ ids: ids(CLEAN) }).catch((e: unknown) => e);
    expect(isLegalHoldAbort(error)).toBe(true);
    expect(await state(table)).toMatchObject({ 11: 'public', 12: 'public' });
  });
});

it('queues metrics for the models of deleted comments only', async () => {
  await bulkDeleteComments({ ids: ids(CLEAN, HELD) });

  expect(metrics.model.queueUpdate.mock.calls).toEqual([[CLEAN * 100]]);
  expect(metrics.user.queueUpdate.mock.calls).toEqual([[CLEAN + 50]]);
});
