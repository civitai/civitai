import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  copyMutes,
  copyTopics,
  copyV1Comments,
  copyV1Reactions,
  copyV1Reports,
  copyV2Comments,
  copyV2Reactions,
  copyV2Reports,
  countPendingLinks,
  countPendingTopics,
  countPendingV1,
  countPendingV2,
  parityReport,
  sweep,
  unmirroredReport,
} from '~/server/services/comment-v3-backfill.service';
import { FIXTURE, migration } from './comment-v3-fixture';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

// Single session: the SKIP LOCKED yields to concurrent deleters are not exercised.

// Everything here predates the mirror, so nothing is in CommentV3 until the backfill runs.
//   v2: image 10 carries a 25-deep chain (ids 1..25, each a reply to the previous), root 26 with a
//       reply 35 in a thread that has no parentThreadId/rootThreadId, and root 36 with hidden NULL;
//       image 11 is locked with roots 27, 28 and a locked reply thread under 27 holding 29;
//       article 1 has root 30 with reply 31 whose parent was then hard-deleted (dead-parent thread),
//       and 33 replies to 31; thread 100 is a question thread (unresolved entity) and holds 32;
//       thread 70 belongs to image 99, which no longer exists, and holds 34; 37 points at a thread
//       that does not exist.
//   v1: model 1 holds 1 > 2 > 3 (3 replies to 2) and root 4; model 2 holds 5; model 99 (gone) holds
//       6; model 3 has a locked Thread and holds 7; model 4 holds a 22-deep chain 100..121; 9 on
//       model 5 replies to a comment that no longer exists.
//   Reactions and reports on both sides, some on rows that can never be mirrored; mutes on v2
//   threads, one on a reply thread whose comment is unmirrorable.
const PRE_EXISTING = `
INSERT INTO "Thread"(id, "imageId") VALUES (1, 10);
INSERT INTO "CommentV2"(id, content, "userId", "threadId", "createdAt", "updatedAt", "pinnedAt")
  VALUES (1, 'v2 1', 1, 1, '2024-03-05 10:00:00', '2024-03-07 12:00:00', '2024-03-06 11:00:00');
DO $$ BEGIN
  FOR i IN 2..25 LOOP
    INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (i, i - 1, i - 1, 1);
    INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (i, 'v2 ' || i, 1 + (i % 10), i);
  END LOOP;
END $$;
INSERT INTO "CommentV2"(id, content, "userId", "threadId", hidden, "tosViolation") VALUES (26, 'v2 26 hidden', 2, 1, true, true);
INSERT INTO "Thread"(id, "commentId") VALUES (71, 26);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (35, 'v2 35 under 26', 3, 71);
INSERT INTO "CommentV2"(id, content, "userId", "threadId", hidden) VALUES (36, 'v2 36 null hidden', 4, 1, NULL);

INSERT INTO "Thread"(id, "imageId", locked) VALUES (40, 11, true);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (27, 'v2 27', 3, 40), (28, 'v2 28', 4, 40);
INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId", locked) VALUES (41, 27, 40, 40, true);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (29, 'v2 29', 5, 41);

INSERT INTO "Thread"(id, "articleId") VALUES (50, 1);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (30, 'v2 30', 6, 50);
INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (51, 30, 50, 50);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (31, 'v2 31 orphan', 7, 51);
DELETE FROM "CommentV2" WHERE id = 30;
INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (61, 31, 51);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (33, 'v2 33 under orphan', 8, 61);

INSERT INTO "Thread"(id, "questionId") VALUES (100, 5);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (32, 'v2 32 unresolved', 8, 100);

INSERT INTO "Thread"(id, "articleId") VALUES (60, 2);
INSERT INTO "Thread"(id, "modelId", locked) VALUES (72, 3, true);

SET session_replication_role = replica;
INSERT INTO "Thread"(id, "imageId") VALUES (70, 99);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (34, 'v2 34 image gone', 9, 70);
INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (6, 'v1 6 model gone', 6, 99);
INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (37, 'v2 37 thread gone', 9, 999);
INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId") VALUES (9, 'v1 9 parent gone', 9, 5, 777);
SET session_replication_role = DEFAULT;

INSERT INTO "Comment"(id, content, "userId", "modelId", "createdAt", "updatedAt", "pinnedAt")
  VALUES (1, 'v1 1', 1, 1, '2023-01-02 03:04:05', '2023-01-04 05:06:07', '2023-01-03 04:05:06');
INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId", locked, hidden) VALUES (2, 'v1 2', 2, 1, 1, true, NULL), (3, 'v1 3', 3, 1, 2, NULL, true);
INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (4, 'v1 4', 4, 1), (5, 'v1 5', 5, 2), (7, 'v1 7', 7, 3);
INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (100, 'v1 100', 1, 4);
DO $$ BEGIN
  FOR i IN 101..121 LOOP
    INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId") VALUES (i, 'v1 ' || i, 1 + (i % 10), 4, i - 1);
  END LOOP;
END $$;

INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction, "createdAt", "updatedAt") VALUES
  (1, 2, 'Like', '2024-04-01 00:00:00', '2024-04-01 01:00:00'), (1, 3, 'Heart', '2024-04-02 00:00:00', '2024-04-02 00:00:00'),
  (25, 4, 'Cry', '2024-04-03 00:00:00', '2024-04-03 00:00:00'), (31, 5, 'Like', '2024-04-04 00:00:00', '2024-04-04 00:00:00'),
  (34, 6, 'Like', '2024-04-05 00:00:00', '2024-04-05 00:00:00');
INSERT INTO "CommentReaction"("commentId", "userId", reaction, "createdAt", "updatedAt") VALUES
  (1, 2, 'Like', '2023-02-01 00:00:00', '2023-02-01 02:00:00'), (3, 4, 'Laugh', '2023-02-02 00:00:00', '2023-02-02 00:00:00'),
  (6, 7, 'Like', '2023-02-03 00:00:00', '2023-02-03 00:00:00');
INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (1, 1), (26, 2), (31, 3);
INSERT INTO "CommentReport"("commentId", "reportId") VALUES (2, 4);
SELECT setval('"Comment_id_seq"', 121, true);
SELECT setval('"CommentV2_id_seq"', 36, true);
INSERT INTO "ThreadMute"("userId", "threadId", "mutedAt") VALUES (6, 1, '2024-05-01 00:00:00'), (6, 2, '2024-05-02 00:00:00'),
  (7, 41, '2024-05-03 00:00:00'), (7, 51, '2024-05-04 00:00:00'), (8, 100, '2024-05-05 00:00:00'), (9, 61, '2024-05-06 00:00:00');
`;

