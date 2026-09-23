import { PGlite } from '@electric-sql/pglite';
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

import {
  getContentOwnerIdForComment,
  threadContentSelect,
} from '~/server/services/block-check.service';
import {
  blockHideCandidatesSql,
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
    -- Already hidden: left as it is.
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
  `);

  dbMock.dbWrite.commentV2.updateMany.mockImplementation((async ({ where }: any) => {
    const { affectedRows } = await holder.db.query(
      `UPDATE "CommentV2" SET hidden = true WHERE id = ANY($1) AND "userId" = $2 AND hidden IS NOT TRUE`,
      [where.id.in, where.userId]
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
    // 1004 was already hidden. Everything on OTHER_OWNER's image (3001, and 3003 despite its forged
    // root), the bystander's comment 1002 and the orphaned 8001 stay visible.
    expect(await hiddenIds()).toEqual([1001, 1003, 1004, 5001, 6001, 7001]);
  });

  it("leaves other people's content alone when they are not the blocker", async () => {
    await hideBlockedUserCommentsOnOwnContent({ ownerId: OTHER_OWNER, blockedUserId: BLOCKED });

    expect(await hiddenIds()).toEqual([1004, 3001, 3003]);
  });

  it('stops at the row ceiling', async () => {
    const { rows } = await holder.db.query<{ id: number }>(blockHideCandidatesSql, [
      BLOCKED,
      BLOCKER,
      2,
    ]);

    expect(rows.map((r) => r.id)).toEqual([1001, 1003]);
  });

  it('reports failure instead of throwing when a write fails', async () => {
    dbMock.dbWrite.commentV2.updateMany.mockRejectedValue(new Error('canceling statement'));

    await expect(
      hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED })
    ).resolves.toEqual({ status: 'failed', count: 0 });
  });
});

describe('THREAD_CONTENT_OWNERS', () => {
  it("names every owner-bearing Thread column, in threadContentSelect's order", () => {
    const ownerColumns = Object.keys(threadContentSelect).filter(
      (key) => key !== 'rootThreadId' && key !== 'comicChapterPosition'
    );

    expect(THREAD_CONTENT_OWNERS.map((o) => o.column)).toEqual(ownerColumns);
  });
});

// The SQL map restates ownerOfThreadContent, so each entry is checked against what the TS resolver
// actually reads for a thread carrying only that column: the same model, key and owner field.
describe('THREAD_CONTENT_OWNERS agrees with getContentOwnerIdForComment', () => {
  const unquote = (sql: string) => sql.replace(/"/g, '');
  const camel = (sql: string) => unquote(sql).replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const delegateOf = (table: string) =>
    table === 'app_listings'
      ? 'appListing'
      : unquote(table)[0].toLowerCase() + unquote(table).slice(1);

  it.each(THREAD_CONTENT_OWNERS.map((o) => [o.column, o] as const))('%s', async (column, entry) => {
    const read = dbMock.dbRead as any;
    const delegate = delegateOf(entry.table);
    const ownerField = camel(entry.owner);
    const keyField = camel(entry.key);

    read.commentV2.findUnique.mockResolvedValue({ hidden: false, threadId: 1 });
    read.$queryRaw.mockResolvedValue([{ id: 2 }]);
    read.thread.findUnique.mockResolvedValue({
      ...Object.fromEntries(Object.keys(threadContentSelect).map((key) => [key, null])),
      [column]: 555,
    });
    read[delegate].findUnique.mockResolvedValue({ [ownerField]: 777 });

    const { ownerId } = await getContentOwnerIdForComment(1);

    expect(read[delegate].findUnique).toHaveBeenCalledWith({
      where: { [keyField]: 555 },
      select: { [ownerField]: true },
    });
    expect(ownerId).toBe(777);
  });
});
