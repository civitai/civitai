import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { rateSong, songOfCover } from '~/server/services/audio-scan/song-rating';

/**
 * A song's level is the highest of PG, its text scan, its lyrics profanity and its own cover, and a
 * re-rate only raises it (docs/features/music.md "A song's rating").
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SCHEMA = `
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending','Scanned','Error','Blocked','NotFound','PendingManualAssignment','Rescan');
  CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending','Succeeded','Failed','Expired','Canceled');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, type "MediaType" NOT NULL DEFAULT 'image',
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "nsfwLevel" int NOT NULL DEFAULT 1,
    "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "blockedFor" text, metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3)
  );
  CREATE TABLE "Track" ("imageId" int PRIMARY KEY, "coverImageId" int UNIQUE, genre text);
  CREATE TABLE "EntityModeration" (
    id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
    status "EntityModerationStatus" NOT NULL DEFAULT 'Succeeded', "nsfwLevel" int, result jsonb,
    UNIQUE ("entityType", "entityId")
  );
`;

const OWNER = 7;
const SONG = 20;
const COVER = 120;
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const BLOCKED = 32;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;
const q = (sql: string) => h.pg.exec(sql);
const level = async (id = SONG) =>
  (await h.pg.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Image" WHERE id = ${id}`))
    .rows[0]?.nsfwLevel;

const onRated = vi.fn(async (nsfwLevel: number) => void nsfwLevel);
const rate = () => rateSong(SONG, onRated);

/** Inserts the song, Scanned at PG, then applies `set` to its row. */
const song = async (set?: string) => {
  await q(`INSERT INTO "Image" (id, "userId", type) VALUES (${SONG}, ${OWNER}, 'audio')`);
  if (set) await q(`UPDATE "Image" SET ${set} WHERE id = ${SONG}`);
};
const lyricsVerdict = (nsfwLevel: number, result = `'{"version":1}'`) =>
  q(`INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel", result)
     VALUES ('TrackLyrics', ${SONG}, ${nsfwLevel}, ${result})`);
const languageVerdict = (nsfwLevel: number | null) =>
  q(`INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel")
     VALUES ('TrackLyricsLanguage', ${SONG}, ${nsfwLevel})`);
const cover = async (nsfwLevel: number, set?: string) => {
  await q(`INSERT INTO "Image" (id, "userId", "nsfwLevel") VALUES (${COVER}, ${OWNER}, ${nsfwLevel});
     INSERT INTO "Track" ("imageId", "coverImageId") VALUES (${SONG}, ${COVER})`);
  if (set) await q(`UPDATE "Image" SET ${set} WHERE id = ${COVER}`);
};

beforeAll(async () => {
  h = await startPglitePrisma(SCHEMA);
});
afterAll(async () => {
  await h?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await q(`TRUNCATE "Image", "Track", "EntityModeration"`);
  const prisma = h.prisma as unknown as Record<
    string,
    Record<string, (...a: unknown[]) => unknown>
  >;
  const mock = dbMock.dbWrite as unknown as Record<
    string,
    Record<string, ReturnType<typeof vi.fn>>
  >;
  for (const [model, methods] of Object.entries({
    image: ['findUnique', 'updateMany'],
    track: ['findUnique'],
    entityModeration: ['findMany'],
  }))
    for (const method of methods)
      mock[model][method].mockImplementation((...args: unknown[]) =>
        prisma[model][method](...args)
      );
});

