import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as TagsOnImageNew from '~/server/services/tagsOnImageNew.service';
import type { SessionUser } from '~/types/session';

/**
 * A song's genre and tags, with the song, its Track row, the tags and the image tag rows in PGlite:
 * each test reads back what was stored. The primary pool's connection is the same PGlite session,
 * so `setSongGenre`'s transaction holds the tag writes too.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MODERATED = 900;

const mocks = vi.hoisted(() => ({
  music: true,
  /** The image tag store as PGlite rows; set in beforeAll. */
  db: null as unknown as PGlite,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: () => ({ music: mocks.music }),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn(async (text: unknown) => {
    if (JSON.stringify(text).includes('badword')) throw new Error('blocked content');
  }),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getModeratedTags: vi.fn(async () => [{ id: 900, name: 'moderated', nsfwLevel: 4 }]),
}));
// The real writers run `insert_tag_on_image` (insert only, ON CONFLICT DO NOTHING) and a delete;
// these do the same on the PGlite rows.
vi.mock('~/server/services/tagsOnImageNew.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsOnImageNew>()),
  insertTagsOnImageNew: vi.fn(
    async (args: { imageId: number; tagId: number; automated?: boolean; disabled?: boolean }[]) => {
      for (const a of args)
        await mocks.db.query(
          `INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", source, automated, disabled)
           VALUES ($1, $2, 'User', $3, $4) ON CONFLICT DO NOTHING`,
          [a.imageId, a.tagId, a.automated ?? false, a.disabled ?? false]
        );
    }
  ),
  upsertTagsOnImageNew: vi.fn(async () => {
    throw new Error('a song tag write must never upsert');
  }),
  deleteTagsOnImageNew: vi.fn(async (args: { imageId: number; tagId: number }[]) => {
    for (const a of args)
      await mocks.db.query(
        `DELETE FROM "TagsOnImageDetails" WHERE "imageId" = $1 AND "tagId" = $2`,
        [a.imageId, a.tagId]
      );
  }),
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: {
    connect: vi.fn(async () => ({
      query: (text: string, values?: unknown[]) => mocks.db.query(text, values),
      release: vi.fn(),
    })),
  },
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(async () => undefined) },
  };
});

import {
  addSongTagSchema,
  removeSongTagSchema,
  setSongGenreSchema,
} from '~/server/schema/post.schema';
import {
  addSongTag,
  removeSongTag,
  setSongGenre,
  suggestSongTags,
} from '~/server/services/post.service';
import { readSongTags, searchSongTags } from '~/server/services/tagsOnSong.service';
import {
  deleteTagsOnImageNew,
  insertTagsOnImageNew,
} from '~/server/services/tagsOnImageNew.service';
import { SONG_GENRES } from '~/shared/constants/song-genres';

const NOT_AUTHORIZED = 'You are not authorized to perform this action';
const OWNER = 5;
const SONG = 7;
const IMAGE = 8;
const POST = 70;

const owner = { id: OWNER } as SessionUser;
const stranger = { id: 6 } as SessionUser;
const moderator = { id: 99, isModerator: true } as SessionUser;

let db: PGlite;

/** The song's stored genre: `Track.genre`. */
const genreOf = async (id = SONG) =>
  (await db.query<{ genre: string | null }>(`SELECT genre FROM "Track" WHERE "imageId" = $1`, [id]))
    .rows[0]?.genre ?? undefined;

const metadataOf = async (id = SONG) =>
  (
    await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0].metadata;

/** The song's tag rows, by tag name. */
async function tagRows(imageId = SONG) {
  const { rows } = await db.query<{ name: string; disabled: boolean; automated: boolean }>(
    `SELECT t.name, toi.disabled, toi.automated FROM "TagsOnImageDetails" toi
     JOIN "Tag" t ON t.id = toi."tagId" WHERE toi."imageId" = $1 ORDER BY t.name`,
    [imageId]
  );
  return rows;
}
const tagNames = async (imageId = SONG) => (await tagRows(imageId)).map((r) => r.name);

async function insertTag(
  id: number,
  name: string,
  extra: Partial<{
    type: string;
    nsfwLevel: number;
    adminOnly: boolean;
    unlisted: boolean;
    isCategory: boolean;
  }> = {}
) {
  await db.query(
    `INSERT INTO "Tag" (id, name, type, "nsfwLevel", "adminOnly", unlisted, "isCategory")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      name,
      extra.type ?? 'UserGenerated',
      extra.nsfwLevel ?? 1,
      extra.adminOnly ?? false,
      extra.unlisted ?? false,
      extra.isCategory ?? false,
    ]
  );
}
async function attach(
  tagId: number,
  row: Partial<{ automated: boolean; disabled: boolean; source: string }> = {}
) {
  await db.query(
    `INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", source, automated, disabled) VALUES ($1, $2, $3, $4, $5)`,
    [SONG, tagId, row.source ?? 'User', row.automated ?? false, row.disabled ?? false]
  );
}