const ALL = { start: 0, end: 100_000 };

const db = { pg: null as unknown as PGlite };
const rows = async <T = Record<string, unknown>>(sql: string) => (await db.pg.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await rows<T>(sql))[0];
const count = async (sql: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n ${sql}`)).n;
const v3 = async (id: number) =>
  one<{
    entityType: string;
    entityId: number;
    parentId: number | null;
    replyToId: number | null;
    path: string;
    depth: number;
    content: string;
    hidden: boolean;
    locked: boolean;
    tosViolation: boolean;
    deletedAt: Date | null;
    reactionCount: number;
    legacyV1Id: number | null;
    createdAt: Date;
    updatedAt: Date;
    pinnedAt: Date | null;
  }>(
    `SELECT "entityType","entityId","parentId","replyToId",path::text AS path,depth,content,hidden,locked,"tosViolation","deletedAt","reactionCount","legacyV1Id","createdAt","updatedAt","pinnedAt" FROM "CommentV3" WHERE id = ${id}`
  );
const legacy = async (v1Id: number) =>
  (await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = ${v1Id}`))?.id;
const topic = (type: string, id: number) =>
  one<{ locked: boolean; commentCount: number }>(
    `SELECT locked, "commentCount" FROM "CommentTopic" WHERE "entityType" = '${type}' AND "entityId" = ${id}`
  );
const iso = (d: Date | null | undefined) => d?.toISOString();
const zeros = (report: Record<string, { count: number }>, except: string[] = []) =>
  Object.fromEntries(
    Object.entries(report)
      .filter(([k, v]) => !except.includes(k) && v.count !== 0)
      .map(([k, v]) => [k, v])
  );
