import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { rateSong, songOfCover } from '~/server/services/audio-scan/song-rating';

/**
 * A song's level is the highest of PG, its text scan, its lyrics profanity and its own cover
 * (docs/features/music.md "A song's rating", decision L6 of the music synced-lyrics feature).
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

  it('is not raised by a blocked cover, or one still being scanned', async () => {
    await song();
    await cover(R, `"blockedFor" = 'tos'`);
    expect(await rate()).toBeNull();

    await q(`UPDATE "Image" SET "blockedFor" = NULL, ingestion = 'Pending' WHERE id = ${COVER}`);
    expect(await rate()).toBeNull();
    expect(await level()).toBe(PG);
  });

  it('comes back down when its cover goes, but never below PG', async () => {
    await song(`"nsfwLevel" = ${R}`);
    await languageVerdict(null);

    expect(await rate()).toBe(PG);
    expect(await level()).toBe(PG);
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