beforeAll(async () => {
  db = new PGlite();
  mocks.db = db;
  await db.exec(`
    -- Tag names are citext in the real schema; the suggestion range casts to it.
    CREATE DOMAIN citext AS text;
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, type text NOT NULL, metadata jsonb
    );
    CREATE TABLE "Tag" (
      id serial PRIMARY KEY, name text NOT NULL UNIQUE, type text NOT NULL DEFAULT 'UserGenerated',
      target text[], "nsfwLevel" int NOT NULL DEFAULT 1, "adminOnly" boolean NOT NULL DEFAULT false,
      unlisted boolean NOT NULL DEFAULT false, "isCategory" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source text NOT NULL,
      automated boolean NOT NULL, disabled boolean NOT NULL, PRIMARY KEY ("imageId", "tagId")
    );
    CREATE TABLE "Track" ("imageId" int PRIMARY KEY, "coverImageId" int UNIQUE, genre text);
  `);
  const INT4_OID = 23;
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return db.query(sql.text, sql.values, { paramTypes });
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  dbMock.dbRead.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).affectedRows ?? 0) as never
  );
  // The array form: these statements already ran on PGlite when they were built.
  dbMock.dbWrite.$transaction.mockImplementation((async (ops: Promise<unknown>[]) =>
    Promise.all(ops)) as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.music = true;
  await db.exec(
    `DELETE FROM "TagsOnImageDetails"; DELETE FROM "Tag"; DELETE FROM "Track"; DELETE FROM "Image";`
  );
  await db.exec(`ALTER SEQUENCE "Tag_id_seq" RESTART WITH 5000;`);
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", type, metadata) VALUES ($1, $2, $3, 'audio', $4), ($5, $2, $3, 'image', '{}')`,
    [SONG, OWNER, POST, { duration: 120, title: 'Midnight Arcade' }, IMAGE]
  );

  dbMock.dbWrite.image.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (
        await db.query(
          `SELECT i.id, i."userId", i."postId", i.type, i.metadata,
             (SELECT json_build_object('genre', t.genre) FROM "Track" t WHERE t."imageId" = i.id) AS track
           FROM "Image" i WHERE i.id = $1`,
          [where.id]
        )
      ).rows[0] ?? null) as never
  );
  // `findOrCreateTagsByName` reads and creates tags through Prisma.
  dbMock.dbWrite.tag.findMany.mockImplementation(
    (async ({ where }: { where: { name: { in: string[] } } }) =>
      (await db.query(`SELECT id, name FROM "Tag" WHERE name = ANY($1)`, [where.name.in]))
        .rows) as never
  );
  dbMock.dbWrite.tag.createMany.mockImplementation((async ({
    data,
  }: {
    data: { name: string; type: string }[];
  }) => {
    for (const tag of data)
      await db.query(`INSERT INTO "Tag" (name, type) VALUES ($1, $2)`, [tag.name, tag.type]);
    return { count: data.length };
  }) as never);
});

const genre = (user: SessionUser, value: string, id = SONG) =>
  setSongGenre({ ...setSongGenreSchema.parse({ id, genre: value }), user });
const add = (user: SessionUser, name: string, id = SONG) =>
  addSongTag({ ...addSongTagSchema.parse({ id, name }), user });
const remove = (user: SessionUser, tagId: number, id = SONG) =>
  removeSongTag({ ...removeSongTagSchema.parse({ id, tagId }), user });

