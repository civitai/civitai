import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

/**
 * The site reads comments from the CommentV3 mirror. A thread detached from a deleted parent keeps
 * its CommentV2 rows for moderators, and its comments leave the mirror with the parent, because each
 * comment topic cascades from its entity row: the site answers for them exactly as for comments the
 * delete cascaded away. These pin that cascade, against the real mirror; a topic type added without
 * one would leave a detached comment readable.
 */

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));

const { detachHeldThreadsCte } = await import('~/server/services/comment-thread-hold');
const { getCommentPermalinkRow } = await import('~/server/utils/comment-permalink');
const { commentDetailFetcher } = await import(
  '~/server/notifications/detail-fetchers/comment.detail-fetcher'
);
const { copyV2Comments } = await import('~/server/services/comment-v3-backfill.service');

const OWNER = 1;
const HELD = 2; // named on a pending report
const OTHER = 3;
const MARKED = 4; // held by a hold marker, whose delete trigger keeps their images

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

const HOLDS = `
ALTER TABLE "User" ADD COLUMN username text;
ALTER TABLE app_listings ADD COLUMN slug text;
ALTER TABLE "Image" ADD COLUMN "userId" int, ADD COLUMN "needsReview" text, ADD COLUMN "blockedFor" text;
CREATE TABLE "CsamReport" (
  id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
  details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
INSERT INTO "EvidenceHold" VALUES (${MARKED});
-- Stands in for the hold marker's delete trigger: a marked owner's image row is kept.
CREATE FUNCTION keep_marked_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN RETURN NULL; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER keep_marked_image BEFORE DELETE ON "Image" FOR EACH ROW EXECUTE FUNCTION keep_marked_image();
`;

// Image 10 (owner 1): comment 1 by OTHER in the root thread; 2 by OTHER replies to it; 3 by HELD
// replies to 2, in a thread whose parent (the thread on 2) is not its root. Image 11: an unheld
// root-only thread, comment 4. Image 12: a held root-only thread, comment 5. Image 13 (owner MARKED):
// comment 6 by HELD.
const COMMENTS = `
UPDATE "Image" SET "userId" = ${OWNER} WHERE id IN (10, 11, 12);
UPDATE "Image" SET "userId" = ${MARKED} WHERE id = 13;
INSERT INTO "Thread" (id, "imageId") VALUES (100, 10);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (1, 'root', ${OTHER}, 100);
INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (101, 1, 100, 100);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (2, 'reply', ${OTHER}, 101);
INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (102, 2, 101, 100);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (3, 'held reply', ${HELD}, 102);
INSERT INTO "Thread" (id, "imageId") VALUES (110, 11);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (4, 'unheld', ${OTHER}, 110);
INSERT INTO "Thread" (id, "imageId") VALUES (120, 12);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (5, 'held root', ${HELD}, 120);
INSERT INTO "Thread" (id, "imageId") VALUES (130, 13);
INSERT INTO "CommentV2" (id, content, "userId", "threadId") VALUES (6, 'on a kept image', ${HELD}, 130);
`;

const db = { pg: null as unknown as PGlite };
const ids = async (table: string) =>
  (await db.pg.query<{ id: number }>(`SELECT id FROM "${table}" ORDER BY id`)).rows.map(
    (r) => r.id
  );

const deleteImages = async () => {
  const sql = Prisma.sql`
    WITH ${detachHeldThreadsCte(
      { imageId: Prisma.sql`SELECT unnest(ARRAY[10, 11, 12, 13])` },
      true
    )}
    DELETE FROM "Image" WHERE id IN (10, 11, 12, 13)`;
  await db.pg.query(sql.text, sql.values as unknown[]);
};

const ctx = {
  db: {
    user: {
      findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((id) => ({ id, username: `u${id}` })),
    },
  },
} as never;
const snippet = async (commentId: number) => {
  const notification = {
    type: 'new-comment-reply',
    details: { version: 2, commentId, threadType: 'image' } as Record<string, unknown>,
  };
  await commentDetailFetcher.fetcher([notification] as never, ctx);
  return notification.details.content;
};

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(FIXTURE);
  await db.pg.exec(HOLDS);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  holder.kysely = new Kysely({ dialect: dialect(db.pg) });
});
afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`BEGIN`);
  await db.pg.exec(COMMENTS);
});
afterEach(async () => {
  await db.pg.exec(`ROLLBACK`);
});

