import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000 });

/** A post with songs publishes only when every song has a genre: the post and songs in PGlite. */

vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  userPostCountCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntityInBackground: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

const { updatePost } = await import('~/server/services/post.service');

const OWNER = 10;
const POST = 5;
const owner = { id: OWNER, isModerator: false } as SessionUser;
const pg = { db: null as unknown as PGlite };

const publishedAt = async () =>
  (
    await pg.db.query<{ publishedAt: Date | null }>(
      `SELECT "publishedAt" FROM "Post" WHERE id = $1`,
      [POST]
    )
  ).rows[0].publishedAt;

/** An image of the post; a `genre` goes in the song's Track row, the rest in its metadata. */
async function addImage(id: number, type: string, { genre, ...metadata }: { genre?: string }) {
  await pg.db.query(`INSERT INTO "Image" (id, "postId", type, metadata) VALUES ($1, $2, $3, $4)`, [
    id,
    POST,
    type,
    metadata,
  ]);
  if (genre !== undefined)
    await pg.db.query(`INSERT INTO "Track" ("imageId", genre) VALUES ($1, $2)`, [id, genre]);
}

beforeAll(async () => {
  pg.db = await PGlite.create();
  await pg.db.exec(`
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp(3), metadata jsonb, title text
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, type text NOT NULL, metadata jsonb);
    CREATE TABLE "Track" ("imageId" int PRIMARY KEY, "coverImageId" int, genre text);
    -- The publish refuses a post on a version a moderator took down; this post is on none.
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL, "userId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL);
  `);
});
afterAll(async () => {
  await pg.db.close();
});

beforeEach(async () => {
  await pg.db.exec(`TRUNCATE "Post"; TRUNCATE "Image"; TRUNCATE "Track";`);
  await pg.db.query(`INSERT INTO "Post" (id, "userId") VALUES ($1, $2)`, [POST, OWNER]);
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...(values as never[]));
    return pg.db.query(q.text, q.values as unknown[]);
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn(dbMock.dbWrite)) as never);
  dbMock.dbWrite.post.update.mockImplementation((async ({ data }: { data: { title?: string } }) => {
    if (data.title !== undefined)
      await pg.db.query(`UPDATE "Post" SET title = $1 WHERE id = $2`, [data.title, POST]);
    return { id: POST, userId: OWNER, publishedAt: null };
  }) as never);
  // The genre check's read; the publish's later image reads find nothing to do.
  dbMock.dbWrite.image.findMany.mockImplementation((async ({
    where,
  }: {
    where: { postId?: unknown; type?: string };
  }) =>
    where.type === 'audio' && where.postId === POST
      ? (
          await pg.db.query(
            `SELECT (SELECT json_build_object('genre', t.genre) FROM "Track" t WHERE t."imageId" = i.id) AS track
             FROM "Image" i WHERE i."postId" = $1 AND i.type = 'audio'`,
            [POST]
          )
        ).rows
      : []) as never);
  dbMock.dbWrite.post.findUnique.mockImplementation(
    (async () =>
      (await pg.db.query(`SELECT "publishedAt" FROM "Post" WHERE id = $1`, [POST])).rows[0] ??
      null) as never
  );
});

const publish = () => updatePost({ id: POST, user: owner, publishedAt: new Date() });

describe('publishing a post with songs', () => {
  it('is refused while a song has no genre', async () => {
    await addImage(1, 'audio', { title: 'With genre', genre: 'Pop' });
    await addImage(2, 'audio', { title: 'Without' });

    await expect(publish()).rejects.toThrow('Pick a genre to publish');
    expect(await publishedAt()).toBeNull();
  });

  it('goes through when every song has a genre', async () => {
    await addImage(1, 'audio', { genre: 'Pop' });
    await addImage(2, 'audio', { genre: 'Jazz' });
    await addImage(3, 'image', {});

    await publish();
    expect(await publishedAt()).not.toBeNull();
  });

  it('leaves a post without songs as it was', async () => {
    await addImage(3, 'image', {});

    await publish();
    expect(await publishedAt()).not.toBeNull();
  });

  it('refuses a genre that is not on the list', async () => {
    await addImage(1, 'audio', { genre: 'Polka' });

    await expect(publish()).rejects.toThrow('Pick a genre to publish');
  });

  it('refuses rescheduling a scheduled post while a song has no genre', async () => {
    await pg.db.query(`UPDATE "Post" SET "publishedAt" = now() + interval '1 day' WHERE id = $1`, [
      POST,
    ]);
    await addImage(2, 'audio', {});

    await expect(
      updatePost({ id: POST, user: owner, publishedAt: new Date(Date.now() + 2 * 86_400_000) })
    ).rejects.toThrow('Pick a genre to publish');
  });

  it('lets a post already public through, whatever its songs', async () => {
    await pg.db.query(`UPDATE "Post" SET "publishedAt" = now() - interval '1 day' WHERE id = $1`, [
      POST,
    ]);
    await addImage(2, 'audio', {});

    await expect(publish()).resolves.toBeDefined();
  });

  it('leaves a draft save alone', async () => {
    await addImage(2, 'audio', {});

    await updatePost({ id: POST, user: owner, title: 'Draft title' });
    const { rows } = await pg.db.query<{ title: string }>(`SELECT title FROM "Post"`);
    expect(rows[0].title).toBe('Draft title');
    expect(await publishedAt()).toBeNull();
  });
});
