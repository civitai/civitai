import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The tag-vote job on PGlite: votes, tags, songs and the image tag rows are real rows, and the
 * job's own writer runs. A song's genre tag mirrors its owner's genre, so votes never attach one
 * to a song.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const pg = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: { query: (text: string, values?: unknown[]) => pg.db.query(text, values) },
}));

import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { constants } from '~/server/common/constants';

const SONG = 7;
const PICTURE = 8;
const POP = 11;
const CHILL = 12;

const tagRows = async (imageId: number) =>
  (
    await pg.db.query<{ tagId: number }>(
      `SELECT "tagId" FROM "TagsOnImageDetails" WHERE "imageId" = $1 ORDER BY "tagId"`,
      [imageId]
    )
  ).rows.map((r) => r.tagId);

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "TagSource" AS ENUM ('User', 'WD14', 'Computed');
    CREATE TABLE "Image" (id int PRIMARY KEY, type text NOT NULL);
    CREATE TABLE "Tag" (id int PRIMARY KEY, name text NOT NULL, type text NOT NULL DEFAULT 'UserGenerated');
    CREATE TABLE "TagsOnTags" ("fromTagId" int, "toTagId" int, type text, "createdAt" timestamp);
    CREATE TABLE "TagsOnImageVote" (
      "userId" int NOT NULL, "tagId" int NOT NULL, "imageId" int NOT NULL, vote int NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(), applied boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source "TagSource",
      automated boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
      "needsReview" boolean NOT NULL DEFAULT false, PRIMARY KEY ("imageId", "tagId")
    );
    -- The database's insert-only tag writer, reduced to the row it inserts.
    CREATE FUNCTION insert_tag_on_image(int, int, "TagSource", int, boolean, boolean, boolean)
    RETURNS void AS $$
      INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", source)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    $$ LANGUAGE sql;
    -- The database's IIF, which the job's downvote read calls.
    CREATE FUNCTION iif(boolean, int, int) RETURNS int AS $$
      SELECT CASE WHEN $1 THEN $2 ELSE $3 END
    $$ LANGUAGE sql;
  `);
  const INT4_OID = 23;
  const TIMESTAMPTZ_OID = 1184;
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    // A date is bound as a timestamp: the downvote read subtracts an interval from it.
    const paramTypes = sql.values.map((v) =>
      Number.isInteger(v) ? INT4_OID : v instanceof Date ? TIMESTAMPTZ_OID : 0
    );
    return (await pg.db.query(sql.text, sql.values, { paramTypes })).rows;
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(run as never);
  // The job's last-run marker (`getJobDate`): read as never run, then stored.
  dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.keyValue.upsert.mockResolvedValue({} as never);
});
afterAll(() => pg.db.close());

beforeEach(async () => {
  await pg.db.exec(`
    TRUNCATE "Image", "Tag", "TagsOnImageVote", "TagsOnImageDetails";
    INSERT INTO "Image" VALUES (${SONG}, 'audio'), (${PICTURE}, 'image');
    INSERT INTO "Tag" (id, name) VALUES (${POP}, 'pop'), (${CHILL}, 'chill');
  `);
});

/** Votes over the threshold for `tagId` on `imageId`. */
const upvote = (imageId: number, tagId: number) =>
  pg.db.query(
    `INSERT INTO "TagsOnImageVote" ("userId", "tagId", "imageId", vote) VALUES (1, $1, $2, $3)`,
    [tagId, imageId, constants.tagVoting.upvoteThreshold]
  );

describe('applyVotedTags on songs', () => {
  it("never attaches a genre's tag to a song, and still applies the song's other voted tags", async () => {
    await upvote(SONG, POP);
    await upvote(SONG, CHILL);

    await applyVotedTags.run({}).result;

    expect(await tagRows(SONG)).toEqual([CHILL]);
  });

  it('applies a voted genre-named tag to an image that is not a song', async () => {
    await upvote(PICTURE, POP);

    await applyVotedTags.run({}).result;

    expect(await tagRows(PICTURE)).toEqual([POP]);
  });
});