describe('setSongGenre', () => {
  it("stores the genre in the song's Track row and attaches the genre's tag", async () => {
    await genre(owner, 'Hip-Hop');

    expect(await genreOf()).toBe('Hip-Hop');
    expect(await tagRows()).toEqual([{ name: 'hip-hop', disabled: false, automated: false }]);
  });

  it("writes nothing to the song's metadata", async () => {
    await genre(owner, 'Pop');

    expect(await metadataOf()).toEqual({ duration: 120, title: 'Midnight Arcade' });
  });

  it('leaves exactly one genre tag row, the new one, when the genre changes', async () => {
    await genre(owner, 'Pop');
    await genre(owner, 'Rock');
    await genre(owner, 'Jazz');

    expect(await genreOf()).toBe('Jazz');
    expect(await tagNames()).toEqual(['jazz']);
  });

  it('refuses a genre outside the list', () => {
    expect(() => setSongGenreSchema.parse({ id: SONG, genre: 'Polka' })).toThrow();
  });

  it("refuses someone else's song and lets a moderator set it", async () => {
    await expect(genre(stranger, 'Pop')).rejects.toThrow(NOT_AUTHORIZED);
    expect(await genreOf()).toBeUndefined();

    await genre(moderator, 'Jazz');
    expect(await genreOf()).toBe('Jazz');
  });

  it('refuses an image that is not a song', async () => {
    await expect(genre(owner, 'Pop', IMAGE)).rejects.toThrow(/song/i);
    expect(await genreOf(IMAGE)).toBeUndefined();
    expect(await tagNames(IMAGE)).toEqual([]);
  });

  it('refuses while songs are not available to the caller', async () => {
    mocks.music = false;

    await expect(genre(owner, 'Pop')).rejects.toThrow('Songs are not available yet.');
    expect(await genreOf()).toBeUndefined();
  });

  // The genre is written first in the transaction, so these fail only if it is not rolled back.
  it('rolls the genre back when attaching its tag fails', async () => {
    await genre(owner, 'Pop');
    vi.mocked(insertTagsOnImageNew).mockRejectedValueOnce(new Error('tag store down'));

    await expect(genre(owner, 'Rock')).rejects.toThrow('tag store down');
    expect(await genreOf()).toBe('Pop');
    expect(await tagNames()).toEqual(['pop']);
  });

  it('rolls the genre and the new tag back when taking the previous tag off fails', async () => {
    await genre(owner, 'Pop');
    vi.mocked(deleteTagsOnImageNew).mockRejectedValueOnce(new Error('tag store down'));

    await expect(genre(owner, 'Rock')).rejects.toThrow('tag store down');
    expect(await genreOf()).toBe('Pop');
    expect(await tagNames()).toEqual(['pop']);
  });

  it("takes the previous genre's tag off even when its row was there before the genre", async () => {
    await insertTag(61, 'rock');
    await attach(61);
    await genre(owner, 'Rock');
    await genre(owner, 'Pop');

    expect(await tagNames()).toEqual(['pop']);
  });

  it('stores a genre whose same-named tag is restricted, without attaching that tag', async () => {
    await insertTag(60, 'metal', { type: 'Moderation' });

    await genre(owner, 'Metal');

    expect(await genreOf()).toBe('Metal');
    expect(await tagNames()).toEqual([]);
  });
});

describe('addSongTag', () => {
  it('attaches an existing plain label and returns the tags', async () => {
    await insertTag(10, 'chill');

    const result = await add(owner, 'Chill ');

    expect(result.tags).toEqual([{ id: 10, name: 'chill' }]);
    expect(await tagRows()).toEqual([{ name: 'chill', disabled: false, automated: false }]);
  });

  it('creates a new name as a user-generated tag', async () => {
    await add(owner, 'night drive');

    const { rows } = await db.query<{ type: string }>(
      `SELECT type FROM "Tag" WHERE name = 'night drive'`
    );
    expect(rows).toEqual([{ type: 'UserGenerated' }]);
    expect(await tagNames()).toEqual(['night drive']);
  });

  it('refuses a new name the blocklist catches, creating nothing', async () => {
    await expect(add(owner, 'badword')).rejects.toThrow(/blocked/);

    expect((await db.query(`SELECT 1 FROM "Tag" WHERE name = 'badword'`)).rows).toEqual([]);
    expect(await tagNames()).toEqual([]);
  });

  it.each([
    ['a moderation tag', { type: 'Moderation' }],
    ['a rated tag', { nsfwLevel: 4 }],
    ['an admin-only tag', { adminOnly: true }],
    ['an unlisted tag', { unlisted: true }],
    ['a system tag', { type: 'System' }],
    ['a category tag', { isCategory: true }],
  ])('refuses %s', async (_label, extra) => {
    await insertTag(20, 'restricted', extra);

    await expect(add(owner, 'restricted')).rejects.toThrow("This tag can't be added to a song.");
    expect(await tagNames()).toEqual([]);
  });

  it.each(SONG_GENRES.map((g) => g.toLowerCase()))(
    'refuses the genre name %s, which only the genre select attaches',
    async (name) => {
      await expect(add(owner, name)).rejects.toThrow("This tag can't be added to a song.");
      expect(await tagNames()).toEqual([]);
    }
  );

  it('refuses a tag in the moderated set', async () => {
    await insertTag(MODERATED, 'moderated');

    await expect(add(owner, 'moderated')).rejects.toThrow("This tag can't be added to a song.");
  });

  it('refuses a sixth tag besides the genre', async () => {
    await genre(owner, 'Pop');
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) await add(owner, name);

    await expect(add(owner, 'a6')).rejects.toThrow(
      'A song can have up to 5 tags besides its genre.'
    );
    expect(await tagNames()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'pop']);
  });

  it("refuses someone else's song and an image that is not a song", async () => {
    await expect(add(stranger, 'chill')).rejects.toThrow(NOT_AUTHORIZED);
    await expect(add(owner, 'chill', IMAGE)).rejects.toThrow(/song/i);
    expect(await tagNames()).toEqual([]);
    expect(await tagNames(IMAGE)).toEqual([]);
  });

  // The service refuses before writing; the real writer's ON CONFLICT DO NOTHING is not exercised here.
  it('refuses a tag whose row a moderator disabled, leaving the row disabled', async () => {
    await insertTag(30, 'lofi beats');
    await attach(30, { disabled: true });

    await expect(add(owner, 'lofi beats')).rejects.toThrow("This tag can't be added to a song.");
    expect(await tagRows()).toEqual([{ name: 'lofi beats', disabled: true, automated: false }]);
  });
});

