import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  copyMutes,
  copyTopics,
  copyV1Comments,
  copyV1Reactions,
  copyV2Comments,
  copyV2Reactions,
  parityReport,
  unmirroredReport,
  rowTotals,
} from '~/server/services/comment-v3-backfill.service';
import {
  reverseComments,
  reverseDeletes,
  reverseDryCount,
  reverseLinks,
  reverseRootThreads,
  reverseTopicMutes,
  reverseUpdates,
} from '~/server/services/comment-v3-reverse-copy.service';
import { FIXTURE, migration } from './comment-v3-fixture';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

// Single session: the mirror's SKIP LOCKED yields are not exercised.

// Old rows carry 2024 timestamps, the flip window is 2025, and the rollback is dated 2026.
const PRE_EXISTING = `
INSERT INTO "Thread"(id, "imageId") VALUES (1, 10);
INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt", "updatedAt") VALUES (1, 'v2 1', 1, 1, '2024-01-01', '2024-01-01'), (3, 'v2 3', 3, 1, '2024-01-01', '2024-01-01'), (4, 'v2 4', 4, 1, '2024-01-01', '2024-01-01');
INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (2, 1, 1, 1);
INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt", "updatedAt") VALUES (2, 'v2 2', 2, 2, '2024-01-01', '2024-01-01');
INSERT INTO "Comment"(id, content, "userId", "modelId", "createdAt", "updatedAt") VALUES (1, 'v1 1', 1, 1, '2024-01-01', '2024-01-01'), (2, 'v1 2', 2, 1, '2024-01-01', '2024-01-01'), (3, 'v1 3', 3, 2, '2024-01-01', '2024-01-01');
INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId", "createdAt", "updatedAt") VALUES (4, 'v1 4 under 2', 4, 1, 2, '2024-01-01', '2024-01-01');
INSERT INTO "Thread"(id, "modelId") VALUES (3, 1);
INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt", "updatedAt") VALUES (5, 'v2 on a model thread', 5, 3, '2024-01-01', '2024-01-01');
INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction, "createdAt") VALUES (2, 3, 'Heart', '2024-01-01');
INSERT INTO "CommentReaction"("commentId", "userId", reaction, "createdAt") VALUES (1, 2, 'Like', '2024-01-01'), (2, 4, 'Cry', '2024-01-01');
INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (4, 4, 1, 1);
INSERT INTO "ThreadMute"("userId", "threadId", "mutedAt") VALUES (8, 1, '2024-01-01'), (8, 4, '2024-01-01');
INSERT INTO "ResourceReview" SELECT generate_series(1, 3);
SELECT setval('"Comment_id_seq"', 4, true);
SELECT setval('"CommentV2_id_seq"', 5, true);
SELECT setval('"Thread_id_seq"', 4, true);
`;

const ALL = { start: 0, end: 100_000 };
const SCOPE = {
  since: new Date('2025-01-01T00:00:00Z'),
  until: new Date('2025-12-31T00:00:00Z'),
  entityTypes: ['image', 'comicChapter', 'review', 'appListing', 'model'],
};

const db = { pg: null as unknown as PGlite };
const rows = async <T = Record<string, unknown>>(sql: string) => (await db.pg.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await rows<T>(sql))[0];
const count = async (sql: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n ${sql}`)).n;
const old = (id: number) =>
  one<{ threadId: number; content: string; hidden: boolean; tosViolation: boolean }>(
    `SELECT "threadId", content, hidden, "tosViolation" FROM "CommentV2" WHERE id = ${id}`
  );
const thread = (where: string) =>
  one<{
    id: number;
    commentId: number | null;
    parentThreadId: number | null;
    rootThreadId: number | null;
    locked: boolean;
    commentCount: number;
  }>(
    `SELECT id, "commentId", "parentThreadId", "rootThreadId", locked, "commentCount" FROM "Thread" WHERE ${where}`
  );
const zeros = (report: Record<string, { count: number }>, except: string[] = []) =>
  Object.fromEntries(
    Object.entries(report)
      .filter(([k, v]) => !except.includes(k) && v.count !== 0)
      .map(([k, v]) => [k, v])
  );
const legacy = async (v1: number) =>
  (await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = ${v1}`)).id;
