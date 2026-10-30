import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

// The scam cleanup's `commentsV2` kind against real Postgres with the production mirror: which
// comments a mute hides across CommentV2 and CommentV3, and which the overturn brings back.

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const { restoreScamCase, runScamCleanup } = await import('~/server/services/scam-cleanup.service');

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(migration('20261120120000_comment_v3_mirror'));
  await pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));

  const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
    Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const sql = toSql(first, values);
    const { rows } = await pg.query(sql.text, sql.values as unknown[]);
    v2Writes.push({ sql: sql.text, rows: (rows as { id: number }[]).map((r) => r.id) });
    return rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const sql = toSql(first, values);
    const affected = (await pg.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
    v2Writes.push({ sql: sql.text, rows: affected });
    return affected;
  }) as never);
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation(
    (async (sql: string, ...params: unknown[]) => (await pg.query(sql, params)).rows) as never
  );
});
afterAll(async () => {
  await pg.close();
});

// What each tagged statement touched, to tell which one wrote a row.
let v2Writes: { sql: string; rows: number[] | number }[] = [];
const oldTableWrite = () => v2Writes.find((w) => w.sql.includes('UPDATE "CommentV2"'))?.rows;

const SCAMMER = 5;
const OTHER = 6;

// Article 1. 41-44 are the scammer's: 41 written to CommentV3 only, 42 written to CommentV2 before
// the flip (mirrored), 43 already hidden, 44 deleted. 45 is someone else's. 50 is the scammer's
// image comment, on CommentV2 (mirrored, and not a CommentV3-write surface); 51 an image comment
// with no CommentV2 row, which only the CommentV2 arm could reach, so it stays.
beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "CommentV2"; DELETE FROM "CommentV3"; DELETE FROM "Thread"; DELETE FROM "CommentTopic";
    INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 1), ('image', 10);
    INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, hidden, "deletedAt") VALUES
      (41, 'article', 1, ${SCAMMER}, 'v3 only', false, NULL),
      (43, 'article', 1, ${SCAMMER}, 'hidden already', true, NULL),
      (44, 'article', 1, ${SCAMMER}, '', false, now()),
      (45, 'article', 1, ${OTHER}, 'someone else', false, NULL),
      (51, 'image', 10, ${SCAMMER}, 'not a CommentV3-write surface', false, NULL);
    INSERT INTO "Thread"(id, "articleId") VALUES (900, 1);
    INSERT INTO "Thread"(id, "imageId") VALUES (901, 10);
    INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES
      (42, 'from v2', ${SCAMMER}, 900), (50, 'image', ${SCAMMER}, 901);
  `);
});

const hidden = async (table: 'CommentV2' | 'CommentV3') =>
  (await pg.query<{ id: number }>(`SELECT id FROM "${table}" WHERE hidden ORDER BY id`)).rows.map(
    (r) => r.id
  );

describe('scam cleanup of comments', () => {
  beforeEach(() => {
    v2Writes = [];
  });

  it('hides the scammer’s live comments in both tables, each id once, and nobody else’s', async () => {
    const record = await runScamCleanup('commentsV2', SCAMMER);
    expect(record).toMatchObject({ kind: 'commentsV2', count: 3, truncated: false });
    expect([...(record?.ids ?? [])].sort()).toEqual([41, 42, 50]);
    expect(await hidden('CommentV2')).toEqual([42, 50]);
    // 42 through the mirror and the CommentV3 arm alike; the deleted 44 and the other user's 45 stay.
    expect(await hidden('CommentV3')).toEqual([41, 42, 43, 50]);
    // 42 is written CommentV3 first, as every write on its surface is; the CommentV2 statement
    // takes only the image comment.
    expect(oldTableWrite()).toEqual([50]);
  });

  it('brings back exactly what it hid when the mute is overturned', async () => {
    const record = await runScamCleanup('commentsV2', SCAMMER);
    // A comment of someone else's under a recorded id is never touched.
    await pg.exec(`UPDATE "CommentV3" SET hidden = true WHERE id = 45`);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: SCAMMER,
      type: 'scam',
      triggers: [{ cleanup: { ...record, ids: [...(record?.ids ?? []), 45] } }],
    } as never);

    v2Writes = [];
    expect(await restoreScamCase(1)).toEqual({ restored: 3 });
    expect(oldTableWrite()).toBe(1);
    expect(await hidden('CommentV2')).toEqual([]);
    // 43 was hidden before the cleanup and is not in the record.
    expect(await hidden('CommentV3')).toEqual([43, 45]);
  });
});
