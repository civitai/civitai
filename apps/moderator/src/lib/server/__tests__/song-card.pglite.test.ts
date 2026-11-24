import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * What a moderator's song card shows (Music T10, docs/features/music.md "Moderating songs"): title,
 * length, lyrics and a cover only when the public player would show it, as the main app's
 * `getSongCoversForPlayer` decides.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    throw new Error('a song card is read from the replica');
  },
}));

const { getSongCard } = await import('../song-card.service');
const { isPlayerSongCover, isSongsOwnCover } = await import(
  '@civitai/db-queries/profile-picture-clear'
);

const OWNER = 7;
const SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'image', "userId" INTEGER NOT NULL,
  "postId" INTEGER, metadata JSONB, ingestion TEXT NOT NULL DEFAULT 'Scanned', "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "blockedFor" TEXT, "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, genre TEXT);
CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL);
`;

// Each song's cover differs from 101's (clean, the owner's own, outside any post) in one fact.
const COVERS: [song: number, cover: string, shown: boolean][] = [
  [1, `(101, 'cover-101', 'image', ${OWNER}, NULL, 'Scanned', 1, NULL, NULL, false)`, true],
  [2, `(102, 'cover-102', 'image', ${OWNER}, NULL, 'Pending', 1, NULL, NULL, false)`, false],
  [3, `(103, 'cover-103', 'image', ${OWNER}, NULL, 'Blocked', 1, NULL, NULL, false)`, false],
  [4, `(104, 'cover-104', 'image', ${OWNER}, NULL, 'Scanned', 32, NULL, NULL, false)`, false],
  [5, `(105, 'cover-105', 'image', ${OWNER}, NULL, 'Scanned', 1, 'tos', NULL, false)`, false],
  [6, `(106, 'cover-106', 'image', ${OWNER}, NULL, 'Scanned', 1, NULL, 'minor', false)`, false],
  [7, `(107, 'cover-107', 'image', ${OWNER}, NULL, 'Scanned', 1, NULL, NULL, true)`, false],
  [8, `(108, 'cover-108', 'image', 99, NULL, 'Scanned', 1, NULL, NULL, false)`, false],
  [9, `(109, 'cover-109', 'image', ${OWNER}, 5, 'Scanned', 1, NULL, NULL, false)`, false],
];

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Image" (id, url, type, "userId", "postId", ingestion, "nsfwLevel", "blockedFor", "needsReview", "acceptableMinor")
    VALUES ${COVERS.map(([, cover]) => cover).join(', ')};
    INSERT INTO "Image" (id, url, type, "userId", metadata) VALUES
      ${COVERS.map(([song]) => `(${song}, 'song-${song}', 'audio', ${OWNER}, NULL)`).join(', ')},
      (20, 'song-20', 'audio', ${OWNER}, '{"title": "Night drive", "duration": 183.4}'),
      (21, 'song-21', 'audio', ${OWNER}, '{"duration": "183"}'),
      (30, 'picture-30', 'image', ${OWNER}, '{"title": "Not a song"}');
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES
      ${COVERS.map(([song], i) => `(${song}, ${101 + i})`).join(', ')};
    INSERT INTO "TrackLyrics" ("imageId", text, lines) VALUES
      (20, 'x', '[{"t": 0, "text": "[Verse 1]"}, {"t": 1500, "text": "Headlights"}, {"t": null, "text": "untimed"}, {"text": 4}]');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('getSongCard', () => {
  it('shows a cover only when the public player would: scanned, unblocked, unheld, its own', async () => {
    for (const [song, , shown] of COVERS) {
      const card = await getSongCard(song);
      expect({ song, cover: card?.cover?.url ?? null }).toEqual({
        song,
        cover: shown ? `cover-${100 + song}` : null,
      });
    }
  });

  // One rule in two forms: the main app's getSongCoversForPlayer filters fetched rows with the TS
  // form, this card's SQL uses the text form.
  it('shows a cover exactly where the TS form of the public-player rule does', async () => {
    const { rows } = await db.query<{
      id: number;
      userId: number;
      postId: number | null;
      ingestion: string;
      nsfwLevel: number;
      blockedFor: string | null;
      needsReview: string | null;
      acceptableMinor: boolean;
    }>(`SELECT * FROM "Image" WHERE id > 100 ORDER BY id`);
    for (const cover of rows) {
      const song = { userId: OWNER };
      const card = await getSongCard(cover.id - 100);
      expect({ id: cover.id, shown: card?.cover != null }).toEqual({
        id: cover.id,
        shown: isSongsOwnCover(cover, song) && isPlayerSongCover(cover),
      });
    }
  });

  it("reads the song's title, length and lyric lines, a line's time in ms or null", async () => {
    expect(await getSongCard(20)).toEqual({
      id: 20,
      url: 'song-20',
      title: 'Night drive',
      durationSec: 183.4,
      cover: null,
      lines: [
        { t: 0, text: '[Verse 1]' },
        { t: 1500, text: 'Headlights' },
        { t: null, text: 'untimed' },
      ],
    });
  });

  it('reads no length from a stored duration that is not a positive number', async () => {
    expect(await getSongCard(21)).toMatchObject({ title: null, durationSec: null });
  });

  it('answers nothing for an image that is not a song, or no image at all', async () => {
    expect(await getSongCard(30)).toBeNull();
    expect(await getSongCard(999)).toBeNull();
  });
});