const noReverseWork = async () => {
  expect(await reverseRootThreads(db.pg, ALL, SCOPE)).toEqual({ created: 0, relocked: 0 });
  expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 0, threads: 0, copied: 0 });
  expect(await reverseUpdates(db.pg, ALL)).toEqual({ v2: 0, v1: 0, locks: 0 });
  expect(await reverseDeletes(db.pg, ALL, SCOPE)).toEqual({ v2: 0, v1: 0, blanked: 0 });
  expect(await reverseLinks(db.pg, ALL, SCOPE)).toEqual({
    reactionsAdded: 0,
    reactionsRemoved: 0,
    reports: 0,
    mutesAdded: 0,
    mutesRemoved: 0,
  });
  expect(await reverseTopicMutes(db.pg, ALL, SCOPE)).toEqual({ added: 0, removed: 0 });
  for (const step of [
    'reverseComments',
    'reverseUpdates',
    'reverseDeletes',
    'reverseLinks',
  ] as const) {
    expect(await reverseDryCount(db.pg, step, ALL, SCOPE), step).toBe(0);
  }
};

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(`SET TIME ZONE 'Etc/GMT-5'`);
  await db.pg.exec(FIXTURE);
  await db.pg.exec(PRE_EXISTING);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  await copyTopics(db.pg, ALL);
  await copyV2Comments(db.pg, ALL);
  await copyV1Comments(db.pg, ALL);
  await copyV2Reactions(db.pg, ALL);
  await copyV1Reactions(db.pg, ALL);
  await copyMutes(db.pg);
  await db.pg.exec(`SELECT setval('comment_shared_id_seq', 1000, true)`);
});

afterAll(async () => {
  await db.pg.close();
});

