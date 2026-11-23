import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Caches from '~/server/redis/caches';

/**
 * Tag votes on PGlite: the images, tags and vote rows are real rows. A song's genre tag mirrors
 * its owner's genre, so a vote on one is not kept; the vote job would otherwise attach it.
 */

vi.setConfig({ hookTimeout: 60_000 });

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return { ...actual, imageTagsCache: { ...actual.imageTagsCache, bust: vi.fn() } };
});

import { addTagVotes } from '~/server/services/tag.service';

const VOTER = 3;
const IMAGE = 7;
const POP = 11;
const CHILL = 12;

let db: PGlite;

const votedTagIds = async () =>
  (
    await db.query<{ tagId: number }>(
      `SELECT "tagId" FROM "TagsOnImageVote" WHERE "imageId" = $1 ORDER BY "tagId"`,
      [IMAGE]
    )
  ).rows.map((r) => r.tagId);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, type text NOT NULL);
    CREATE TABLE "Tag" (id int PRIMARY KEY, name text NOT NULL, type text NOT NULL DEFAULT 'UserGenerated');
    CREATE TABLE "TagsOnImageVote" (
      "userId" int NOT NULL, "tagId" int NOT NULL, "imageId" int NOT NULL, vote int NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(), UNIQUE ("userId", "tagId", "imageId")
    );
  `);
  // `addTagVotes` hands both clients a built Prisma.Sql.
  const run = async (sql: Prisma.Sql) => db.query(sql.text, sql.values);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (sql: Prisma.Sql) => (await run(sql)).affectedRows ?? 0) as never
  );
  dbMock.dbRead.$queryRaw.mockImplementation(
    (async (sql: Prisma.Sql) => (await run(sql)).rows) as never
  );
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Image", "Tag", "TagsOnImageVote";
    INSERT INTO "Tag" (id, name) VALUES (${POP}, 'pop'), (${CHILL}, 'chill');
  `);
});

const onA = (type: 'audio' | 'image') =>
  db.query(`INSERT INTO "Image" (id, type) VALUES ($1, $2)`, [IMAGE, type]);

describe('addTagVotes', () => {
  it.each([
    ['by name', ['pop', 'chill']],
    ['by id', [POP, CHILL]],
  ])(
    "keeps no vote on a genre's tag for a song, voted %s, and keeps the others",
    async (_, tags) => {
      await onA('audio');

      await addTagVotes({ userId: VOTER, type: 'image', id: IMAGE, tags: tags as never, vote: 1 });

      expect(await votedTagIds()).toEqual([CHILL]);
    }
  );

  it('keeps a vote on a genre-named tag for an image that is not a song', async () => {
    await onA('image');

    await addTagVotes({ userId: VOTER, type: 'image', id: IMAGE, tags: ['pop'], vote: 1 });

    expect(await votedTagIds()).toEqual([POP]);
  });
});
