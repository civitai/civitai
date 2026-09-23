import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Runs the real bulk-hide SQL against an in-process Postgres, because the rule that matters —
 * only comments on the BLOCKER's content, resolved through the stored thread chain — lives in the
 * WHERE clause, where a mocked query cannot see it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbWrite: {},
  pgDbRead: {
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => holder.db.query(sql, params),
      release: () => undefined,
    }),
  },
}));

import { MAX_THREAD_CHAIN_DEPTH, threadIsRooted } from '~/server/common/thread-chain';
import {
  getContentOwnerIdForComment,
  threadContentSelect,
} from '~/server/services/block-check.service';
import {
  BLOCK_HIDE_MAX_COMMENTS,
  hideBlockedUserCommentsOnOwnContent,
  THREAD_CONTENT_OWNERS,
} from '~/server/services/block-hide-comments.service';

const BLOCKER = 1;
const BLOCKED = 2;
const OTHER_OWNER = 3;
const BYSTANDER = 4;

const ownerTables = THREAD_CONTENT_OWNERS.map(
  ({ table, owner, key }) => `CREATE TABLE ${table} (${key} int PRIMARY KEY, ${owner} int);`
).join('\n');

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${ownerTables}
    CREATE TABLE "Thread" (
      id int PRIMARY KEY, "commentId" int, "rootThreadId" int, "comicChapterPosition" int,
      ${THREAD_CONTENT_OWNERS.map(({ column }) => `"${column}" int`).join(', ')}
    );
    CREATE TABLE "CommentV2" (id int PRIMARY KEY, "userId" int, "threadId" int, hidden boolean);
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "Thread", "CommentV2", "Image", "Article", "Challenge", app_listings;
    INSERT INTO "Image" (id, "userId") VALUES (10, ${BLOCKER}), (20, ${OTHER_OWNER});
    INSERT INTO "Article" (id, "userId") VALUES (30, ${BLOCKER});
    INSERT INTO "Challenge" (id, "createdById") VALUES (40, ${BLOCKER});
    INSERT INTO app_listings (serial_id, user_id) VALUES (50, ${BLOCKER});

    INSERT INTO "Thread" (id, "imageId") VALUES (100, 10);
    INSERT INTO "Thread" (id, "imageId") VALUES (300, 20);
    INSERT INTO "Thread" (id, "articleId") VALUES (500, 30);
    INSERT INTO "Thread" (id, "challengeId") VALUES (600, 40);
    INSERT INTO "Thread" (id, "appListingId") VALUES (700, 50);

    -- On the blocker's image: a top-level comment, and a reply one level down.
    INSERT INTO "CommentV2" VALUES (1001, ${BLOCKED}, 100, false);
    INSERT INTO "CommentV2" VALUES (1002, ${BYSTANDER}, 100, false);
    INSERT INTO "Thread" (id, "commentId", "rootThreadId") VALUES (200, 1002, 100);
    INSERT INTO "CommentV2" VALUES (1003, ${BLOCKED}, 200, null);
    -- Already hidden: left as it is, and not counted.
    INSERT INTO "CommentV2" VALUES (1004, ${BLOCKED}, 100, true);

    -- On someone else's image, including a reply whose client-written root points at the
    -- blocker's thread. The stored chain says it belongs to OTHER_OWNER.
    INSERT INTO "CommentV2" VALUES (3001, ${BLOCKED}, 300, false);
    INSERT INTO "CommentV2" VALUES (3002, ${BYSTANDER}, 300, false);
    INSERT INTO "Thread" (id, "commentId", "rootThreadId") VALUES (400, 3002, 100);
    INSERT INTO "CommentV2" VALUES (3003, ${BLOCKED}, 400, false);

    -- The blocker's other content types, including the two with odd owner columns.
    INSERT INTO "CommentV2" VALUES (5001, ${BLOCKED}, 500, false);
    INSERT INTO "CommentV2" VALUES (6001, ${BLOCKED}, 600, false);
    INSERT INTO "CommentV2" VALUES (7001, ${BLOCKED}, 700, false);

    -- A reply thread whose parent comment is gone: the chain ends on no content.
    INSERT INTO "Thread" (id, "commentId", "rootThreadId") VALUES (800, 9999, 100);
    INSERT INTO "CommentV2" VALUES (8001, ${BLOCKED}, 800, false);

    -- Two owner columns on one thread: the image comes first, so it is OTHER_OWNER's.
    INSERT INTO "Thread" (id, "imageId", "articleId") VALUES (900, 20, 30);
    INSERT INTO "CommentV2" VALUES (9001, ${BLOCKED}, 900, false);
  `);

  // Translates exactly the call the service makes and refuses anything else, so a change to the
  // WHERE or the data cannot be absorbed by the fake.
  dbMock.dbWrite.commentV2.updateMany.mockReset();
  dbMock.dbWrite.commentV2.updateMany.mockImplementation((async ({ where, data, ...rest }: any) => {
    if (Object.keys(rest).length || Object.keys(where).sort().join() !== 'id,userId')
      throw new Error(`untranslated updateMany args: ${JSON.stringify({ where, rest })}`);
    if (Object.keys(data).join() !== 'hidden')
      throw new Error(`untranslated updateMany data: ${JSON.stringify(data)}`);
    const { affectedRows } = await holder.db.query(
      `UPDATE "CommentV2" SET hidden = $3 WHERE id = ANY($1) AND "userId" = $2`,
      [where.id.in, where.userId, data.hidden]
    );
    return { count: affectedRows ?? 0 };
  }) as any);
});

const hiddenIds = async () =>
  (
    await holder.db.query<{ id: number }>(
      `SELECT id FROM "CommentV2" WHERE hidden IS TRUE ORDER BY id`
    )
  ).rows.map((r) => r.id);

describe('hideBlockedUserCommentsOnOwnContent', () => {
  it("hides exactly the blocked user's comments on the blocker's content", async () => {
    const result = await hideBlockedUserCommentsOnOwnContent({
      ownerId: BLOCKER,
      blockedUserId: BLOCKED,
    });

    expect(result).toEqual({ status: 'hidden', count: 5, capped: false });
    // 1004 was already hidden. Everything on OTHER_OWNER's image (3001, 3003 despite its forged
    // root, and 9001), the bystander's comment 1002 and the orphaned 8001 stay visible.
    expect(await hiddenIds()).toEqual([1001, 1003, 1004, 5001, 6001, 7001]);
  });

  it("leaves other people's content alone when they are not the blocker", async () => {
    await hideBlockedUserCommentsOnOwnContent({ ownerId: OTHER_OWNER, blockedUserId: BLOCKED });

    expect(await hiddenIds()).toEqual([1004, 3001, 3003, 9001]);
  });

  it('stops at the row ceiling, in batches, and says so', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV2"
      SELECT g, ${BLOCKED}, 100, false FROM generate_series(20000, 20000 + ${BLOCK_HIDE_MAX_COMMENTS}) g;
    `);

    const result = await hideBlockedUserCommentsOnOwnContent({
      ownerId: BLOCKER,
      blockedUserId: BLOCKED,
    });

    expect(result).toEqual({ status: 'hidden', count: BLOCK_HIDE_MAX_COMMENTS, capped: true });
    expect(dbMock.dbWrite.commentV2.updateMany).toHaveBeenCalledTimes(10);
    // The ceiling's worth plus the one already hidden.
    const { rows } = await holder.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM "CommentV2" WHERE "userId" = ${BLOCKED} AND hidden IS TRUE`
    );
    expect(rows[0].n).toBe(BLOCK_HIDE_MAX_COMMENTS + 1);
  });

  it('resolves a chain up to the depth cap and no further', async () => {
    // Thread 10000+d hangs off a bystander comment in the thread below it, down to image 10.
    const inserts: string[] = [];
    for (let depth = 1; depth <= MAX_THREAD_CHAIN_DEPTH + 1; depth++) {
      const below = depth === 1 ? 100 : 10000 + depth - 1;
      inserts.push(
        `INSERT INTO "CommentV2" VALUES (${40000 + depth}, ${BYSTANDER}, ${below}, false);`
      );
      inserts.push(
        `INSERT INTO "Thread" (id, "commentId") VALUES (${10000 + depth}, ${40000 + depth});`
      );
    }
    await holder.db.exec(`
      ${inserts.join('\n')}
      INSERT INTO "CommentV2" VALUES (50100, ${BLOCKED}, ${10000 + MAX_THREAD_CHAIN_DEPTH}, false);
      INSERT INTO "CommentV2" VALUES (50101, ${BLOCKED}, ${
      10000 + MAX_THREAD_CHAIN_DEPTH + 1
    }, false);
    `);

    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });

    const hidden = await hiddenIds();
    expect(hidden).toContain(50100);
    expect(hidden).not.toContain(50101);
  });

  it('reports the rows already hidden when a later batch fails', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV2"
      SELECT g, ${BLOCKED}, 100, false FROM generate_series(20000, 22999) g;
    `);
    const translate = dbMock.dbWrite.commentV2.updateMany.getMockImplementation()!;
    dbMock.dbWrite.commentV2.updateMany
      .mockImplementationOnce(translate)
      .mockImplementationOnce(translate)
      .mockRejectedValueOnce(new Error('canceling statement'));

    await expect(
      hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED })
    ).resolves.toEqual({ status: 'failed', count: 2000 });
  });

  it('reports failure instead of throwing when a write fails', async () => {
    dbMock.dbWrite.commentV2.updateMany.mockRejectedValue(new Error('canceling statement'));

    await expect(
      hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED })
    ).resolves.toEqual({ status: 'failed', count: 0 });
  });
});

