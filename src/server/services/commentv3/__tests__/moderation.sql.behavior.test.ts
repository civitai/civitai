import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import {
  TEST_DATABASE_URL,
  holdAt,
  openScratch,
} from '~/server/services/commentv3/__tests__/two-connection-pg';

// ToS removal and restore for comments, against real Postgres with the production triggers: which
// reports they action and reopen, and who is paid and told.

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { reward, notify } = vi.hoisted(() => ({
  reward: vi.fn(async (_: unknown, __?: unknown) => undefined),
  notify: vi.fn(async (_: unknown) => undefined),
}));
vi.mock('~/server/rewards', () => ({ reportAcceptedReward: { apply: reward } }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: notify }));

const { bulkClearCommentV3TosViolation, bulkSetCommentV3TosViolation, setUserCommentsV3Tos } =
  await import('~/server/services/commentv3/moderation.service');

let pg: PGlite;
const rows = async <T>(sql: string) => (await pg.query<T>(sql)).rows;

beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(`
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Spam');
    ALTER TABLE "Report" ADD COLUMN "userId" int, ADD COLUMN reason "ReportReason",
      ADD COLUMN status "ReportStatus", ADD COLUMN "statusSetAt" timestamp(3),
      ADD COLUMN "statusSetBy" int;
  `);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(migration('20261120120000_comment_v3_mirror'));
  await pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
  await pg.exec(migration('20261217120000_comment_v3_removed_by_author'));
  await pg.exec(migration('20270101120000_comment_v3_old_table_triggers_off'));
  await pg.exec(migration('20270102120000_comment_v3_teardown'));
  await pg.exec(migration('20271125130000_comment_v3_hidden_at'));

  const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
    Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const sql = toSql(first, values);
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const sql = toSql(first, values);
    return (await pg.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation(
    (async (sql: string, ...params: unknown[]) => (await pg.query(sql, params)).rows) as never
  );
});
afterAll(async () => {
  await pg.close();
});

// Article 1: comments 41 (by user 5) and 42 (by user 6). Reports: 1 a pending ToS report on 41,
// 2 a pending spam report on 41, 3 a pending NSFW report on 41, 4 a pending ToS report on 42,
// 5 a ToS report on 41 a moderator already actioned, 6 an actioned spam report on 41.
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`
    DELETE FROM "CommentV3Report"; DELETE FROM "CommentV3"; DELETE FROM "CommentTopic";
    UPDATE "Report" SET "userId" = NULL, reason = NULL, status = NULL;
    INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 1);
    INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content) VALUES
      (41, 'article', 1, 5, 'first'), (42, 'article', 1, 6, 'second');
    UPDATE "Report" SET "userId" = 7, reason = 'TOSViolation', status = 'Pending' WHERE id IN (1, 4);
    UPDATE "Report" SET "userId" = 8, reason = 'Spam', status = 'Pending' WHERE id = 2;
    UPDATE "Report" SET "userId" = 9, reason = 'NSFW', status = 'Pending' WHERE id = 3;
    UPDATE "Report" SET "userId" = 10, reason = 'TOSViolation', status = 'Actioned' WHERE id = 5;
    UPDATE "Report" SET "userId" = 11, reason = 'Spam', status = 'Actioned' WHERE id = 6;
    INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (1, 41), (2, 41), (3, 41), (4, 42), (5, 41), (6, 41);
  `);
});

const status = async () =>
  Object.fromEntries(
    (
      await rows<{ id: number; status: string }>(`SELECT id, status FROM "Report" WHERE id <= 4`)
    ).map((r) => [r.id, r.status])
  );
const statusOf = async (...ids: number[]) =>
  Object.fromEntries(
    (
      await rows<{ id: number; status: string }>(
        `SELECT id, status FROM "Report" WHERE id IN (${ids.join(',')})`
      )
    ).map((r) => [r.id, r.status])
  );
const tos = async () =>
  Object.fromEntries(
    (
      await rows<{ id: number; tos: boolean }>(`SELECT id, "tosViolation" AS tos FROM "CommentV3"`)
    ).map((r) => [r.id, r.tos])
  );