describe('a detached thread leaves the CommentV3 mirror', () => {
  it('mirrors every comment before the delete (positive control)', async () => {
    expect(await ids('CommentV3')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await getCommentPermalinkRow(3)).toBeDefined();
    expect(await getCommentPermalinkRow(4)).toBeDefined();
    expect(await snippet(3)).toBe('held reply');
  });

  it('keeps the detached comments in CommentV2, and drops them from the mirror with the cascaded one', async () => {
    await deleteImages();

    // 1-3 and 5 detached, 4 cascaded with its image, 6 on the image the trigger kept.
    expect(await ids('CommentV2')).toEqual([1, 2, 3, 5, 6]);
    expect(await ids('CommentV3')).toEqual([6]);
  });

  it('answers the permalink of a detached comment exactly as that of a cascaded one', async () => {
    await deleteImages();

    const detached = await getCommentPermalinkRow(3);
    expect(detached).toBeUndefined();
    expect(detached).toEqual(await getCommentPermalinkRow(4));
    expect(await getCommentPermalinkRow(5)).toBeUndefined();
  });

  it('is not copied back into the mirror by the backfill', async () => {
    await deleteImages();
    // A mirrored comment that went missing, which the backfill does restore (control).
    await db.pg.exec(`DELETE FROM "CommentV3" WHERE id = 6`);

    await copyV2Comments(db.pg, { start: 1, end: 10 });

    expect(await ids('CommentV3')).toEqual([6]);
  });

  it('no longer previews a detached comment in a notification', async () => {
    await deleteImages();

    expect(await snippet(3)).toBeUndefined();
    expect(await snippet(5)).toBeUndefined();
  });
});

describe('an image the hold marker trigger keeps', () => {
  it('keeps its thread on it, undetached and mirrored', async () => {
    await deleteImages();

    expect(await ids('Image')).toContain(13);
    const thread = await db.pg.query<{ imageId: number | null; detached: boolean }>(
      `SELECT "imageId", metadata ? 'detachedFrom' AS detached FROM "Thread" WHERE id = 130`
    );
    expect(thread.rows).toEqual([{ imageId: 13, detached: false }]);
    expect(await ids('CommentV3')).toContain(6);
  });
});

describe('every comment topic cascades from its entity', () => {
  it('has an ON DELETE CASCADE entityId key on each partition the schema migration creates', async () => {
    const { rows } = await db.pg.query<{ partition: string; cascades: boolean }>(`
      SELECT c.relname AS partition, EXISTS (
        SELECT 1 FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confdeltype = 'c'
          AND a.attname = 'entityId' AND cardinality(k.conkey) = 1
      ) AS cascades
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = '"CommentTopic"'::regclass ORDER BY 1
    `);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => !r.cascades)).toEqual([]);
  });

  // A later migration adds a partition by name; each must add its cascading key with it.
  const MIGRATIONS = path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations'
  );
  const partitionsWithoutCascade = (sql: string) =>
    [...sql.matchAll(/"(CommentTopic_\w+)" PARTITION OF "CommentTopic"/g)]
      .map((m) => m[1])
      .filter(
        (name) =>
          !new RegExp(
            `ALTER TABLE "${name}"[^;]*FOREIGN KEY \\("entityId"\\) REFERENCES [^;]*ON DELETE CASCADE`
          ).test(sql)
      );

  it('flags a partition added without one (positive control)', () => {
    expect(
      partitionsWithoutCascade(
        `CREATE TABLE "CommentTopic_x" PARTITION OF "CommentTopic" FOR VALUES IN ('x');`
      )
    ).toEqual(['CommentTopic_x']);
  });

  it('finds none in the migrations', () => {
    const named = readdirSync(MIGRATIONS).flatMap((dir) => {
      let sql: string;
      try {
        sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
      } catch {
        return [];
      }
      return partitionsWithoutCascade(sql).map((name) => `${dir}: ${name}`);
    });
    expect(named).toEqual([]);
  });
});