describe('THREAD_CONTENT_OWNERS', () => {
  it('names every owner-bearing column threadContentSelect lists', () => {
    const ownerColumns = Object.keys(threadContentSelect).filter(
      (key) => key !== 'comicChapterPosition'
    );

    expect(THREAD_CONTENT_OWNERS.map((o) => o.column)).toEqual(ownerColumns);
  });

  // A new owner-bearing FK on Thread must land here or be named as exempt. clubPostId has no
  // owner lookup anywhere, so its threads resolve no owner and are never bulk-hidden.
  it('covers every Thread foreign key that is not a chain link', () => {
    const exempt = ['commentId', 'parentThreadId', 'rootThreadId', 'clubPostId'];
    const thread = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Thread');
    const foreignKeys = thread?.fields
      .filter((f) => f.kind === 'scalar' && f.name.endsWith('Id') && !exempt.includes(f.name))
      .map((f) => f.name)
      .sort();

    expect(foreignKeys).toEqual(THREAD_CONTENT_OWNERS.map((o) => o.column).sort());
  });

  it('counts as a content root exactly what it maps to an owner, plus the ownerless clubPostId', () => {
    const rooted = [...threadIsRooted('t').sql.matchAll(/t\."(\w+)"/g)].map((m) => m[1]).sort();

    expect(rooted).toEqual([...THREAD_CONTENT_OWNERS.map((o) => o.column), 'clubPostId'].sort());
  });

  it.each(THREAD_CONTENT_OWNERS.map((o) => [o.column, o] as const))(
    '%s names a real table, owner column and key',
    (_, { table, owner, key }) => {
      const dbName = (x: { name: string; dbName?: string | null }) => x.dbName ?? x.name;
      const model = Prisma.dmmf.datamodel.models.find((m) => dbName(m) === table.replace(/"/g, ''));
      const columns = model?.fields.filter((f) => f.kind === 'scalar').map(dbName);

      expect(columns).toContain(owner.replace(/"/g, ''));
      expect(columns).toContain(key.replace(/"/g, ''));
    }
  );
});

// The SQL map restates ownerOfThreadContent. Each entry is checked against what the TS resolver
// reads for a thread carrying that column AND every later one, which pins the model, key, owner
// field and first-match precedence together.
describe('THREAD_CONTENT_OWNERS agrees with getContentOwnerIdForComment', () => {
  const unquote = (sql: string) => sql.replace(/"/g, '');
  const camel = (sql: string) => unquote(sql).replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const delegateOf = (table: string) =>
    table === 'app_listings'
      ? 'appListing'
      : unquote(table)[0].toLowerCase() + unquote(table).slice(1);

  it.each(THREAD_CONTENT_OWNERS.map((o, i) => [o.column, i] as const))('%s', async (_, i) => {
    const read = dbMock.dbRead as any;
    const entry = THREAD_CONTENT_OWNERS[i];

    read.commentV2.findUnique.mockResolvedValue({ hidden: false, threadId: 1 });
    read.$queryRaw.mockResolvedValue([{ id: 2, rooted: true }]);
    read.thread.findUnique.mockResolvedValue({
      ...Object.fromEntries(Object.keys(threadContentSelect).map((key) => [key, null])),
      ...Object.fromEntries(THREAD_CONTENT_OWNERS.slice(i).map((o) => [o.column, 555])),
    });
    for (const other of THREAD_CONTENT_OWNERS) {
      const finder = read[delegateOf(other.table)].findUnique;
      finder.mockClear();
      finder.mockResolvedValue({ [camel(other.owner)]: other === entry ? 777 : 888 });
    }

    const { ownerId } = await getContentOwnerIdForComment(1);

    expect(read[delegateOf(entry.table)].findUnique).toHaveBeenCalledWith({
      where: { [camel(entry.key)]: 555 },
      select: { [camel(entry.owner)]: true },
    });
    expect(ownerId).toBe(777);
  });
});