describe('comment v3 reverse copy', () => {
  it('starts from parity, and a reverse pass over a converged pair changes nothing', async () => {
    expect(zeros(await parityReport(db.pg))).toEqual({});
    expect(await rowTotals(db.pg)).toMatchObject({ CommentV2: 5, Comment: 4, CommentV3: 9 });
    await noReverseWork();
  });

  it('writes made only to v3 land in the old tables with the threads they need', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentTopic"("entityType", "entityId", locked) VALUES ('image', 12, true), ('image', 13, false), ('comicChapter', 77, true), ('review', 2, false), ('review', 3, true), ('appListing', 9, false);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt", "updatedAt", "pinnedAt")
        VALUES (50, 'image', 12, 5, 'v3 root 50', '2025-01-01 00:00:00.123456+00', '2025-01-02 00:00:00+00', '2025-01-03 00:00:00+00');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, hidden, "createdAt") VALUES (51, 'image', 10, 6, 'v3 root 51', true, '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, locked, "createdAt") VALUES (52, 'image', 12, 50, 7, 'v3 reply 52', true, '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "tosViolation", "createdAt") VALUES (53, 'image', 12, 52, 8, 'v3 reply 53', true, '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES (54, 'comicChapter', 77, 9, 'v3 comic 54', '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "createdAt") VALUES (55, 'image', 12, 50, 52, 1, 'v3 clamped 55', '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES (56, 'review', 2, 2, 'v3 review 56', '2025-02-01'), (57, 'appListing', 9, 3, 'v3 listing 57', '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "deletedAt", "createdAt") VALUES (58, 'image', 10, 4, '', now(), '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "legacyV1Id", "createdAt") VALUES (59, 'model', 2, 5, 'v1-shaped without its row', 999, '2025-02-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES (60, 'image', 10, 6, 'a ghost, older than the flip', '2024-06-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES (61, 'image', 10, 6, 'a ghost, after the rollback', '2026-02-01');
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction, "createdAt") VALUES (50, 3, 'Like', '2025-02-01 00:00:00+00'), (58, 3, 'Like', '2025-02-02 00:00:00+00'), (51, 4, 'Cry', '2026-02-01 00:00:00+00');
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (5, 50);
      INSERT INTO "CommentMute"("userId", "commentId", "mutedAt") VALUES (6, 52, '2025-03-01 00:00:00+00'), (6, 53, '2025-03-02 00:00:00+00');
      INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId", "mutedAt") VALUES (7, 'image', 12, '2025-03-03 00:00:00+00'), (7, 'image', 13, '2025-03-04 00:00:00+00'), (7, 'comicChapter', 77, '2024-06-01 00:00:00+00');
    `);

    // Scoped to a surface that was not flipped, nothing here is pending.
    const MODEL_ONLY = { ...SCOPE, entityTypes: ['model'] };
    expect(await reverseRootThreads(db.pg, ALL, MODEL_ONLY)).toEqual({ created: 0, relocked: 0 });
    expect(await reverseDryCount(db.pg, 'reverseComments', ALL, MODEL_ONLY)).toBe(0);
    expect(await reverseComments(db.pg, ALL, MODEL_ONLY)).toEqual({
      pending: 0,
      threads: 0,
      copied: 0,
    });
    expect(await reverseTopicMutes(db.pg, ALL, MODEL_ONLY)).toEqual({ added: 0, removed: 0 });
    expect(await count('FROM "Thread" WHERE "imageId" = 12 OR "comicProjectId" = 5')).toBe(0);

    expect(await reverseRootThreads(db.pg, { start: 0, end: 12 }, SCOPE)).toEqual({
      created: 4,
      relocked: 0,
    });
    // A topic locked on v3 before anyone commented gets its root thread, which is where the old
    // side keeps the lock.
    expect(await thread(`"reviewId" = 3`)).toMatchObject({ locked: true });
    expect(await reverseRootThreads(db.pg, { start: 13, end: 1000 }, SCOPE)).toEqual({
      created: 2,
      relocked: 0,
    });
    expect(await thread(`"imageId" = 12`)).toMatchObject({ locked: true, commentId: null });
    expect(await thread(`"imageId" = 13`)).toMatchObject({ locked: false });
    expect(await thread(`"reviewId" = 2`)).toBeDefined();
    expect(await thread(`"appListingId" = 9`)).toBeDefined();
    expect(await thread(`"comicProjectId" = 5 AND "comicChapterPosition" = 2`)).toMatchObject({
      locked: true,
    });

    expect(await reverseDryCount(db.pg, 'reverseComments', ALL, SCOPE)).toBe(8);
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 8, threads: 0, copied: 5 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 3, threads: 1, copied: 1 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 2, threads: 1, copied: 2 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 0, threads: 0, copied: 0 });
    expect(await count('FROM "CommentV2" WHERE id IN (58, 59, 60, 61)')).toBe(0);

    const root12 = await thread(`"imageId" = 12`);
    expect(await old(50)).toMatchObject({ threadId: root12.id, content: 'v3 root 50' });
    expect(
      await one(
        `SELECT "createdAt" = '2025-01-01 00:00:00.123' AS c, "updatedAt" = '2025-01-02 00:00:00' AS u, "pinnedAt" = '2025-01-03 00:00:00' AS p FROM "CommentV2" WHERE id = 50`
      )
    ).toEqual({ c: true, u: true, p: true });
    expect(await old(51)).toMatchObject({ threadId: 1, hidden: true });
    const t50 = await thread(`"commentId" = 50`);
    expect(t50).toMatchObject({
      parentThreadId: root12.id,
      rootThreadId: root12.id,
      locked: false,
    });
    expect(await old(52)).toMatchObject({ threadId: t50.id });
    const t52 = await thread(`"commentId" = 52`);
    expect(t52).toMatchObject({ parentThreadId: t50.id, rootThreadId: root12.id, locked: true });
    expect(await old(53)).toMatchObject({ threadId: t52.id, tosViolation: true });
    expect(await old(55)).toMatchObject({ threadId: t52.id });
    expect((await thread(`"comicProjectId" = 5`)).commentCount).toBe(1);
    expect((await thread(`"imageId" = 12`)).commentCount).toBe(1);
    expect(await old(56)).toMatchObject({ threadId: (await thread(`"reviewId" = 2`)).id });
    expect(await old(57)).toMatchObject({ threadId: (await thread(`"appListingId" = 9`)).id });

    // The reaction on 51 dated after the rollback window is an old-side unreact the mirror yielded on.
    expect(await reverseDryCount(db.pg, 'reverseLinks', ALL, SCOPE)).toBe(1);
    expect(await reverseLinks(db.pg, ALL, SCOPE)).toEqual({
      reactionsAdded: 1,
      reactionsRemoved: 0,
      reports: 1,
      mutesAdded: 2,
      mutesRemoved: 0,
    });
    expect(await count(`FROM "CommentV2Reaction" WHERE "commentId" = 51`)).toBe(0);
    expect(
      await one(
        `SELECT "createdAt" = '2025-02-01 00:00:00' AS c FROM "CommentV2Reaction" WHERE "commentId" = 50 AND "userId" = 3`
      )
    ).toEqual({ c: true });
    expect(await count(`FROM "CommentV2Report" WHERE "reportId" = 5 AND "commentV2Id" = 50`)).toBe(
      1
    );
    expect(await thread(`"commentId" = 53`)).toMatchObject({
      parentThreadId: t52.id,
      rootThreadId: root12.id,
    });
    expect(
      await rows(
        `SELECT t."commentId", m."mutedAt" = '2025-03-02 00:00:00' AS at FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId" WHERE m."userId" = 6 ORDER BY 1`
      )
    ).toEqual([
      { commentId: 52, at: false },
      { commentId: 53, at: true },
    ]);
    expect(await reverseTopicMutes(db.pg, ALL, SCOPE)).toEqual({ added: 3, removed: 0 });
    expect(
      await one(
        `SELECT "mutedAt" = '2025-03-03 00:00:00' AS at FROM "ThreadMute" WHERE "userId" = 7 AND "threadId" = ${root12.id}`
      )
    ).toEqual({ at: true });
    expect(await count(`FROM "ThreadMute" WHERE "userId" = 7`)).toBe(3);

    await db.pg.exec(`
      UPDATE "CommentTopic" SET locked = true WHERE "entityType" = 'image' AND "entityId" = 10;
      UPDATE "CommentTopic" SET locked = false WHERE "entityType" = 'comicChapter' AND "entityId" = 77;
    `);
    expect(await reverseRootThreads(db.pg, ALL, SCOPE)).toEqual({ created: 0, relocked: 2 });
    expect((await thread(`"imageId" = 10`)).locked).toBe(true);
    expect((await thread(`"comicProjectId" = 5`)).locked).toBe(false);

    await db.pg.exec(`DELETE FROM "CommentV3" WHERE id IN (58, 59, 60, 61)`);
    await db.pg.exec(`DELETE FROM "CommentV3Reaction" WHERE "commentId" = 51`);
    expect(zeros(await parityReport(db.pg))).toEqual({});
    expect(zeros(await unmirroredReport(db.pg))).toEqual({});
    await noReverseWork();
  });

  it('model comments written to v3 go to the v1 table, under their v1 parents', async () => {
    const v1a = await legacy(1);
    await db.pg.exec(`
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, locked, "createdAt") VALUES (70, 'model', 1, 7, 'v3 model root', true, '2025-06-01 00:00:00.5+00');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt") VALUES (71, 'model', 1, ${v1a}, 8, 'v3 reply to a v1 comment', '2025-06-01 00:00:00+00');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt") VALUES (72, 'model', 1, 70, 9, 'v3 reply to a v3 root', '2025-06-01 00:00:00+00');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt") VALUES (73, 'model', 1, 5, 1, 'v3 reply to a v2 model comment', '2025-06-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt") VALUES (74, 'model', 1, 73, 2, 'v3 grandchild of a v2 model comment', '2025-06-01');
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt") VALUES (75, 'model', 1, 74, 3, 'v3 great-grandchild of a v2 model comment', '2025-06-01');
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction, "createdAt") VALUES (70, 3, 'Like', '2025-06-02');
    `);
    // The chain under v2 row 5 is v2-shaped to its end: each level waits for its parent's reply
    // thread, and none is stamped v1-shaped while its parent's old row is still missing.
    expect(await reverseDryCount(db.pg, 'reverseComments', ALL, SCOPE)).toBe(6);
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 6, threads: 1, copied: 3 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 3, threads: 1, copied: 2 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 1, threads: 1, copied: 1 });
    expect(await reverseComments(db.pg, ALL, SCOPE)).toEqual({ pending: 0, threads: 0, copied: 0 });
    expect(await old(73)).toMatchObject({ threadId: (await thread(`"commentId" = 5`)).id });
    expect(await old(74)).toMatchObject({ threadId: (await thread(`"commentId" = 73`)).id });
    expect(await old(75)).toMatchObject({ threadId: (await thread(`"commentId" = 74`)).id });
    expect(
      await count(`FROM "CommentV3" WHERE id IN (73, 74, 75) AND "legacyV1Id" IS NOT NULL`)
    ).toBe(0);
    expect(
      await rows(
        `SELECT id, "modelId", "parentId", locked, "createdAt" = CASE WHEN id = 70 THEN '2025-06-01 00:00:00.5' ELSE '2025-06-01 00:00:00' END::timestamp AS c FROM "Comment" WHERE id IN (70, 71, 72) ORDER BY id`
      )
    ).toEqual([
      { id: 70, modelId: 1, parentId: null, locked: true, c: true },
      { id: 71, modelId: 1, parentId: 1, locked: false, c: true },
      { id: 72, modelId: 1, parentId: 70, locked: false, c: true },
    ]);
    expect(await count('FROM "CommentV2" WHERE id IN (70, 71, 72)')).toBe(0);
    expect(
      await rows(`SELECT id, "legacyV1Id" FROM "CommentV3" WHERE id IN (70, 71, 72) ORDER BY id`)
    ).toEqual([
      { id: 70, legacyV1Id: 70 },
      { id: 71, legacyV1Id: 71 },
      { id: 72, legacyV1Id: 72 },
    ]);
    expect(await reverseLinks(db.pg, ALL, SCOPE)).toMatchObject({ reactionsAdded: 1 });
    expect(await count(`FROM "CommentReaction" WHERE "commentId" = 70 AND "userId" = 3`)).toBe(1);
    expect(zeros(await parityReport(db.pg))).toEqual({});
    await noReverseWork();
  });

  it('edits, locks, deletes and unreacts made on v3 flow back, on both v2 and v1 rows', async () => {
    const v1a = await legacy(1);
    const v1b = await legacy(2);
    const v1c = await legacy(3);
    const v1d = await legacy(4);
    await db.pg.exec(`
      UPDATE "CommentV3" SET content = 'edited on v3', hidden = true, "tosViolation" = true, "pinnedAt" = '2025-04-02 00:00:00.000777+00', "updatedAt" = '2025-04-01 00:00:00.123456+00' WHERE id = 2;
      UPDATE "CommentV3" SET locked = true WHERE id = 2;
      UPDATE "CommentV3" SET locked = false WHERE id = 52;
      UPDATE "CommentV3" SET content = 'v1 edited on v3', locked = true, hidden = true, "pinnedAt" = '2025-04-03 00:00:00+00', "updatedAt" = '2025-04-03 00:00:00+00' WHERE id = ${v1a};
      UPDATE "CommentV3" SET "deletedAt" = now(), content = '' WHERE id = 1;
      DELETE FROM "CommentV3" WHERE id = 3;
      UPDATE "CommentV3" SET "deletedAt" = now(), content = '' WHERE id = ${v1b};
      DELETE FROM "CommentV3" WHERE id = ${v1c};
      DELETE FROM "CommentV3Reaction" WHERE "commentId" = 2 AND "userId" = 3;
      DELETE FROM "CommentV3Reaction" WHERE "commentId" = ${v1b};
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction, "createdAt") VALUES (${v1a}, 5, 'Laugh', '2025-05-01 00:00:00+00');
      DELETE FROM "CommentV3Reaction" WHERE "commentId" = ${v1a} AND "userId" = 2;
      -- An old-side edit newer than the v3 row stays, as a concurrent edit would, on both shapes.
      UPDATE "CommentV3" SET content = 'stale v3 edit', "updatedAt" = '2025-04-05 00:00:00+00' WHERE id IN (4, ${v1d});
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (6, ${v1a});
      -- Unmutes on v3: the pre-flip mutes come off the old side; the in-window ones stay there.
      DELETE FROM "CommentMute" WHERE "userId" = 8 AND "commentId" = 4;
      DELETE FROM "CommentTopicMute" WHERE "userId" = 8 AND "entityId" = 10;
      DELETE FROM "CommentMute" WHERE "userId" = 6 AND "commentId" = 52;
      DELETE FROM "CommentTopicMute" WHERE "userId" = 7 AND "entityId" = 13;
      DELETE FROM "CommentTopicMute" WHERE "userId" = 7 AND "entityType" = 'comicChapter';
    `);

    await db.pg.exec(`ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror`);
    await db.pg.exec(
      `UPDATE "CommentV2" SET content = 'newer old-side edit', "updatedAt" = '2025-04-06 00:00:00' WHERE id = 4`
    );
    await db.pg.exec(`ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror`);
    await db.pg.exec(`ALTER TABLE "Comment" DISABLE TRIGGER commentv3_mirror`);
    await db.pg.exec(
      `UPDATE "Comment" SET content = 'newer v1 edit', "updatedAt" = '2025-04-06 00:00:00' WHERE id = 4`
    );
    await db.pg.exec(`ALTER TABLE "Comment" ENABLE TRIGGER commentv3_mirror`);
    expect(await reverseDryCount(db.pg, 'reverseUpdates', ALL, SCOPE)).toBe(3);
    expect(await reverseUpdates(db.pg, ALL)).toEqual({ v2: 1, v1: 1, locks: 2 });
    expect((await old(4)).content).toBe('newer old-side edit');
    expect(await one(`SELECT content FROM "Comment" WHERE id = 4`)).toEqual({
      content: 'newer v1 edit',
    });
    await db.pg.exec(`
      UPDATE "CommentV2" SET content = 'newer old-side edit' WHERE id = 4;
      UPDATE "Comment" SET content = 'newer v1 edit' WHERE id = 4;
    `);
    expect(await old(2)).toMatchObject({
      content: 'edited on v3',
      hidden: true,
      tosViolation: true,
    });
    expect(
      await one(
        `SELECT "updatedAt" = '2025-04-01 00:00:00.123' AS u, "pinnedAt" = '2025-04-02 00:00:00.001' AS p FROM "CommentV2" WHERE id = 2`
      )
    ).toEqual({ u: true, p: true });
    expect(await thread(`"commentId" = 2`)).toMatchObject({
      locked: true,
      parentThreadId: 2,
      rootThreadId: 1,
    });
    expect((await thread(`"commentId" = 52`)).locked).toBe(false);
    expect(
      await one(
        `SELECT content, locked, hidden, "pinnedAt" = '2025-04-03 00:00:00' AS p FROM "Comment" WHERE id = 1`
      )
    ).toEqual({ content: 'v1 edited on v3', locked: true, hidden: true, p: true });

    expect(await reverseDryCount(db.pg, 'reverseDeletes', ALL, SCOPE)).toBe(3);
    expect(await reverseDeletes(db.pg, ALL, SCOPE)).toEqual({ v2: 2, v1: 1, blanked: 1 });
    expect(await count('FROM "CommentV2" WHERE id IN (1, 3)')).toBe(0);
    expect(await count('FROM "Comment" WHERE id = 3')).toBe(0);
    expect(await one(`SELECT content FROM "Comment" WHERE id = 2`)).toEqual({ content: '' });
    expect(await count('FROM "Comment" WHERE id = 4')).toBe(1);
    expect(await count(`FROM "CommentV3" WHERE "legacyV1Id" = 4 AND "deletedAt" IS NULL`)).toBe(1);
    // The reply thread survives with commentId nulled (FK SET NULL), as after a hard delete.
    expect(await thread(`id = 2`)).toMatchObject({ commentId: null });
    expect(await count('FROM "CommentV2" WHERE id = 2')).toBe(1);

    expect(await reverseDryCount(db.pg, 'reverseLinks', ALL, SCOPE)).toBe(1);
    expect(await reverseLinks(db.pg, ALL, SCOPE)).toEqual({
      reactionsAdded: 1,
      reactionsRemoved: 2,
      reports: 1,
      mutesAdded: 0,
      mutesRemoved: 1,
    });
    expect(await count(`FROM "CommentV2Reaction" WHERE "commentId" = 2`)).toBe(0);
    expect(await count(`FROM "CommentReaction" WHERE "commentId" = 1 AND "userId" = 2`)).toBe(0);
    expect(
      await one(
        `SELECT "createdAt" = '2025-05-01 00:00:00' AS c FROM "CommentReaction" WHERE "commentId" = 1 AND "userId" = 5`
      )
    ).toEqual({ c: true });
    expect(await count(`FROM "CommentReport" WHERE "reportId" = 6 AND "commentId" = 1`)).toBe(1);
    expect(await count(`FROM "ThreadMute" WHERE "userId" = 8 AND "threadId" = 4`)).toBe(0);
    expect(await reverseTopicMutes(db.pg, ALL, SCOPE)).toEqual({ added: 0, removed: 2 });
    expect(await count(`FROM "ThreadMute" WHERE "userId" = 8 AND "threadId" = 1`)).toBe(0);
    expect(
      await count(
        `FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."comicProjectId" = 5`
      )
    ).toBe(0);
    // A mute made and undone inside the flip window looks like an old-side mute the mirror yielded
    // on, so its ThreadMute stays for the parity report.
    expect(
      await count(
        `FROM "ThreadMute" m JOIN "Thread" t ON t.id = m."threadId" WHERE (m."userId" = 6 AND t."commentId" = 52) OR t."imageId" = 13`
      )
    ).toBe(2);
    await db.pg.exec(
      `DELETE FROM "ThreadMute" m USING "Thread" t WHERE t.id = m."threadId" AND (t."commentId" = 52 OR t."imageId" = 13)`
    );

    expect(zeros(await parityReport(db.pg), ['tombstones_childless'])).toEqual({});
    await noReverseWork();
  });

  it('leaves the orphan classes and out-of-scope rows alone, and surfaces a thread id sequence that is behind', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread"(id, "questionId") VALUES (100, 5);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt") VALUES (61, 'question thread', 8, 100, '2024-01-01');
      SET session_replication_role = replica;
      INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId", "createdAt") VALUES (9, 'parent gone', 9, 1, 777, '2024-01-01');
      -- Written after the flip and never mirrored, as a yielded old-side write looks: not a v3 delete.
      INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt") VALUES (62, 'yielded', 8, 1, '2025-06-01');
      INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction, "createdAt") VALUES (4, 9, 'Laugh', '2025-06-01');
      SET session_replication_role = DEFAULT;
    `);
    expect(await reverseDryCount(db.pg, 'reverseDeletes', ALL, SCOPE)).toBe(0);
    expect(await reverseDeletes(db.pg, ALL, SCOPE)).toEqual({ v2: 0, v1: 0, blanked: 0 });
    expect(await reverseLinks(db.pg, ALL, SCOPE)).toMatchObject({ reactionsRemoved: 0 });
    expect(await count('FROM "CommentV2" WHERE id IN (61, 62)')).toBe(2);
    expect(await count('FROM "Comment" WHERE id = 9')).toBe(1);
    expect(await count(`FROM "CommentV2Reaction" WHERE "commentId" = 4 AND "userId" = 9`)).toBe(1);
    // Out of the flipped surface's types, a tombstone still goes but a missing v3 row is left alone.
    expect(
      await reverseDeletes(db.pg, ALL, {
        since: new Date('2026-01-01'),
        until: new Date('2026-06-01'),
        entityTypes: ['post'],
      })
    ).toEqual({ v2: 0, v1: 0, blanked: 0 });

    // A conflict on anything but the entity column, like a primary key the sequence has not
    // caught up to, must fail loudly rather than vanish into ON CONFLICT.
    await db.pg.exec(`
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('image', 14);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES (63, 'image', 14, 5, 'root on 14', '2025-02-01');
      SELECT setval('"Thread_id_seq"', 1, false);
    `);
    try {
      await expect(reverseRootThreads(db.pg, ALL, SCOPE)).rejects.toThrow(/duplicate key/);
    } finally {
      await db.pg.exec(`SELECT setval('"Thread_id_seq"', (SELECT max(id) FROM "Thread"), true)`);
    }
    expect(await reverseRootThreads(db.pg, ALL, SCOPE)).toEqual({ created: 1, relocked: 0 });
  });
});
