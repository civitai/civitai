import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { RETRACTED_REFUSED } from '$lib/held-media';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * A song the media access rule (`withheldImageIds`, civitai/civitai#10170) withholds from a moderator
 * without the CSAM page's grant gives them no card and no media on any song surface (Music T10):
 * `/api/song-card` and Removed-appeals. The rule runs for real against pglite.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown, writeDown: false },
}));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  // The access rule reads the primary; `writeDown` is the primary refusing.
  get dbWrite() {
    if (dbHandle.writeDown) throw new Error('primary unavailable');
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// ClickHouse is the boundary: the scanner has no rows.
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { GET } = await import('../../../routes/api/song-card/[imageId]/+server');
const removedAppeals = await import('../../../routes/images/removed-appeals/+page.server');

// A routine block reason, kept by the other row on its url, which has not finished its scan: the
// rule withholds it from a moderator without the grant.
const WITHHELD = 501;
const OPEN = 502;
const PICTURE = 504;
const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  dbHandle.writeDown = false;
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(`
    ALTER TABLE "Appeal" ADD COLUMN "buzzTransactionId" TEXT, ADD COLUMN "internalNotes" TEXT;
    CREATE TABLE "UserReport" ("userId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
    CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, genre TEXT);
    CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL);
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other');
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", "userId", metadata) VALUES
      (${WITHHELD}, 'shared-key', 'audio', 'Blocked', 'moderated', 7, '{"title": "Held"}'),
      (503, 'shared-key', 'image', 'Pending', NULL, 8, NULL),
      (${OPEN}, 'open-key', 'audio', 'Blocked', 'moderated', 7, '{"title": "Open"}'),
      (${PICTURE}, 'picture-key', 'image', 'Scanned', NULL, 7, NULL);
    INSERT INTO "TrackLyrics" ("imageId", text, lines) VALUES
      (${WITHHELD}, 'x', '[{"t": 0, "text": "held line"}]');
    INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", "entityRemovedAt") VALUES
      (1, 7, 'Image', ${WITHHELD}, '2026-09-21'), (2, 7, 'Image', ${OPEN}, '2026-09-22');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const songCard = async (user: { id: number; roles: string[] } | null, imageId: number | string) => {
  const res = await GET({ params: { imageId: String(imageId) }, locals: { user } } as never);
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
};

describe('/api/song-card', () => {
  it('refuses a withheld song to a moderator without the grant, lyrics and all', async () => {
    expect(await songCard(WITHOUT_GRANT, WITHHELD)).toEqual({
      status: 404,
      body: { message: RETRACTED_REFUSED },
      cache: 'private, no-store',
    });
  });

  it('answers the same song to a moderator with the grant, and an open one to either', async () => {
    expect(await songCard(WITH_GRANT, WITHHELD)).toMatchObject({
      status: 200,
      body: { id: WITHHELD, title: 'Held', lines: [{ t: 0, text: 'held line' }] },
      cache: 'private, no-store',
    });
    expect(await songCard(WITHOUT_GRANT, OPEN)).toMatchObject({ status: 200, body: { id: OPEN } });
  });

  it('answers 503 when the access rule cannot be read, and serves nothing', async () => {
    dbHandle.writeDown = true;
    expect(await songCard(WITHOUT_GRANT, WITHHELD)).toMatchObject({
      status: 503,
      body: { message: 'Could not check this song; retry.' },
    });
  });

  it('refuses no session (403), a bad id (400) and an image that is not a song (404)', async () => {
    expect((await songCard(null, OPEN)).status).toBe(403);
    expect((await songCard(WITHOUT_GRANT, 'x')).status).toBe(400);
    expect(await songCard(WITHOUT_GRANT, PICTURE)).toMatchObject({
      status: 404,
      body: { message: 'Not a song.' },
    });
  });
});

describe('Removed-appeals', () => {
  const load = async (user: { id: number; roles: string[] }) =>
    (await removedAppeals.load({ locals: { user } } as never)) as {
      items: { id: number; song: { id: number; url: string } | null; songWithheld: boolean }[];
    };

  it('sends a withheld song as withheld, with no key, to a moderator without the grant', async () => {
    const { items } = await load(WITHOUT_GRANT);
    expect(items.map((i) => [i.id, i.song, i.songWithheld])).toEqual([
      [1, null, true],
      [2, { id: OPEN, url: 'open-key' }, false],
    ]);
  });

  it('sends it to a moderator with the grant', async () => {
    const { items } = await load(WITH_GRANT);
    expect(items.find((i) => i.id === 1)).toMatchObject({
      song: { id: WITHHELD, url: 'shared-key' },
      songWithheld: false,
    });
  });
});