describe('a decided song', () => {
  it('takes its lyrics text-scan level', async () => {
    await song();
    await lyricsVerdict(R);

    expect(await rate()).toBe(R);
    expect(await level()).toBe(R);
    expect(onRated).toHaveBeenCalledWith(R);
  });

  it('is not rated by an XGuard verdict, which carries no result version', async () => {
    await song();
    await lyricsVerdict(R, `'{"blocked":false}'`);

    expect(await rate()).toBeNull();
    expect(await level()).toBe(PG);
    expect(onRated).not.toHaveBeenCalled();
  });

  it('takes the highest of its lyrics, their language and its cover', async () => {
    await song();
    await lyricsVerdict(PG13);
    await languageVerdict(R);
    await cover(X);

    expect(await rate()).toBe(X);
    expect(await level()).toBe(X);
  });

  it("is not raised by another user's image, or one in a post, linked as its cover", async () => {
    await song();
    await cover(X, `"userId" = 99`);
    expect(await rate()).toBeNull();

    await q(`UPDATE "Image" SET "userId" = ${OWNER}, "postId" = 5 WHERE id = ${COVER}`);
    expect(await rate()).toBeNull();
    expect(await level()).toBe(PG);
  });

  it('is not raised by a blocked cover, or one still being scanned', async () => {
    await song();
    await cover(R, `"blockedFor" = 'tos'`);
    expect(await rate()).toBeNull();

    await q(`UPDATE "Image" SET "blockedFor" = NULL, ingestion = 'Pending' WHERE id = ${COVER}`);
    expect(await rate()).toBeNull();
    expect(await level()).toBe(PG);
  });

  // An owner's own raise is applied unlocked; a re-rate (a title save, a new cover) must keep it.
  it('is never lowered by a re-rate, so an owner raise stands', async () => {
    await song(`"nsfwLevel" = ${X}`);
    await languageVerdict(PG13);

    expect(await rate()).toBeNull();
    expect(await level()).toBe(X);
    expect(onRated).not.toHaveBeenCalled();
  });

  // Two re-rates racing: the one whose write finds the level changed reads again, so the end
  // state counts every input present at its last attempt.
  it('reads again and writes when another rating landed between its read and write', async () => {
    await song();
    await languageVerdict(R);
    const prisma = h.prisma as unknown as { image: { updateMany: (a: unknown) => unknown } };
    vi.mocked(dbMock.dbWrite.image.updateMany).mockImplementationOnce((async (args: unknown) => {
      await q(`UPDATE "Image" SET "nsfwLevel" = ${PG13} WHERE id = ${SONG}`);
      return prisma.image.updateMany(args);
    }) as never);

    expect(await rate()).toBe(R);
    expect(await level()).toBe(R);
    expect(onRated).toHaveBeenCalledWith(R);
  });

  it('keeps a collection judge rating as a floor', async () => {
    await song(`metadata = '{"judgeRating":{"nsfwLevel":${R}}}'`);

    expect(await rate()).toBe(R);
  });
});

describe('a song its own scan still decides', () => {
  it('is left alone while blocked or undecided', async () => {
    await lyricsVerdict(R);
    for (const state of [
      `ingestion = 'Blocked', "blockedFor" = 'tos', "nsfwLevel" = ${BLOCKED}`,
      `ingestion = 'Pending'`,
      `ingestion = 'Rescan'`,
    ]) {
      await q(`DELETE FROM "Image" WHERE id = ${SONG}`);
      await song(state);
      const before = await level();

      expect(await rate()).toBeNull();
      expect(await level()).toBe(before);
    }
    expect(onRated).not.toHaveBeenCalled();
  });

  // A block reason on a Scanned song at a normal level: the song is left to its block, with no
  // write attempted (a refused write would only be read again and retried).
  it('attempts no write on a song carrying a block reason', async () => {
    await song(`"blockedFor" = 'moderated'`);
    await languageVerdict(R);

    expect(await rate()).toBeNull();
    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(await level()).toBe(PG);
  });

  // A lock on level 0 holds no rating, so the song is rated and the lock goes, as the scan does.
  it('is rated through a lock that holds no level, dropping the lock', async () => {
    await song(`"nsfwLevelLocked" = true, "nsfwLevel" = 0`);
    await languageVerdict(R);

    expect(await rate()).toBe(R);
    const { rows } = await h.pg.query<{ nsfwLevel: number; nsfwLevelLocked: boolean }>(
      `SELECT "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = ${SONG}`
    );
    expect(rows[0]).toEqual({ nsfwLevel: R, nsfwLevelLocked: false });
  });

  it("never overrides a locked level, a moderator's review", async () => {
    await song(`"nsfwLevelLocked" = true`);
    await lyricsVerdict(X);

    expect(await rate()).toBeNull();
    expect(await level()).toBe(PG);
  });
});

describe('a cover', () => {
  it("names the song it is linked to as the song's own cover", async () => {
    await song();
    await cover(PG);

    expect(await songOfCover(COVER)).toBe(SONG);
    expect(await songOfCover(SONG)).toBeNull();
  });
});
