import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

// ToS removal and restore for comments on a surface that writes CommentV3, against real Postgres
// with the production triggers: which reports they action and reopen, who is paid and told, and
// that a comment written before the flip has its CommentV2 row kept in step.

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { reward, notify } = vi.hoisted(() => ({
  reward: vi.fn(async (_: unknown, __?: unknown) => undefined),
  notify: vi.fn(async (_: unknown) => undefined),
}));
vi.mock('~/server/rewards', () => ({ reportAcceptedReward: { apply: reward } }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: notify }));

const { bulkClearCommentV3TosViolation, bulkSetCommentV3TosViolation, setUserCommentsV3Tos } =
  await import('~/server/services/commentv3/moderation.service');
const { bulkSetCommentV2TosViolation } = await import('~/server/services/commentsv2.service');

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

// Article 1: 41 is CommentV3-only; 42 was written to CommentV2 before the flip (mirrored). Reports:
// 1 a pending ToS report on 41, 2 a pending spam report on 41, 3 a pending NSFW report on 41, 4 a pending ToS report on 42 filed through CommentV2Report (mirrored to CommentV3Report),
// 5 a ToS report on 41 a moderator already actioned, 6 an actioned spam report on 41.
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`
    DELETE FROM "CommentV3Report"; DELETE FROM "CommentV2Report"; DELETE FROM "CommentV2";
    DELETE FROM "CommentV3"; DELETE FROM "Thread"; DELETE FROM "CommentTopic";
    UPDATE "Report" SET "userId" = NULL, reason = NULL, status = NULL;
    INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 1);
    INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content) VALUES (41, 'article', 1, 5, 'v3 only');
    INSERT INTO "Thread"(id, "articleId") VALUES (900, 1);
    INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (42, 'from v2', 6, 900);
    UPDATE "Report" SET "userId" = 7, reason = 'TOSViolation', status = 'Pending' WHERE id IN (1, 4);
    UPDATE "Report" SET "userId" = 8, reason = 'Spam', status = 'Pending' WHERE id = 2;
    UPDATE "Report" SET "userId" = 9, reason = 'NSFW', status = 'Pending' WHERE id = 3;
    UPDATE "Report" SET "userId" = 10, reason = 'TOSViolation', status = 'Actioned' WHERE id = 5;
    UPDATE "Report" SET "userId" = 11, reason = 'Spam', status = 'Actioned' WHERE id = 6;
    INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (1, 41), (2, 41), (3, 41), (5, 41), (6, 41);
    INSERT INTO "CommentV2Report"("reportId", "commentV2Id") VALUES (4, 42);
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
    // The comment from before the flip has its CommentV2 row flagged too, so the old reads drop it.
    expect(await rows(`SELECT "tosViolation" FROM "CommentV2" WHERE id = 42`)).toEqual([
      { tosViolation: true },
    ]);
  });

  it('counts comments it flagged, not ids it was given', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    vi.clearAllMocks();
    expect(await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } })).toEqual({
      count: 0,
      notified: 0,
      rewardedReports: 0,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('restores them and reopens their actioned ToS reports, and no other', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 2,
      reopenedReports: 3,
    });
    expect(await tos()).toMatchObject({ 41: false, 42: false });
    // Including report 4, filed through the old table and linked by the mirror.
    expect(await status()).toEqual({ 1: 'Pending', 2: 'Pending', 3: 'Pending', 4: 'Pending' });
    // Every actioned ToS report on them reopens (5 too); one for another reason stays actioned.
    expect(await statusOf(5, 6)).toEqual({ 5: 'Pending', 6: 'Actioned' });
  });

  it('sets and clears the flag in a transaction, so the row lock covers the CommentV2 sync', async () => {
    for (const run of [
      () => bulkSetCommentV3TosViolation({ ids: [42], actor: { id: 1 } }),
      () => bulkClearCommentV3TosViolation({ ids: [42] }),
    ]) {
      const tx = {
        $queryRawUnsafe: vi.fn(
          async (sql: string, ...params: unknown[]) => (await pg.query(sql, params)).rows
        ),
      };
      dbMock.dbWrite.$transaction.mockImplementationOnce(async (cb: (t: unknown) => unknown) =>
        cb(tx)
      );
      dbMock.dbWrite.$queryRawUnsafe.mockClear();
      await run();
      const onTx = tx.$queryRawUnsafe.mock.calls.map(([sql]) => String(sql));
      expect(onTx.some((sql) => sql.includes('UPDATE "CommentV3"'))).toBe(true);
      expect(onTx.some((sql) => sql.includes('UPDATE "CommentV2"'))).toBe(true);
      expect(dbMock.dbWrite.$queryRawUnsafe).not.toHaveBeenCalled();
    }
  });

  it('is what the CommentV2 removal does with an id on a surface that writes CommentV3', async () => {
    const result = await bulkSetCommentV2TosViolation({ ids: [41], actor: { id: 1 } });
    expect(result).toMatchObject({ count: 1, rewardedReports: 1 });
    expect(await tos()).toMatchObject({ 41: true });
  });

  describe('a ban', () => {
    it('removes the user’s live comments on a CommentV3 surface, and nothing else', async () => {
      await pg.exec(`
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('image', 10);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "deletedAt") VALUES
        (43, 'article', 1, 5, 'live', NULL), (44, 'article', 1, 5, '', now()), (45, 'image', 10, 5, 'image', NULL),
        (46, 'article', 1, 6, 'someone else', NULL);
    `);
      await setUserCommentsV3Tos(5);
      expect(await tos()).toMatchObject({ 41: true, 43: true, 44: false, 45: false, 46: false });
    });
  });
});