const withoutTrigger = async (table: string, sql: string) => {
  await db.pg.exec(`ALTER TABLE "${table}" DISABLE TRIGGER commentv3_mirror`);
  try {
    await db.pg.exec(sql);
  } finally {
    await db.pg.exec(`ALTER TABLE "${table}" ENABLE TRIGGER commentv3_mirror`);
  }
};

const live = { v1: 0, v2Reply: 0 };

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(`SET TIME ZONE 'Etc/GMT-5'`);
  await db.pg.exec(FIXTURE);
  await db.pg.exec(PRE_EXISTING);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  live.v1 = (
    await one<{ id: number }>(
      `INSERT INTO "Comment"(content, "userId", "modelId") VALUES ('live v1', 5, 2) RETURNING id`
    )
  ).id;
  await db.pg.exec(`INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (42, 28, 40)`);
  live.v2Reply = (
    await one<{ id: number }>(
      `INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('live reply', 6, 42) RETURNING id`
    )
  ).id;
});

afterAll(async () => {
  await db.pg.close();
});

describe('comment v3 backfill', () => {
  it('starts with only the live-mirrored rows present and everything else pending', async () => {
    expect(await count('FROM "CommentV3"')).toBe(3);
    expect(await v3(live.v1)).toMatchObject({ legacyV1Id: live.v1, entityId: 2 });
    expect(await v3(28)).toMatchObject({ entityId: 11, parentId: null });
    expect(await v3(live.v2Reply)).toMatchObject({ parentId: 28 });
    expect(await countPendingV2(db.pg, ALL)).toBe(35);
    expect(await countPendingV1(db.pg, ALL)).toBe(30);
  });

  it('topics: one per root thread with a comment, lock or mute, by range, carrying the lock', async () => {
    // The live reply the mirror wrote already made image 11 a topic.
    expect(await countPendingTopics(db.pg, ALL)).toBe(3);
    expect(await copyTopics(db.pg, { start: 0, end: 40 })).toEqual({
      pending: 2,
      copied: 2,
      locked: 0,
    });
    expect(await copyTopics(db.pg, { start: 41, end: 1000 })).toEqual({
      pending: 3,
      copied: 1,
      locked: 0,
    });
    expect(await topic('image', 10)).toEqual({ locked: false, commentCount: 0 });
    expect(await topic('image', 11)).toEqual({ locked: true, commentCount: 2 });
    expect(await topic('model', 3)).toEqual({ locked: true, commentCount: 0 });
    // article 2 is empty and unlocked; image 99 is gone.
    expect(await topic('article', 1)).toBeUndefined();
    expect(await topic('article', 2)).toBeUndefined();
    expect(await topic('image', 99)).toBeUndefined();
    expect(await count('FROM "CommentTopic"')).toBe(4);
    expect(await countPendingTopics(db.pg, ALL)).toBe(1);

    // Trigger off, so the toggles are ones the mirror never saw; a lock makes an empty thread count.
    await withoutTrigger('Thread', `UPDATE "Thread" SET locked = true WHERE id = 60`);
    await withoutTrigger('Thread', `UPDATE "Thread" SET locked = false WHERE id = 40`);
    expect(await copyTopics(db.pg, ALL)).toEqual({ pending: 6, copied: 4, locked: 1 });
    expect(await topic('article', 2)).toEqual({ locked: true, commentCount: 0 });
    expect((await topic('image', 11)).locked).toBe(false);
    await withoutTrigger('Thread', `UPDATE "Thread" SET locked = true WHERE id = 40`);
    expect(await copyTopics(db.pg, ALL)).toEqual({ pending: 6, copied: 4, locked: 1 });
    expect((await topic('image', 11)).locked).toBe(true);
  });

  it('v2: copies in any batch order, ancestors first, clamped past depth 20, skipping orphans', async () => {
    // Highest ids first: the chain's leaf pulls its ancestors in with it.
    expect(await copyV2Comments(db.pg, { start: 20, end: 40 })).toEqual({
      pending: 16,
      copied: 11,
      relocked: 0,
    });
    expect(await copyV2Comments(db.pg, { start: 0, end: 19 })).toEqual({
      pending: 0,
      copied: 0,
      relocked: 0,
    });
    expect(await countPendingV2(db.pg, ALL)).toBe(5);

    expect(await v3(1)).toMatchObject({ entityType: 'image', entityId: 10, path: '1', depth: 0 });
    expect(await v3(21)).toMatchObject({ parentId: 20, replyToId: null, depth: 20 });
    expect(await v3(22)).toMatchObject({ parentId: 20, replyToId: 21, depth: 20 });
    expect(await v3(25)).toMatchObject({ parentId: 20, replyToId: 24, depth: 20 });
    expect(await v3(26)).toMatchObject({ hidden: true, tosViolation: true, parentId: null });
    expect(await v3(35)).toMatchObject({ parentId: 26, path: '26.35', entityId: 10 });
    expect(await v3(36)).toMatchObject({ hidden: false, locked: false });
    expect(await v3(29)).toMatchObject({ parentId: 27, locked: false });
    expect(await v3(27)).toMatchObject({ locked: true, entityId: 11 });
    await withoutTrigger('Thread', `UPDATE "Thread" SET locked = false WHERE id = 41`);
    expect(await copyV2Comments(db.pg, { start: 27, end: 27 })).toEqual({
      pending: 0,
      copied: 0,
      relocked: 1,
    });
    expect((await v3(27)).locked).toBe(false);
    await withoutTrigger('Thread', `UPDATE "Thread" SET locked = true WHERE id = 41`);
    expect((await copyV2Comments(db.pg, { start: 27, end: 27 })).relocked).toBe(1);
    expect((await v3(27)).locked).toBe(true);
    expect(await topic('image', 10)).toEqual({ locked: false, commentCount: 28 });
    expect(await topic('image', 11)).toEqual({ locked: true, commentCount: 4 });

    const c1 = await v3(1);
    expect(iso(c1.createdAt)).toBe('2024-03-05T10:00:00.000Z');
    expect(iso(c1.updatedAt)).toBe('2024-03-07T12:00:00.000Z');
    expect(iso(c1.pinnedAt)).toBe('2024-03-06T11:00:00.000Z');

    expect(await count('FROM "CommentV3" WHERE id IN (31, 32, 33, 34, 37)')).toBe(0);
    const report = await unmirroredReport(db.pg);
    expect(report.v2_pending).toEqual({ count: 5, sample: [31, 32, 33, 34, 37] });
    expect(report.v2_no_thread).toEqual({ count: 1, sample: [37] });
    expect(report.v2_dead_parent).toEqual({ count: 1, sample: [31] });
    expect(report.v2_unresolved_entity).toEqual({ count: 2, sample: [32, 33] });
    expect(report.v2_no_topic).toEqual({ count: 1, sample: [34] });
  });

  it('v1: copies with legacyV1Id, renumbering below the floor, clamping, creating the model topic', async () => {
    expect(await countPendingV1(db.pg, ALL)).toBe(30);
    expect(await copyV1Comments(db.pg, ALL)).toEqual({ pending: 30, copied: 28 });
    expect(await countPendingV1(db.pg, ALL)).toBe(2);
    const report = await unmirroredReport(db.pg);
    expect(report.v1_pending).toEqual({ count: 2, sample: [6, 9] });
    expect(report.v1_no_topic).toEqual({ count: 1, sample: [6] });
    expect(report.v1_dead_parent).toEqual({ count: 1, sample: [9] });

    const id1 = (await legacy(1))!;
    const id2 = (await legacy(2))!;
    const id3 = (await legacy(3))!;
    expect(id1).toBeGreaterThan(121);
    expect(await v3(id1)).toMatchObject({
      entityType: 'model',
      entityId: 1,
      legacyV1Id: 1,
      depth: 0,
    });
    expect(await v3(id2)).toMatchObject({ parentId: id1, locked: true, hidden: false });
    expect(await v3(id3)).toMatchObject({
      parentId: id2,
      path: `${id1}.${id2}.${id3}`,
      hidden: true,
      locked: false,
    });
    const c1 = await v3(id1);
    expect(iso(c1.createdAt)).toBe('2023-01-02T03:04:05.000Z');
    expect(iso(c1.updatedAt)).toBe('2023-01-04T05:06:07.000Z');
    expect(iso(c1.pinnedAt)).toBe('2023-01-03T04:05:06.000Z');
    expect(await v3((await legacy(121))!)).toMatchObject({
      parentId: await legacy(119),
      replyToId: await legacy(120),
      depth: 20,
    });
    expect(await v3(live.v1)).toMatchObject({ content: 'live v1' });
    expect(await topic('model', 1)).toEqual({ locked: false, commentCount: 4 });
    expect(await topic('model', 2)).toEqual({ locked: false, commentCount: 2 });
    expect(await topic('model', 3)).toEqual({ locked: true, commentCount: 1 });
    expect(await topic('model', 4)).toEqual({ locked: false, commentCount: 22 });
  });

  it('reactions and reports link through the mirror ids, by range, and keep the counts', async () => {
    expect(
      zeros(await unmirroredReport(db.pg), [
        'v2_pending',
        'v2_no_thread',
        'v2_dead_parent',
        'v2_unresolved_entity',
        'v2_no_topic',
        'v2_pending_unexplained',
        'v1_pending',
        'v1_dead_parent',
        'v1_no_topic',
        'v1_pending_unexplained',
      ])
    ).toEqual({
      v2_reactions_pending: { count: 3, sample: [1, 2, 3] },
      v1_reactions_pending: { count: 2, sample: [1, 2] },
      v2_reports_pending: { count: 2, sample: [1, 2] },
      v1_reports_pending: { count: 1, sample: [4] },
      mutes_pending: { count: 4, sample: [1, 2, 41, 61] },
    });

    expect(await countPendingLinks(db.pg, 'v2Reactions', ALL)).toBe(3);
    expect(await countPendingLinks(db.pg, 'v1Reactions', ALL)).toBe(2);
    expect(await countPendingLinks(db.pg, 'v2Reports', ALL)).toBe(2);
    expect(await countPendingLinks(db.pg, 'v1Reports', ALL)).toBe(1);
    expect(await copyV2Reactions(db.pg, { start: 1, end: 2 })).toEqual({
      pending: 2,
      copied: 2,
      unmirrored: 0,
    });
    expect(await copyV2Reactions(db.pg, { start: 3, end: 5 })).toEqual({
      pending: 3,
      copied: 1,
      unmirrored: 2,
    });
    expect(await copyV1Reactions(db.pg, ALL)).toEqual({ pending: 3, copied: 2, unmirrored: 1 });
    expect((await v3(1)).reactionCount).toBe(2);
    expect((await v3(25)).reactionCount).toBe(1);
    expect((await v3((await legacy(3))!)).reactionCount).toBe(1);
    const r = await rows<{ createdAt: Date; updatedAt: Date }>(
      `SELECT "createdAt", "updatedAt" FROM "CommentV3Reaction" r
        WHERE ("commentId" = 1 AND "userId" = 2) OR ("commentId" = ${await legacy(
          1
        )} AND "userId" = 2)
        ORDER BY "createdAt" DESC`
    );
    expect(r.map((x) => [iso(x.createdAt), iso(x.updatedAt)])).toEqual([
      ['2024-04-01T00:00:00.000Z', '2024-04-01T01:00:00.000Z'],
      ['2023-02-01T00:00:00.000Z', '2023-02-01T02:00:00.000Z'],
    ]);

    expect(await copyV2Reports(db.pg, { start: 1, end: 1 })).toEqual({
      pending: 1,
      copied: 1,
      unmirrored: 0,
    });
    expect(await copyV2Reports(db.pg, { start: 2, end: 3 })).toEqual({
      pending: 2,
      copied: 1,
      unmirrored: 1,
    });
    expect(await copyV1Reports(db.pg, ALL)).toEqual({ pending: 1, copied: 1, unmirrored: 0 });
    expect(
      await rows<{ reportId: number; commentId: number }>(
        `SELECT "reportId", "commentId" FROM "CommentV3Report" ORDER BY 1`
      )
    ).toEqual([
      { reportId: 1, commentId: 1 },
      { reportId: 2, commentId: 26 },
      { reportId: 4, commentId: await legacy(2) },
    ]);
  });

  it('mutes split by thread kind, skipping the ones with nowhere to go', async () => {
    expect(await copyMutes(db.pg)).toEqual({
      pending: 6,
      commentMutes: 2,
      topicMutes: 1,
      unmirrored: 3,
    });
    expect(
      await rows(`SELECT "userId", "commentId", "mutedAt" FROM "CommentMute" ORDER BY "commentId"`)
    ).toEqual([
      { userId: 6, commentId: 1, mutedAt: new Date('2024-05-02T00:00:00.000Z') },
      { userId: 7, commentId: 27, mutedAt: new Date('2024-05-03T00:00:00.000Z') },
    ]);
    expect(
      await rows(`SELECT "userId", "entityType", "entityId", "mutedAt" FROM "CommentTopicMute"`)
    ).toEqual([
      {
        userId: 6,
        entityType: 'image',
        entityId: 10,
        mutedAt: new Date('2024-05-01T00:00:00.000Z'),
      },
    ]);
  });

  it('is idempotent and never overwrites a mirrored row', async () => {
    await db.pg.exec(`UPDATE "CommentV3" SET content = 'fresher than the old side' WHERE id = 28`);
    expect(await copyTopics(db.pg, ALL)).toMatchObject({ locked: 0 });
    expect(await copyV2Comments(db.pg, ALL)).toEqual({ pending: 5, copied: 0, relocked: 0 });
    expect(await copyV1Comments(db.pg, ALL)).toEqual({ pending: 2, copied: 0 });
    expect((await copyV2Reactions(db.pg, ALL)).copied).toBe(0);
    expect((await copyV1Reactions(db.pg, ALL)).copied).toBe(0);
    expect((await copyV2Reports(db.pg, ALL)).copied).toBe(0);
    expect((await copyV1Reports(db.pg, ALL)).copied).toBe(0);
    expect(await copyMutes(db.pg)).toMatchObject({ commentMutes: 0, topicMutes: 0 });
    expect((await v3(28)).content).toBe('fresher than the old side');
    await db.pg.exec(`UPDATE "CommentV3" SET content = 'v2 28' WHERE id = 28`);
  });

  it('parity holds against the old side, through live writes', async () => {
    expect(zeros(await parityReport(db.pg))).toEqual({});
    expect(
      zeros(await unmirroredReport(db.pg), [
        'v2_pending',
        'v2_no_thread',
        'v2_dead_parent',
        'v2_unresolved_entity',
        'v2_no_topic',
        'v1_pending',
        'v1_dead_parent',
        'v1_no_topic',
      ])
    ).toEqual({ mutes_pending: { count: 1, sample: [61] } });

    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5000, 'live', 9, 2)`
    );
    await db.pg.exec(`UPDATE "CommentV2" SET content = 'edited', hidden = true WHERE id = 26`);
    await db.pg.exec(
      `INSERT INTO "CommentReaction"("commentId", "userId", reaction) VALUES (4, 6, 'Like')`
    );
    expect(zeros(await parityReport(db.pg))).toEqual({});
  });

  it('parity names every kind of drift, one at a time', async () => {
    const id4 = (await legacy(4))!;
    const id121 = (await legacy(121))!;
    const heart = (
      await one<{ id: number }>(
        `SELECT id FROM "CommentV3Reaction" WHERE "commentId" = 1 AND reaction = 'Heart'`
      )
    ).id;
    const laugh = (
      await one<{ id: number }>(`SELECT id FROM "CommentV3Reaction" WHERE reaction = 'Laugh'`)
    ).id;
    const cases: [
      string,
      string | (() => Promise<void>),
      number[],
      string | (() => Promise<void>)
    ][] = [
      [
        'v2_ghosts',
        () => withoutTrigger('CommentV2', `DELETE FROM "CommentV2" WHERE id = 5000`),
        [5000],
        `DELETE FROM "CommentV3" WHERE id = 5000`,
      ],
      [
        'v1_ghosts',
        () => withoutTrigger('Comment', `DELETE FROM "Comment" WHERE id = 4`),
        [id4],
        `INSERT INTO "Comment"(id, content, "userId", "modelId", "createdAt", "updatedAt")
          SELECT 4, content, "userId", "entityId", "createdAt" AT TIME ZONE 'UTC', "updatedAt" AT TIME ZONE 'UTC' FROM "CommentV3" WHERE "legacyV1Id" = 4`,
      ],
      [
        'resurrected',
        `UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = 27`,
        [27],
        `UPDATE "CommentV3" SET "deletedAt" = NULL WHERE id = 27`,
      ],
      [
        'thread_count_mismatch',
        () =>
          withoutTrigger(
            'CommentV2',
            `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5001, 'raw', 5, 41)`
          ),
        [41],
        () => withoutTrigger('CommentV2', `DELETE FROM "CommentV2" WHERE id = 5001`),
      ],
      [
        'model_v1_count_mismatch',
        () =>
          withoutTrigger(
            'Comment',
            `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (8, 'raw', 8, 2)`
          ),
        [2],
        () => withoutTrigger('Comment', `DELETE FROM "Comment" WHERE id = 8`),
      ],
      [
        'topic_count_mismatch',
        `UPDATE "CommentTopic" SET "commentCount" = 99 WHERE "entityType" = 'image' AND "entityId" = 11`,
        [11],
        `UPDATE "CommentTopic" SET "commentCount" = 4 WHERE "entityType" = 'image' AND "entityId" = 11`,
      ],
      [
        'reaction_count_mismatch',
        `UPDATE "CommentV3" SET "reactionCount" = 99 WHERE id = 1`,
        [1],
        `UPDATE "CommentV3" SET "reactionCount" = 2 WHERE id = 1`,
      ],
      [
        'v2_reactions_extra',
        () =>
          withoutTrigger(
            'CommentV2Reaction',
            `DELETE FROM "CommentV2Reaction" WHERE "commentId" = 1 AND reaction = 'Heart'`
          ),
        [heart],
        `INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (1, 3, 'Heart')`,
      ],
      [
        'v1_reactions_extra',
        () =>
          withoutTrigger(
            'CommentReaction',
            `DELETE FROM "CommentReaction" WHERE reaction = 'Laugh'`
          ),
        [laugh],
        `INSERT INTO "CommentReaction"("commentId", "userId", reaction) VALUES (3, 4, 'Laugh')`,
      ],
      [
        'reports_extra',
        () =>
          withoutTrigger('CommentV2Report', `DELETE FROM "CommentV2Report" WHERE "reportId" = 2`),
        [2],
        `INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (26, 2)`,
      ],
      [
        'topic_lock_mismatch',
        `UPDATE "CommentTopic" SET locked = true WHERE "entityType" = 'image' AND "entityId" = 10`,
        [1],
        `UPDATE "CommentTopic" SET locked = false WHERE "entityType" = 'image' AND "entityId" = 10`,
      ],
      [
        'comment_lock_mismatch',
        `UPDATE "CommentV3" SET locked = true WHERE id = 28`,
        [28],
        `UPDATE "CommentV3" SET locked = false WHERE id = 28`,
      ],
      [
        'v1_column_drift',
        () => withoutTrigger('Comment', `UPDATE "Comment" SET hidden = true WHERE id = 4`),
        [id4],
        () => withoutTrigger('Comment', `UPDATE "Comment" SET hidden = false WHERE id = 4`),
      ],
      [
        'v1_parent_mismatch',
        `UPDATE "CommentV3" SET "replyToId" = NULL WHERE id = ${id121}`,
        [id121],
        `UPDATE "CommentV3" SET "replyToId" = ${await legacy(120)} WHERE id = ${id121}`,
      ],
      [
        'mutes_extra',
        `INSERT INTO "CommentMute"("userId", "commentId") VALUES (9, 28)`,
        [28],
        `DELETE FROM "CommentMute" WHERE "userId" = 9 AND "commentId" = 28`,
      ],
      [
        'topic_mutes_orphaned',
        `INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (9, 'image', 19)`,
        [19],
        `DELETE FROM "CommentTopicMute" WHERE "entityId" = 19`,
      ],
      [
        'tombstones_childless',
        `UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = 36`,
        [36],
        `UPDATE "CommentV3" SET "deletedAt" = NULL WHERE id = 36`,
      ],
    ];
    for (const [col, value, restore] of [
      ['hidden', 'true', 'false'],
      ['"tosViolation"', 'true', 'false'],
      ['"userId"', '9', '4'],
      [
        '"createdAt"',
        `'2020-01-01'`,
        `(SELECT "createdAt" AT TIME ZONE 'UTC' FROM "CommentV3" WHERE id = 28)`,
      ],
      [
        '"updatedAt"',
        `'2020-01-01'`,
        `(SELECT "updatedAt" AT TIME ZONE 'UTC' FROM "CommentV3" WHERE id = 28)`,
      ],
      ['"pinnedAt"', `'2020-01-01'`, 'NULL'],
    ]) {
      cases.push([
        'v2_column_drift',
        () => withoutTrigger('CommentV2', `UPDATE "CommentV2" SET ${col} = ${value} WHERE id = 28`),
        [28],
        () =>
          withoutTrigger('CommentV2', `UPDATE "CommentV2" SET ${col} = ${restore} WHERE id = 28`),
      ]);
    }
    const run = (step: string | (() => Promise<void>)) =>
      typeof step === 'string' ? db.pg.exec(step) : step();
    for (const [key, drift, sample, restore] of cases) {
      await run(drift);
      const seen = zeros(await parityReport(db.pg));
      // A comment deleted on one side only also shifts its thread's count.
      const expected: Record<string, { count: number; sample: number[] }> = {
        [key]: { count: 1, sample },
      };
      if (key === 'tombstones_childless') {
        expected.resurrected = { count: 1, sample };
        expected.thread_count_mismatch = { count: 1, sample: [1] };
      }
      if (key === 'resurrected') expected.thread_count_mismatch = { count: 1, sample: [40] };
      if (key === 'v2_ghosts') expected.thread_count_mismatch = { count: 1, sample: [2] };
      // The old row the ghost mirrors was one of model 1's four.
      if (key === 'v1_ghosts') expected.model_v1_count_mismatch = { count: 1, sample: [1] };
      expect(seen, `${key} ${JSON.stringify(seen)}`).toEqual(expected);
      await run(restore);
    }
    expect(zeros(await parityReport(db.pg))).toEqual({});
  });

  it('sweep collapses tombstone chains and orphaned topic mutes, keeping tombstones that are still answered', async () => {
    expect(await sweep(db.pg)).toEqual({ tombstones: 0, topicMutes: 0 });
    // 25 answers 24 answers 23, so the chain collapses a level per pass; 21 is answered by live 22;
    // 27 is live 29's parent.
    await db.pg.exec(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id IN (21, 23, 24, 25, 27)`);
    await db.pg.exec(
      `INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (9, 'image', 19)`
    );
    expect(zeros(await parityReport(db.pg))).toMatchObject({
      tombstones_childless: { count: 1, sample: [25] },
      topic_mutes_orphaned: { count: 1, sample: [19] },
    });
    expect(await sweep(db.pg)).toEqual({ tombstones: 3, topicMutes: 1 });
    expect(await count('FROM "CommentV3" WHERE id IN (23, 24, 25)')).toBe(0);
    expect((await v3(21)).deletedAt).not.toBeNull();
    expect((await v3(27)).deletedAt).not.toBeNull();
    // Their old rows still exist, so the next v2 pass restores the swept ones.
    expect(await copyV2Comments(db.pg, { start: 23, end: 25 })).toEqual({
      pending: 3,
      copied: 3,
      relocked: 0,
    });
    expect(await v3(25)).toMatchObject({ parentId: 20, replyToId: 24 });
    await db.pg.exec(`UPDATE "CommentV3" SET "deletedAt" = NULL WHERE id IN (21, 27)`);
    expect(zeros(await parityReport(db.pg))).toEqual({});
  });
});
