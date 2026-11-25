import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * Audio review's Disputes tab (Music T10 S7, docs/features/music.md "Moderating songs"): owners'
 * Pending rating disputes on songs (`RatingReview` entity type `Song`), ruled through the moderator
 * rating-review resolver, which applies the level only to a song its own scans reviewed and tells
 * the owner. Real SQL against pglite.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, notify } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  notify: vi.fn(async () => undefined),
}));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// Past the process: ClickHouse (the scanner has no rows), the notifications service, Redis and the
// main app's cache-bust endpoints the rating writer calls after commit.
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification: notify }) }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../image-moderation-effects', () => ({
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { getSongDisputes } = await import('../audio-review.service');
const { countSongDisputes } = await import('../audio-review-count');
const page = await import('../../../routes/audio-review/+page.server');
const ratingsPage = await import('../../../routes/ratings/+page.server');

const OWNER = 7;
const OTHER = 1;
const MOD = 3;
// Scanned, PG-13; its owner asks for PG and disputed it once before.
const SONG = 801;
// Its scans have not finished: no level can be applied yet.
const SCANNING_SONG = 802;
// Shares its file with an image still scanning: withheld without the grant.
const WITHHELD_SONG = 803;
const POST = 900;

const DISPUTE = 11;
const EARLIER = 10;
const SCANNING_DISPUTE = 12;
const WITHHELD_DISPUTE = 13;
const POST_DISPUTE = 14;

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: MOD, roles: ['moderator:admin'] };
const GRANTS = { 'image.moderate': true };

let db: PGlite;