describe('removeSongTag', () => {
  it('removes a tag the owner attached', async () => {
    await add(owner, 'chill');
    const [{ id }] = (await db.query<{ id: number }>(`SELECT id FROM "Tag" WHERE name = 'chill'`))
      .rows;

    const result = await remove(owner, id);

    expect(result.tags).toEqual([]);
    expect(await tagNames()).toEqual([]);
  });

  it('refuses a row a scanner attached, and the genre tag', async () => {
    await insertTag(40, 'guitar');
    await attach(40, { automated: true, source: 'WD14' });
    await genre(owner, 'Rock');
    const [{ id: rockId }] = (
      await db.query<{ id: number }>(`SELECT id FROM "Tag" WHERE name = 'rock'`)
    ).rows;

    await expect(remove(owner, 40)).rejects.toThrow("This tag can't be removed.");
    await expect(remove(owner, rockId)).rejects.toThrow("This tag can't be removed.");
    expect(await tagNames()).toEqual(['guitar', 'rock']);
  });

  it("refuses someone else's song", async () => {
    await add(owner, 'chill');
    const [{ id }] = (await db.query<{ id: number }>(`SELECT id FROM "Tag" WHERE name = 'chill'`))
      .rows;

    await expect(remove(stranger, id)).rejects.toThrow(NOT_AUTHORIZED);
    expect(await tagNames()).toEqual(['chill']);
  });
});

describe('removeSongTag on rows an owner cannot manage', () => {
  it('refuses a rated tag and a disabled row', async () => {
    await insertTag(70, 'rated thing', { nsfwLevel: 4 });
    await insertTag(71, 'mod hidden');
    await attach(70);
    await attach(71, { disabled: true });

    await expect(remove(owner, 70)).rejects.toThrow("This tag can't be removed.");
    await expect(remove(owner, 71)).rejects.toThrow("This tag can't be removed.");
    expect(await tagNames()).toEqual(['mod hidden', 'rated thing']);
  });
});

describe('readSongTags (the editor read)', () => {
  it("returns the owner's plain tags, without scanner, disabled or restricted rows", async () => {
    await insertTag(50, 'chill');
    await insertTag(51, 'guitar');
    await insertTag(52, 'hidden');
    await insertTag(53, 'nsfw thing', { nsfwLevel: 8 });
    await attach(50);
    await attach(51, { automated: true, source: 'WD14' });
    await attach(52, { disabled: true });
    await attach(53);

    const tags = await readSongTags([SONG]);

    expect(tags.get(SONG)).toEqual([{ id: 50, name: 'chill' }]);
  });
});

describe('searchSongTags (the tag field suggestions)', () => {
  beforeEach(async () => {
    await insertTag(80, 'rock');
    await insertTag(81, 'rocket');
    await insertTag(82, 'roam');
    await insertTag(83, 'pop rock');
    await insertTag(84, 'rock nsfw', { nsfwLevel: 4 });
    await insertTag(85, 'rock mod', { type: 'Moderation' });
    await insertTag(86, 'rock admin', { adminOnly: true });
    await insertTag(MODERATED, 'rockmoderated');
  });

  it('suggests only tags an owner may attach, by name prefix', async () => {
    expect((await searchSongTags('ro')).map((t) => t.name)).toEqual(['roam', 'rock', 'rocket']);
  });

  it("leaves a genre's tag out of the song tag field's suggestions", async () => {
    expect((await suggestSongTags({ query: 'ro', user: owner })).map((t) => t.name)).toEqual([
      'roam',
      'rocket',
    ]);
  });

  it('puts an exact match first and caps the list', async () => {
    expect((await searchSongTags('Rock ')).map((t) => t.name)).toEqual(['rock', 'rocket']);
    expect(await searchSongTags('ro', 2)).toHaveLength(2);
  });

  it('refuses while songs are not available to the caller', async () => {
    mocks.music = false;

    await expect(suggestSongTags({ query: 'ro', user: owner })).rejects.toThrow(
      'Songs are not available yet.'
    );
  });
});
