import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The hand-run "Stored records" SQL in docs/plans/comments-v3-phase5.md, read from the plan itself so
// an edit there is what runs here: it rewrites the old comment types once, and a second run changes
// nothing, above all not a cleanup record the new code wrote.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const plan = readFileSync(
  path.resolve(__dirname, '../../../../../docs/plans/comments-v3-phase5.md'),
  'utf8'
);
const STORED_RECORDS_SQL = [...plan.matchAll(/```sql\n([\s\S]*?)```/g)]
  .map((m) => m[1])
  .find((sql) => sql.startsWith('BEGIN;') && sql.includes('"UserRestriction"'));

let pg: PGlite;

const NEW_CODE = {
  entityType: 'CommentV3',
  entityId: 100,
  cleanup: { kind: 'comments', ids: [100, 200] },
};
const CHAT = {
  entityType: 'ChatMessage',
  entityId: 5,
  cleanup: { kind: 'chatMessages', ids: [5] },
};
const OLD_ON_OTHER_RESTRICTION = { entityType: 'Comment', entityId: 11 };

beforeAll(async () => {
  pg = new PGlite();
  // CommentV3 900 carries v1 id 100, so reading the new code's [100, 200] as v1 ids would show.
  await pg.exec(`
    CREATE TABLE "UserRestriction" (id int PRIMARY KEY, type text NOT NULL, triggers jsonb);
    CREATE TABLE "CommentV3" (id int PRIMARY KEY, "legacyV1Id" int);
    CREATE TABLE "TextScanHold" (id int PRIMARY KEY, "entityType" text, "entityId" int, status text);
    CREATE TABLE "JobQueue" ("entityType" text, "entityId" int);
    CREATE TABLE "EntityModeration" ("entityType" text, "entityId" int);

    INSERT INTO "CommentV3" VALUES (100, NULL), (200, NULL), (301, 11), (302, 12), (303, 13), (900, 100);

    INSERT INTO "UserRestriction" VALUES
      (1, 'scam', '${JSON.stringify([
        { entityType: 'Comment', entityId: 13, cleanup: { kind: 'comments', ids: [12, 11, 14] } },
        {
          entityType: 'CommentV2',
          entityId: 302,
          cleanup: { kind: 'commentsV2', ids: [301, 302] },
        },
        CHAT,
        { entityType: 'Comment', entityId: 15, cleanup: { kind: 'comments', ids: [11] } },
        { entityType: 'Comment', entityId: 16, cleanup: { kind: 'commentsV2', ids: [100] } },
        NEW_CODE,
      ])}'),
      (2, 'scam', '${JSON.stringify([NEW_CODE])}'),
      (3, 'scam', NULL),
      (4, 'scam', '{}'),
      (5, 'other', '${JSON.stringify([OLD_ON_OTHER_RESTRICTION])}');

    INSERT INTO "TextScanHold" VALUES
      (1, 'Comment', 11, 'Pending'),
      (2, 'CommentV2', 302, 'Pending'),
      (3, 'Comment', 15, 'Pending'),
      (4, 'Post', 11, 'Pending'),
      (5, 'CommentV3', 100, 'Pending');

    INSERT INTO "JobQueue" VALUES ('Comment', 1), ('CommentV2', 2), ('Post', 3), ('CommentV3', 4);
    INSERT INTO "EntityModeration" VALUES
      ('Comment', 1), ('CommentV2', 2), ('Comment:shadow', 3), ('CommentV2:shadow', 4),
      ('CommentV3', 5), ('Post:shadow', 6);
  `);
});
afterAll(async () => {
  await pg.close();
});

const snapshot = async () => ({
  restrictions: (
    await pg.query<{ id: number; triggers: unknown }>(
      `SELECT id, triggers FROM "UserRestriction" ORDER BY id`
    )
  ).rows,
  holds: (
    await pg.query<{ id: number; entityType: string; entityId: number }>(
      `SELECT id, "entityType", "entityId" FROM "TextScanHold" ORDER BY id`
    )
  ).rows,
  queue: (await pg.query(`SELECT * FROM "JobQueue" ORDER BY "entityId"`)).rows,
  scans: (await pg.query(`SELECT * FROM "EntityModeration" ORDER BY "entityId"`)).rows,
});

describe('phase 5 stored-records SQL', () => {
  let afterFirst: Awaited<ReturnType<typeof snapshot>>;

  it('rewrites the old comment types to CommentV3, mapping v1 ids, and deletes queue and scan rows', async () => {
    await pg.exec(STORED_RECORDS_SQL!);
    afterFirst = await snapshot();

    expect(afterFirst.restrictions).toEqual([
      {
        id: 1,
        triggers: [
          // A v1 trigger: its id and its cleanup ids map through legacyV1Id; 14 has no CommentV3 row.
          {
            entityType: 'CommentV3',
            entityId: 303,
            cleanup: { kind: 'comments', ids: [301, 302], migrated: true },
          },
          // A CommentV2 id is the CommentV3 id.
          {
            entityType: 'CommentV3',
            entityId: 302,
            cleanup: { kind: 'comments', ids: [301, 302], migrated: true },
          },
          CHAT,
          // No CommentV3 row for v1 id 15: it keeps its type rather than name an unrelated comment.
          // Its cleanup ids still map, once: the marker stops a second run remapping them.
          {
            entityType: 'Comment',
            entityId: 15,
            cleanup: { kind: 'comments', ids: [301], migrated: true },
          },
          // A `commentsV2` record on an unmapped `Comment` trigger: its CommentV3 ids are kept, and the
          // marker stops a second run reading them as v1 ids (100 would become 900).
          {
            entityType: 'Comment',
            entityId: 16,
            cleanup: { kind: 'comments', ids: [100], migrated: true },
          },
          NEW_CODE,
        ],
      },
      { id: 2, triggers: [NEW_CODE] },
      { id: 3, triggers: null },
      { id: 4, triggers: {} },
      { id: 5, triggers: [OLD_ON_OTHER_RESTRICTION] },
    ]);
    expect(afterFirst.holds).toEqual([
      { id: 1, entityType: 'CommentV3', entityId: 301 },
      { id: 2, entityType: 'CommentV3', entityId: 302 },
      { id: 3, entityType: 'Comment', entityId: 15 },
      { id: 4, entityType: 'Post', entityId: 11 },
      { id: 5, entityType: 'CommentV3', entityId: 100 },
    ]);
    expect(afterFirst.queue).toEqual([
      { entityType: 'Post', entityId: 3 },
      { entityType: 'CommentV3', entityId: 4 },
    ]);
    expect(afterFirst.scans).toEqual([
      { entityType: 'CommentV3', entityId: 5 },
      { entityType: 'Post:shadow', entityId: 6 },
    ]);
  });

  it('changes nothing when run again', async () => {
    await pg.exec(STORED_RECORDS_SQL!);
    const afterSecond = await snapshot();

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.restrictions[0].triggers).toContainEqual(NEW_CODE);
  });
});
