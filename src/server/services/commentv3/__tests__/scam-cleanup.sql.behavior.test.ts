import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

// The scam cleanup's `comments` kind against real Postgres: which CommentV3 comments a mute hides,
// and which the overturn brings back.

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { restoreScamCase, runScamCleanup } = await import('~/server/services/scam-cleanup.service');

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(migration('20261120120000_comment_v3_mirror'));
  await pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
  await pg.exec(migration('20270101120000_comment_v3_old_table_triggers_off'));
  await pg.exec(migration('20270102120000_comment_v3_teardown'));

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

const SCAMMER = 5;
const OTHER = 6;

// 41, 42 and 46 are the scammer's live comments, on an article and a model; 43 is already hidden,
// 44 deleted. 45 is someone else's.
beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "CommentV3"; DELETE FROM "CommentTopic";
    INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 1), ('model', 1);
    INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, hidden, "deletedAt") VALUES
      (41, 'article', 1, ${SCAMMER}, 'one', false, NULL),
      (42, 'article', 1, ${SCAMMER}, 'two', false, NULL),
      (43, 'article', 1, ${SCAMMER}, 'hidden already', true, NULL),
      (44, 'article', 1, ${SCAMMER}, '', false, now()),
      (45, 'article', 1, ${OTHER}, 'someone else', false, NULL),
      (46, 'model', 1, ${SCAMMER}, 'on a model', false, NULL);
  `);
});

const hidden = async () =>
  (await pg.query<{ id: number }>(`SELECT id FROM "CommentV3" WHERE hidden ORDER BY id`)).rows.map(
    (r) => r.id
  );

describe('scam cleanup of comments', () => {
  it('hides the scammer’s live comments on every surface, and nobody else’s', async () => {
    const record = await runScamCleanup('comments', SCAMMER);
    expect(record).toMatchObject({ kind: 'comments', count: 3, truncated: false });
    expect([...(record?.ids ?? [])].sort()).toEqual([41, 42, 46]);
    // The deleted 44 and the other user's 45 stay as they were.
    expect(await hidden()).toEqual([41, 42, 43, 46]);
  });

  it('brings back exactly what it hid when the mute is overturned', async () => {
    const record = await runScamCleanup('comments', SCAMMER);
    // A comment of someone else's under a recorded id is never touched.
    await pg.exec(`UPDATE "CommentV3" SET hidden = true WHERE id = 45`);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: SCAMMER,
      type: 'scam',
      triggers: [{ cleanup: { ...record, ids: [...(record?.ids ?? []), 45] } }],
    } as never);

    expect(await restoreScamCase(1)).toEqual({ restored: 3 });
    // 43 was hidden before the cleanup and is not in the record.
    expect(await hidden()).toEqual([43, 45]);
  });

  it('restores a `commentsV2` record, written before Phase 5, by its CommentV3 ids', async () => {
    // 60 is the scammer's comment that cleanup hid; 61 is someone else's. A `Comment` trigger wrote
    // `commentsV2` records too, and those ids are CommentV3 ids all the same.
    await pg.exec(`
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, hidden, "legacyV1Id") VALUES
        (60, 'model', 1, ${SCAMMER}, 'pre-flip', true, 31),
        (61, 'model', 1, ${OTHER}, 'someone else', true, 32);
    `);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: SCAMMER,
      type: 'scam',
      triggers: [
        {
          entityType: 'Comment',
          cleanup: {
            kind: 'commentsV2',
            at: new Date().toISOString(),
            count: 2,
            ids: [60, 61],
            truncated: false,
          },
        },
      ],
    } as never);

    // 61 is someone else's comment under a recorded id: never touched.
    expect(await restoreScamCase(1)).toEqual({ restored: 1 });
    expect(await hidden()).not.toContain(60);
    expect(await hidden()).toContain(61);
  });

  it('restores a v1-era `comments` record on a `Comment` trigger through legacyV1Id', async () => {
    // 62 is the scammer's comment with v1 id 31; 31 is theirs too, a CommentV3 id of that number.
    await pg.exec(`
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, hidden, "legacyV1Id") VALUES
        (62, 'model', 1, ${SCAMMER}, 'v1', true, 31),
        (31, 'model', 1, ${SCAMMER}, 'same number', true, NULL);
    `);
    const record = {
      kind: 'comments',
      at: new Date().toISOString(),
      count: 1,
      ids: [31],
      truncated: false,
    };
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: SCAMMER,
      type: 'scam',
      triggers: [{ entityType: 'Comment', entityId: 31, cleanup: record }],
    } as never);

    expect(await restoreScamCase(1)).toEqual({ restored: 1 });
    expect(await hidden()).toContain(31);
    expect(await hidden()).not.toContain(62);

    // Once the stored-records SQL has mapped it (`migrated`), its ids are CommentV3 ids.
    await pg.exec(`UPDATE "CommentV3" SET hidden = true WHERE id = 62`);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: SCAMMER,
      type: 'scam',
      triggers: [
        { entityType: 'Comment', entityId: 31, cleanup: { ...record, ids: [62], migrated: true } },
      ],
    } as never);
    expect(await restoreScamCase(1)).toEqual({ restored: 1 });
    expect(await hidden()).not.toContain(62);
  });
});
