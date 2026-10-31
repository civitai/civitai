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

const {
  bulkClearCommentV3TosViolation,
  bulkSetCommentV3TosViolation,
  deleteCommentsV3UnlessHeld,
  setUserCommentsV3Tos,
} = await import('~/server/services/commentv3/moderation.service');
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
  await pg.exec(migration('20261217120000_comment_v3_removed_by_author'));
  // What the hold legs read; no marker table, so the marker leg holds nobody.
  await pg.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    ALTER TABLE "Image" ADD COLUMN "userId" int, ADD COLUMN "needsReview" text,
      ADD COLUMN "blockedFor" text;
  `);

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
    DELETE FROM "CommentV3"; DELETE FROM "Thread"; DELETE FROM "CommentTopic"; DELETE FROM "CsamReport";
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

  it('restores them and reopens their actioned ToS reports, and no other', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 2,
      reopenedReports: 3,
      retainedHidden: 0,
      failed: 0,
    });
    expect(await tos()).toMatchObject({ 41: false, 42: false });
    // Including report 4, filed through the old table and linked by the mirror.
    expect(await status()).toEqual({ 1: 'Pending', 2: 'Pending', 3: 'Pending', 4: 'Pending' });
    // Every actioned ToS report on them reopens (5 too); one for another reason stays actioned.
    expect(await statusOf(5, 6)).toEqual({ 5: 'Pending', 6: 'Actioned' });
  });

  it('keeps a comment hidden when its author is held, and reopens nothing for it', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    await pg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (5)`);
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 1,
      reopenedReports: 1,
      retainedHidden: 1,
      failed: 0,
    });
    expect(await tos()).toMatchObject({ 41: true, 42: false });
    expect(await status()).toMatchObject({ 1: 'Actioned', 4: 'Pending' });
  });

  it('keeps a comment hidden when a held author replied below it', async () => {
    await pg.exec(`
      INSERT INTO "User" VALUES (12) ON CONFLICT DO NOTHING;
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content)
      VALUES (43, 'article', 1, 41, 12, 'reply');
      INSERT INTO "CsamReport" ("userId") VALUES (12);
    `);
    await bulkSetCommentV3TosViolation({ ids: [41], actor: { id: 1 } });
    expect(await bulkClearCommentV3TosViolation({ ids: [41] })).toMatchObject({
      count: 0,
      retainedHidden: 1,
    });
    expect(await tos()).toMatchObject({ 41: true });
  });

  // Restoring one would republish a comment its author deleted.
  it('leaves hidden a comment its author deleted while a hold kept it, in either table', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    await pg.exec(`
      UPDATE "CommentV3" SET "removedByAuthor" = true WHERE id = 41;
      UPDATE "CommentV2" SET metadata = '{"removedByAuthor": true}' WHERE id = 42;
    `);
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toMatchObject({
      count: 0,
      retainedHidden: 0,
    });
    expect(await tos()).toMatchObject({ 41: true, 42: true });
  });

  it('sets and clears the flag in a transaction, so the row lock covers the CommentV2 sync', async () => {
    for (const run of [
      () => bulkSetCommentV3TosViolation({ ids: [42], actor: { id: 1 } }),
      () => bulkClearCommentV3TosViolation({ ids: [42] }),
    ]) {
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
      dbMock.dbWrite.$queryRawUnsafe.mockClear();
      await run();
      const onTx = tx.$queryRawUnsafe.mock.calls.map(([sql]) => String(sql));
      expect(onTx.some((sql) => sql.includes('UPDATE "CommentV3"'))).toBe(true);
      expect(onTx.some((sql) => sql.includes('UPDATE "CommentV2"'))).toBe(true);
      expect(dbMock.dbWrite.$queryRawUnsafe).not.toHaveBeenCalled();
    }
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

  it('keeps every comment hidden when the hold cannot be read, and counts a failure apart', async () => {
    await bulkSetCommentV3TosViolation({ ids: [41, 42], actor: { id: 1 } });
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(
      new Error('relation "EvidenceHeldUser" does not exist')
    );
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 0,
      reopenedReports: 0,
      retainedHidden: 2,
      failed: 0,
    });
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('deadlock detected'));
    expect(await bulkClearCommentV3TosViolation({ ids: [41, 42] })).toEqual({
      count: 0,
      reopenedReports: 0,
      retainedHidden: 0,
      failed: 2,
    });
    expect(await tos()).toMatchObject({ 41: true, 42: true });
  });

  // Only an author's own removal is marked: a moderator's may still be restored.
  it('marks a held comment kept on its author’s delete, in both tables, and not on a moderator’s', async () => {
    await pg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (6)`);
    await deleteCommentsV3UnlessHeld(dbMock.dbWrite as never, [42], false);
    const marks = async () =>
      rows<{ v3: boolean; v2: string | null }>(`
        SELECT v."removedByAuthor" AS v3, c.metadata ->> 'removedByAuthor' AS v2
        FROM "CommentV3" v JOIN "CommentV2" c ON c.id = v.id WHERE v.id = 42`);
    expect(await marks()).toEqual([{ v3: false, v2: null }]);
    expect(await tos()).toMatchObject({ 42: true });

    await deleteCommentsV3UnlessHeld(dbMock.dbWrite as never, [42], false, { byAuthor: true });
    expect(await marks()).toEqual([{ v3: true, v2: 'true' }]);
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
