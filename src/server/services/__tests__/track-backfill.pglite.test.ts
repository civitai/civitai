import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SONG_GENRES } from '~/shared/constants/song-genres';

/**
 * The Track migration and its backfill, run as files on PGlite over a minimal "Image" table. The
 * backfill re-states `isCoverOfSong` and SONG_GENRES in SQL, so it is pinned against both here.
 */

const dir = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20271123130000_track'
);
const migration = readFileSync(path.join(dir, 'migration.sql'), 'utf8');
const backfill = readFileSync(path.join(dir, 'backfill.sql'), 'utf8');

const OWNER = 5;
const OTHER = 6;

let db: PGlite;

const tracks = async () =>
  (
    await db.query<{ imageId: number; coverImageId: number | null; genre: string | null }>(
      `SELECT "imageId", "coverImageId", genre FROM "Track" ORDER BY "imageId"`
    )
  ).rows;

async function image(
  id: number,
  values: { userId?: number; postId?: number; type?: string; metadata?: object }
) {
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", type, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      values.userId ?? OWNER,
      values.postId ?? null,
      values.type ?? 'image',
      values.metadata ?? null,
    ]
  );
}
const song = (id: number, metadata: object) => image(id, { type: 'audio', metadata });
const coverOf = (id: number, songId: number, values: { userId?: number; postId?: number } = {}) =>
  image(id, { ...values, metadata: { parentId: songId } });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, type text NOT NULL, metadata jsonb
    );
  `);
  await db.exec(migration);

  // A valid pair: the owner's own cover, in no post, named by the song.
  await song(1, { coverImageId: 101, genre: 'Pop' });
  await coverOf(101, 1);
  // Another user's image.
  await song(2, { coverImageId: 102 });
  await coverOf(102, 2, { userId: OTHER });
  // A cover that is in a post; the genre still lands.
  await song(3, { coverImageId: 103, genre: 'Rock' });
  await coverOf(103, 3, { postId: 70 });
  // A cover already linked to another song's Track row.
  await song(4, { coverImageId: 104 });
  await coverOf(104, 4);
  await song(9, {});
  await db.exec(`INSERT INTO "Track" ("imageId", "coverImageId") VALUES (9, 104)`);
  // A genre outside the list.
  await song(5, { genre: 'Trap' });
  // A genre the new code already wrote is kept.
  await song(6, { genre: 'Pop' });
  await db.exec(`INSERT INTO "Track" ("imageId", genre) VALUES (6, 'Jazz')`);
  // Not a song.
  await image(7, { metadata: { genre: 'Pop' } });

  await db.exec(backfill);
}, 60_000);
afterAll(() => db.close());

describe('the Track backfill', () => {
  it("copies only a song's qualifying cover and listed genre", async () => {
    expect(await tracks()).toEqual([
      { imageId: 1, coverImageId: 101, genre: 'Pop' },
      { imageId: 3, coverImageId: null, genre: 'Rock' },
      { imageId: 6, coverImageId: null, genre: 'Jazz' },
      { imageId: 9, coverImageId: 104, genre: null },
    ]);
  });

  it('changes nothing on a second run', async () => {
    const before = await tracks();
    await db.exec(backfill);
    expect(await tracks()).toEqual(before);
  });

  it('accepts exactly the SONG_GENRES list', () => {
    const list = backfill.match(/->> 'genre' IN \(([^)]*)\)/)?.[1] ?? '';
    const genres = [...list.matchAll(/'([^']*)'/g)].map(([, genre]) => genre);
    expect(genres).toEqual([...SONG_GENRES]);
  });
});