beforeEach(async () => {
  notify.mockClear();
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(`
    CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, genre TEXT);
    CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL, source TEXT);
    ALTER TABLE "TextScanHold" ADD COLUMN "userId" INTEGER, ADD COLUMN text TEXT,
      ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now();
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS image TEXT;
    CREATE TABLE IF NOT EXISTS "EntityModeration" ("id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL,
      "entityId" INTEGER NOT NULL, "nsfwLevel" INTEGER, "result" JSONB, UNIQUE ("entityType", "entityId"));
    CREATE TABLE "RatingReview" (
      "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL, "currentLevel" INTEGER NOT NULL, "suggestedLevel" INTEGER NOT NULL,
      "appliedLevel" INTEGER, "userComment" TEXT, "modComment" TEXT,
      "status" TEXT NOT NULL DEFAULT 'Pending', "resolvedBy" INTEGER, "resolvedAt" TIMESTAMP(3),
      "resolvedTextHash" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${OTHER}, 'other'), (${MOD}, 'mod');
    INSERT INTO "Image" (id, url, type, ingestion, "userId", "nsfwLevel", "postId", metadata, "createdAt") VALUES
      (${SONG}, 'song-key', 'audio', 'Scanned', ${OWNER}, 2, 5, '{"title": "Salt Flats at Dawn"}', '2026-11-01'),
      (${SCANNING_SONG}, 'scanning-key', 'audio', 'Pending', ${OWNER}, 4, 5, '{"title": "Velvet Static"}', '2026-11-01'),
      (${WITHHELD_SONG}, 'shared-key', 'audio', 'Scanned', ${OWNER}, 1, 5, '{"title": "Concrete Lullaby"}', '2026-11-01'),
      (819, 'shared-key', 'image', 'Pending', ${OTHER}, 0, 6, NULL, '2026-11-01');
    INSERT INTO "RatingReview" (id, "entityType", "entityId", "userId", "currentLevel", "suggestedLevel",
      "appliedLevel", "userComment", status, "resolvedBy", "resolvedAt", "createdAt") VALUES
      (${EARLIER}, 'Song', ${SONG}, ${OWNER}, 2, 1, 2, NULL, 'Unactioned', ${MOD}, '2026-10-30', '2026-10-29'),
      (${DISPUTE}, 'Song', ${SONG}, ${OWNER}, 2, 1, NULL, 'It is a song about a road trip.', 'Pending', NULL, NULL, '2026-11-02'),
      (${SCANNING_DISPUTE}, 'Song', ${SCANNING_SONG}, ${OWNER}, 4, 8, NULL, NULL, 'Pending', NULL, NULL, '2026-11-03'),
      (${WITHHELD_DISPUTE}, 'Song', ${WITHHELD_SONG}, ${OWNER}, 1, 2, NULL, 'withheld words', 'Pending', NULL, NULL, '2026-11-04'),
      (${POST_DISPUTE}, 'Post', ${POST}, ${OWNER}, 4, 1, NULL, NULL, 'Pending', NULL, NULL, '2026-11-01');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  // A ruling records its mod activity without waiting for it; let it land before the client closes.
  await new Promise((r) => setTimeout(r, 50));
  dbHandle.current = null;
  await db.close();
});

const disputes = (
  user: { id: number; roles: string[] },
  opts: Partial<Parameters<typeof getSongDisputes>[0]> = {}
) =>
  getSongDisputes({
    sort: 'oldest',
    filter: 'all',
    q: '',
    page: 1,
    user: user as never,
    ...opts,
  });

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};
const event = (fields: Record<string, string>, grants: Record<string, boolean>, user: object) =>
  ({
    request: new Request('https://mod.example/audio-review?tab=disputes', {
      method: 'POST',
      body: formOf(fields),
    }),
    locals: { user, grants },
    getClientAddress: () => '127.0.0.1',
    url: new URL('https://mod.example/audio-review?tab=disputes'),
  } as never);
const resolve = (
  fields: Record<string, string>,
  grants: Record<string, boolean> = GRANTS,
  user: object = WITH_GRANT
) => page.actions.resolveDispute(event(fields, grants, user));

const review = async (id: number) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT status, "appliedLevel", "resolvedBy", "modComment" FROM "RatingReview" WHERE id = ${id}`
    )
  ).rows[0];
const song = async (id: number) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = ${id}`
    )
  ).rows[0];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the Disputes tab', () => {
  it('lists Pending song disputes only, oldest first, with ask facets and filters', async () => {
    const { items, facets } = await disputes(WITH_GRANT);
    expect(items.map((r) => r.id)).toEqual([DISPUTE, SCANNING_DISPUTE, WITHHELD_DISPUTE]);
    expect(facets).toEqual({ all: 3, lower: 1, higher: 2 });
    expect((await disputes(WITH_GRANT, { filter: 'higher' })).items.map((r) => r.id)).toEqual([
      SCANNING_DISPUTE,
      WITHHELD_DISPUTE,
    ]);
    expect((await disputes(WITH_GRANT, { sort: 'newest' })).items.map((r) => r.id)).toEqual([
      WITHHELD_DISPUTE,
      SCANNING_DISPUTE,
      DISPUTE,
    ]);
    expect((await disputes(WITH_GRANT, { q: 'salt' })).items.map((r) => r.id)).toEqual([DISPUTE]);
    expect(
      (await disputes(WITH_GRANT, { q: String(SCANNING_SONG) })).items.map((r) => r.id)
    ).toEqual([SCANNING_DISPUTE]);
  });

  it("carries the song, the owner's ask and message, and the earlier ruling on it", async () => {
    const [row] = (await disputes(WITH_GRANT)).items;
    expect(row).toMatchObject({
      id: DISPUTE,
      songId: SONG,
      withheld: false,
      title: 'Salt Flats at Dawn',
      url: 'song-key',
      owner: { id: OWNER, username: 'owner' },
      currentLevel: 2,
      suggestedLevel: 1,
      songLevel: 2,
      message: 'It is a song about a road trip.',
      state: 'reviewed',
      disputes: 2,
      earlier: { status: 'Unactioned', appliedLevel: 2 },
    });
    expect((await disputes(WITH_GRANT)).items[1]).toMatchObject({
      id: SCANNING_DISPUTE,
      state: 'unreviewed',
      earlier: null,
    });
  });

  it('sends a withheld song with nothing but the dispute id, song id and wait', async () => {
    const row = (await disputes(WITHOUT_GRANT)).items.find((r) => r.id === WITHHELD_DISPUTE);
    expect(row).toMatchObject({
      songId: WITHHELD_SONG,
      withheld: true,
      title: null,
      url: null,
      coverUrl: null,
      owner: null,
      message: null,
      currentLevel: null,
      suggestedLevel: null,
      songLevel: null,
      earlier: null,
    });
    // Its title does not find it; its id does.
    expect((await disputes(WITHOUT_GRANT, { q: 'concrete' })).items).toEqual([]);
    expect(
      (await disputes(WITHOUT_GRANT, { q: String(WITHHELD_SONG) })).items.map((r) => r.id)
    ).toEqual([WITHHELD_DISPUTE]);
  });

  it('counts the Pending song disputes for the tab and the sidebar', async () => {
    expect(await countSongDisputes()).toBe(3);
    const loaded = (await page.load({
      url: new URL('https://mod.example/audio-review?tab=disputes'),
      locals: { user: WITH_GRANT, grants: GRANTS },
    } as never)) as Record<string, unknown>;
    expect(loaded).toMatchObject({ tab: 'disputes', counts: { disputes: 3 } });
    const reported = (await page.load({
      url: new URL('https://mod.example/audio-review'),
      locals: { user: WITH_GRANT, grants: GRANTS },
    } as never)) as Record<string, unknown>;
    expect(reported).toMatchObject({ tab: 'reported', counts: { disputes: 3 } });
  });
});

describe('ruling a song dispute', () => {
  it("applies the owner's ask to the reviewed song, locks it, closes the dispute and tells the owner", async () => {
    expect(
      await resolve({ reviewId: String(DISPUTE), appliedLevel: '1', modComment: 'Agreed.' })
    ).toMatchObject({ success: true, status: 'Actioned', key: DISPUTE });
    expect(await review(DISPUTE)).toEqual({
      status: 'Actioned',
      appliedLevel: 1,
      resolvedBy: MOD,
      modComment: 'Agreed.',
    });
    expect(await song(SONG)).toEqual({ nsfwLevel: 1, nsfwLevelLocked: true });
    await flush();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, type: 'rating-review-approved' })
    );
    expect(await countSongDisputes()).toBe(2);
  });

  it('keeps the rating only with a reason, and then rejects the dispute', async () => {
    expect(await resolve({ reviewId: String(DISPUTE), appliedLevel: '2' })).toMatchObject({
      status: 409,
      data: { key: DISPUTE },
    });
    expect(await review(DISPUTE)).toMatchObject({ status: 'Pending' });
    expect(
      await resolve({ reviewId: String(DISPUTE), appliedLevel: '2', modComment: 'Fits PG-13.' })
    ).toMatchObject({ success: true, status: 'Unactioned' });
    await flush();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, type: 'rating-review-rejected' })
    );
  });

  it('refuses a song its own scans have not reviewed, changing nothing', async () => {
    expect(
      await resolve({ reviewId: String(SCANNING_DISPUTE), appliedLevel: '8', modComment: 'x' })
    ).toMatchObject({ status: 409, data: { key: SCANNING_DISPUTE } });
    expect(await review(SCANNING_DISPUTE)).toMatchObject({ status: 'Pending', appliedLevel: null });
    expect(await song(SCANNING_SONG)).toEqual({ nsfwLevel: 4, nsfwLevelLocked: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a dispute already decided, and one that is not on a song', async () => {
    await resolve({ reviewId: String(DISPUTE), appliedLevel: '1' });
    expect(await resolve({ reviewId: String(DISPUTE), appliedLevel: '4' })).toMatchObject({
      status: 409,
      data: { key: DISPUTE },
    });
    expect(await review(DISPUTE)).toMatchObject({ appliedLevel: 1 });
    expect(await resolve({ reviewId: String(POST_DISPUTE), appliedLevel: '1' })).toMatchObject({
      status: 409,
    });
    expect(await review(POST_DISPUTE)).toMatchObject({ status: 'Pending' });
  });

  it('refuses a withheld song without the grant to see it', async () => {
    expect(
      await resolve(
        { reviewId: String(WITHHELD_DISPUTE), appliedLevel: '2' },
        GRANTS,
        WITHOUT_GRANT
      )
    ).toMatchObject({ status: 403, data: { key: WITHHELD_DISPUTE } });
    expect(await review(WITHHELD_DISPUTE)).toMatchObject({ status: 'Pending' });
    expect(await song(WITHHELD_SONG)).toMatchObject({ nsfwLevel: 1 });
  });

  it('refuses a moderator without the image grant', async () => {
    expect(await resolve({ reviewId: String(DISPUTE), appliedLevel: '1' }, {})).toMatchObject({
      status: 403,
    });
    expect(await review(DISPUTE)).toMatchObject({ status: 'Pending' });
  });

  it('is decided here only: /ratings refuses a song dispute', async () => {
    expect(
      await ratingsPage.actions.resolve(
        event({ reviewId: String(DISPUTE), appliedLevel: '1' }, GRANTS, WITH_GRANT)
      )
    ).toMatchObject({ status: 409 });
    expect(await review(DISPUTE)).toMatchObject({ status: 'Pending' });
    expect(await song(SONG)).toEqual({ nsfwLevel: 2, nsfwLevelLocked: false });
  });
});