describe('removing CommentV3 comments as ToS violations', () => {
  it('actions only their pending ToS reports, pays those reporters, and tells each author', async () => {
    const result = await bulkSetCommentV3TosViolation({ ids: [41, 42, 999], actor: { id: 1 } });

    expect(result).toEqual({ count: 2, notified: 2, rewardedReports: 2 });
    expect(await tos()).toEqual({ 41: true, 42: true });
    // Reports for another reason are left as they were.
    expect(await status()).toEqual({ 1: 'Actioned', 2: 'Pending', 3: 'Pending', 4: 'Actioned' });
    // 5 was actioned already, so its reporter is not paid a second time.
    expect(await statusOf(5, 6)).toEqual({ 5: 'Actioned', 6: 'Actioned' });
    // Each actioned report paid once.
    expect(
      reward.mock.calls
        .map(([event]) => event as { reportId: number })
        .sort((a, b) => a.reportId - b.reportId)
    ).toEqual([
      { userId: 7, reportId: 1 },
      { userId: 7, reportId: 4 },
    ]);
    const told = notify.mock.calls.map(([n]) => n as { userId: number; type: string });
    expect(told.map((n) => n.userId).sort()).toEqual([5, 6]);
    expect(told.every((n) => n.type === 'tos-violation')).toBe(true);
  });

  it('actions an open ToS report, Processing included, and leaves one ruled Unactioned', async () => {
    await pg.exec(`
      DELETE FROM "Report" WHERE id IN (30, 31);
      INSERT INTO "Report" (id, "userId", status, reason) VALUES
        (30, 13, 'Unactioned', 'TOSViolation'), (31, 14, 'Processing', 'TOSViolation');
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (30, 41), (31, 41);
    `);

    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });

    expect(await statusOf(30, 31)).toEqual({ 30: 'Unactioned', 31: 'Actioned' });
    const paid = reward.mock.calls.map(([event]) => (event as { reportId: number }).reportId);
    expect(paid.sort((a, b) => a - b)).toEqual([1, 31]);
  });

  it('counts a comment already hidden, actions its new reports, and does not tell its author again', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    await pg.exec(`UPDATE "Report" SET status = 'Pending' WHERE id = 1`);
    vi.clearAllMocks();
    expect(await bulkSetCommentV3TosViolation({ ids: [41, 999], actor: { id: 1 } })).toEqual({
      count: 1,
      notified: 0,
      rewardedReports: 1,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(await status()).toMatchObject({ 1: 'Actioned' });
  });

  it('actions a report once per removal: a repeat actions nothing, a later removal actions it again', async () => {
    const paid = () =>
      reward.mock.calls.filter(([e]) => (e as { reportId: number }).reportId === 1);
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    expect(paid()).toHaveLength(1);
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    expect(paid()).toHaveLength(1);
    await bulkClearCommentV3TosViolation({ ids: [41] });
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    expect(paid()).toHaveLength(2);
  });

  it('restores them and reopens their actioned ToS reports, and no other', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    // 7: a ToS report on 41 a moderator dismissed after the removal.
    await pg.exec(`
      UPDATE "Report" SET "userId" = 12, reason = 'TOSViolation', status = 'Unactioned' WHERE id = 7;
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (7, 41);
    `);
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 2,
      reopenedReports: 3,
      held: 0,
      failed: 0,
    });
    expect(await tos()).toMatchObject({ 41: false, 42: false });
    expect(await status()).toEqual({ 1: 'Pending', 2: 'Pending', 3: 'Pending', 4: 'Pending' });
    // Every actioned ToS report on them reopens (5 too); one for another reason stays actioned, and
    // a dismissal stays a dismissal.
    expect(await statusOf(5, 6, 7)).toEqual({ 5: 'Pending', 6: 'Actioned', 7: 'Unactioned' });
  });

  it('locks the comments it restores and reopens their reports in the same transaction', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    const viaPg = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    const tx = {
      $queryRawUnsafe: vi.fn(
        async (sql: string, ...params: unknown[]) => (await pg.query(sql, params)).rows
      ),
      $queryRaw: vi.fn(viaPg),
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (cb: (t: unknown) => unknown) =>
      cb(tx)
    );
    dbMock.dbWrite.$queryRaw.mockClear();
    expect(await bulkClearCommentV3TosViolation({ ids: [41] })).toMatchObject({ count: 1 });
    const text = (calls: unknown[][]) =>
      calls.map(([first]) =>
        Array.isArray(first) ? (first as string[]).join('?') : String(first)
      );
    const onTx = text(tx.$queryRaw.mock.calls);
    expect(onTx.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(onTx.some((sql) => sql.includes('UPDATE "Report"'))).toBe(true);
    expect(
      text(dbMock.dbWrite.$queryRaw.mock.calls).some((sql) => sql.includes('UPDATE "Report"'))
    ).toBe(false);
  });

  it('keeps every comment hidden when the restore fails, and counts them failed', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('deadlock detected'));
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 0,
      reopenedReports: 0,
      held: 0,
      failed: 2,
    });
    expect(await tos()).toMatchObject({ 41: true, 42: true });
  });

  describe('a ban', () => {
    it('removes the user’s live comments on every surface, and nothing else', async () => {
      await pg.exec(`
      INSERT INTO "Model3DReview" VALUES (1) ON CONFLICT DO NOTHING;
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model3dReview', 1);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "deletedAt") VALUES
        (43, 'article', 1, 5, 'live', NULL), (44, 'article', 1, 5, '', now()), (45, 'model3dReview', 1, 5, '3D model review', NULL),
        (46, 'article', 1, 6, 'someone else', NULL);
    `);
      await setUserCommentsV3Tos(5);
      expect(await tos()).toEqual({
        41: true,
        42: false,
        43: true,
        44: false,
        45: true,
        46: false,
      });
    });
  });
});

// On separate connections of real Postgres: a lock is invisible to the single-connection PGlite.
describe.skipIf(!TEST_DATABASE_URL)('ToS set and clear on two connections', () => {
  let db: Awaited<ReturnType<typeof openScratch>>;
  beforeAll(async () => {
    db = await openScratch('comment_tos_races');
  }, 60_000);
  afterAll(() => db?.close());
  beforeEach(() => db.reset());

  // However the clear lands, the comment's flag and its report agree afterwards.
  it.each([
    {
      name: 'waits for a removal of an already-flagged comment, then reopens its report',
      tos: true,
      at: /SELECT id, "userId" FROM "CommentV3"/,
      expected: { tosViolation: false, status: 'Pending', clearWaited: true },
    },
    {
      // Uncommitted, the removal is not visible to the clear, which clears nothing.
      name: 'during a new removal’s report actioning leaves the removal standing',
      tos: false,
      at: /UPDATE "Report"/,
      expected: { tosViolation: true, status: 'Actioned', clearWaited: false },
    },
  ])('a clear $name', async ({ tos, at, expected }) => {
    await db.q(`
      INSERT INTO "CommentV3" (id, "userId", "tosViolation") VALUES (2, 10, ${tos});
      INSERT INTO "Report" (id, "userId", status, reason) VALUES (20, 99, 'Pending', 'TOSViolation');
      INSERT INTO "CommentV3Report" VALUES (2, 20);`);
    const held = holdAt(at);
    const set = bulkSetCommentV3TosViolation({ ids: [2], actor: { id: 1 } });
    await held.reachedAt;
    const clear = bulkClearCommentV3TosViolation({ ids: [2] });
    let outcome = 'unknown';
    try {
      outcome = await db.lockWaitOrFinish(clear);
    } finally {
      held.release();
      await Promise.allSettled([set, clear]);
    }
    expect({
      ...(await db.one<{ tosViolation: boolean }>(
        `SELECT "tosViolation" FROM "CommentV3" WHERE id = 2`
      )),
      ...(await db.one<{ status: string }>(`SELECT status FROM "Report" WHERE id = 20`)),
      clearWaited: outcome === 'waiting',
    }).toEqual(expected);
  });
});
