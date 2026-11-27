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

const { dbHandle, notify, metricRows, metricQueries } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  notify: vi.fn(async () => undefined),
  metricRows: { current: [] as { metricType: string; value: string }[] },
  metricQueries: [] as unknown[],
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
  getClickhouse: () => ({
    query: async ({ query_params }: { query_params?: unknown }) => {
      metricQueries.push(query_params);
      return { json: async () => metricRows.current };
    },
  }),
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
const { disputeKeysEnabled } = await import('../../audio-review');
const details = await import('../../../routes/audio-review/details/[imageId]/+server');
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
// Shares its file with an image in the CSAM queue: withheld without the grant.
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
  metricRows.current = [];
  metricQueries.length = 0;
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
    ALTER TABLE "EntityModeration" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Pending',
      ADD COLUMN IF NOT EXISTS blocked BOOLEAN, ADD COLUMN IF NOT EXISTS "nsfwLevel" INTEGER,
      ADD COLUMN IF NOT EXISTS result JSONB;
    CREATE TABLE IF NOT EXISTS "UserStrike" ("userId" INTEGER, points INTEGER, status TEXT, "voidedAt" TIMESTAMP, "expiresAt" TIMESTAMP);
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${OTHER}, 'other'), (${MOD}, 'mod');
    INSERT INTO "Image" (id, url, type, ingestion, "userId", "nsfwLevel", "postId", metadata, "createdAt") VALUES
      (${SONG}, 'song-key', 'audio', 'Scanned', ${OWNER}, 2, 5, '{"title": "Salt Flats at Dawn"}', '2026-11-01'),
      (${SCANNING_SONG}, 'scanning-key', 'audio', 'Pending', ${OWNER}, 4, 5, '{"title": "Velvet Static"}', '2026-11-01'),
      (${WITHHELD_SONG}, 'shared-key', 'audio', 'Scanned', ${OWNER}, 1, 5, '{"title": "Concrete Lullaby"}', '2026-11-01'),
      (819, 'shared-key', 'image', 'Pending', ${OTHER}, 0, 6, NULL, '2026-11-01');
    UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 819;
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

  it("gives the scan level from the song's lyrics, language and own cover, none before its scan", async () => {
    // Unscanned extras rate nothing: a clean scanned song is PG.
    expect((await disputes(WITH_GRANT)).items[0]).toMatchObject({ id: DISPUTE, scanLevel: 1 });

    await db.exec(`
      INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel", result, status) VALUES
        ('TrackLyrics', ${SONG}, 4, '{"version": 2}', 'Succeeded'),
        ('TrackLyricsLanguage', ${SONG}, 2, NULL, 'Succeeded'),
        ('TrackLyrics', ${SCANNING_SONG}, 16, '{"version": 2}', 'Succeeded');
      INSERT INTO "Image" (id, url, type, ingestion, "userId", "nsfwLevel", "postId", "createdAt") VALUES
        (830, 'cover-key', 'image', 'Scanned', ${OWNER}, 8, NULL, '2026-11-01');
      INSERT INTO "Track" ("imageId", "coverImageId") VALUES (${SONG}, 830);
    `);
    const rows = (await disputes(WITH_GRANT)).items;
    expect(rows.find((r) => r.id === DISPUTE)?.scanLevel).toBe(8);
    expect(rows.find((r) => r.id === SCANNING_DISPUTE)?.scanLevel).toBeNull();

    // A blocked cover and an XGuard-only lyrics verdict (no result version) rate nothing.
    await db.exec(`
      UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = 830;
      UPDATE "EntityModeration" SET result = '{}' WHERE "entityType" = 'TrackLyrics' AND "entityId" = ${SONG};
    `);
    expect((await disputes(WITH_GRANT)).items[0]?.scanLevel).toBe(2);
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
      scanLevel: null,
      earlier: null,
      state: null,
      disputes: null,
    });
    // Its ask is not shown, so it is in neither ask chip.
    expect((await disputes(WITHOUT_GRANT)).facets).toEqual({ all: 3, lower: 1, higher: 1 });
    expect((await disputes(WITHOUT_GRANT, { filter: 'higher' })).items.map((r) => r.id)).toEqual([
      SCANNING_DISPUTE,
    ]);
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
  it('records the rating it applied with the level it replaced', async () => {
    await resolve({ reviewId: String(DISPUTE), appliedLevel: '1' });
    await flush();
    const { rows } = await db.query<{ details: unknown }>(
      `SELECT details FROM "ModActivity" WHERE activity = 'setNsfwLevel' AND "entityId" = ${SONG}`
    );
    expect(rows.map((r) => r.details)).toEqual([{ from: 2, to: 1 }]);
  });

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

  it("judges a keep on the song's live level, not the level the owner disputed", async () => {
    // Rated R by a moderator after the owner disputed PG-13.
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = ${SONG}`);
    expect(await resolve({ reviewId: String(DISPUTE), appliedLevel: '4' })).toMatchObject({
      status: 409,
      data: { key: DISPUTE },
    });
    expect(await review(DISPUTE)).toMatchObject({ status: 'Pending' });
    expect(await song(SONG)).toEqual({ nsfwLevel: 4, nsfwLevelLocked: false });
    // The disputed level is a change from R: no reason needed, and it is applied.
    expect(await resolve({ reviewId: String(DISPUTE), appliedLevel: '2' })).toMatchObject({
      success: true,
      status: 'Unactioned',
    });
    expect(await review(DISPUTE)).toMatchObject({ status: 'Unactioned', appliedLevel: 2 });
    expect(await song(SONG)).toEqual({ nsfwLevel: 2, nsfwLevelLocked: true });
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

describe('the Disputes tab by status and owner', () => {
  const load = (user: { id: number; roles: string[] }, query: string) =>
    page.load({
      url: new URL(`https://mod.example/audio-review?tab=disputes&${query}`),
      locals: { user, grants: GRANTS },
    } as never) as Promise<{
      disputes: Awaited<ReturnType<typeof getSongDisputes>> & { filters: object };
      counts: Record<string, number>;
    }>;

  it('lists resolved disputes with their ruling, read-only, and keeps the badge on the pending ones', async () => {
    const loaded = await load(WITH_GRANT, 'status=resolved');
    expect(loaded.disputes.items.map((r) => r.id)).toEqual([EARLIER]);
    const [row] = loaded.disputes.items;
    expect(row).toMatchObject({
      status: 'Unactioned',
      disputes: 1,
      earlier: null,
      ruling: { appliedLevel: 2, by: 'mod', resolvedAt: expect.any(Date) },
    });
    expect(disputeKeysEnabled(row, true)).toEqual([false, false, false, false, false]);
    expect(loaded.disputes.filters).toMatchObject({ status: 'resolved' });
    expect(loaded.counts.disputes).toBe(3);
    expect((await load(WITH_GRANT, 'status=all')).disputes.items.map((r) => r.id)).toEqual([
      EARLIER,
      DISPUTE,
      SCANNING_DISPUTE,
      WITHHELD_DISPUTE,
    ]);
    const [pending] = (await disputes(WITH_GRANT)).items;
    expect(pending).toMatchObject({ status: 'Pending', ruling: null, disputes: 2 });
    expect(pending.earlier).toMatchObject({
      status: 'Unactioned',
      appliedLevel: 2,
      currentLevel: 2,
    });
  });

  it('lists one owner, never a withheld song, and sends a withheld song no ruling or history', async () => {
    await db.exec(`
      INSERT INTO "RatingReview" (id, "entityType", "entityId", "userId", "currentLevel", "suggestedLevel",
        "appliedLevel", status, "resolvedBy", "resolvedAt", "createdAt") VALUES
        (15, 'Song', ${WITHHELD_SONG}, ${OWNER}, 1, 2, 1, 'Unactioned', ${MOD}, '2026-10-20', '2026-10-19');
    `);
    expect(
      (await load(WITHOUT_GRANT, `owner=${OWNER}&status=all`)).disputes.items.map((r) => r.id)
    ).toEqual([EARLIER, DISPUTE, SCANNING_DISPUTE]);
    expect((await load(WITH_GRANT, `owner=${OTHER}`)).disputes.items).toEqual([]);
    const all = (await disputes(WITHOUT_GRANT, { status: 'all' })).items;
    expect(all.find((r) => r.id === 15)).toMatchObject({ status: 'Resolved' });
    expect(all.find((r) => r.id === WITHHELD_DISPUTE)).toMatchObject({ status: 'Pending' });
    for (const id of [15, WITHHELD_DISPUTE])
      expect(all.find((r) => r.id === id)).toMatchObject({
        withheld: true,
        ruling: null,
        earlier: null,
        disputes: null,
      });
  });
});

describe("the open dispute's details", () => {
  const get = async (
    imageId: number,
    tab = 'disputes',
    user = WITH_GRANT,
    grants: Record<string, boolean> = GRANTS
  ) => {
    const res = await details.GET({
      params: { imageId: String(imageId) },
      url: new URL(`https://mod.example/audio-review/details/${imageId}?tab=${tab}`),
      locals: { user, grants },
    } as never);
    return { status: res.status, body: await res.json() };
  };

  it("tallies the owner's song disputes, none on a song withheld from this moderator", async () => {
    expect((await get(SONG)).body.owner.disputes).toEqual({
      total: 4,
      pending: 3,
      approved: 0,
      rejected: 1,
    });
    expect((await get(SONG, 'disputes', WITHOUT_GRANT)).body.owner.disputes).toEqual({
      total: 3,
      pending: 2,
      approved: 0,
      rejected: 1,
    });
  });

  it('says who set the current rating, when, and what it was before a ruling', async () => {
    await db.exec(`UPDATE "Image" SET "scannedAt" = '2026-11-01T10:00:00Z' WHERE id = ${SONG}`);
    expect((await get(SONG)).body.rating).toEqual({
      source: 'scan',
      by: null,
      at: '2026-11-01T10:00:00.000Z',
      before: null,
      recorded: true,
    });
    await resolve({ reviewId: String(DISPUTE), appliedLevel: '1' });
    await flush();
    expect((await get(SONG)).body.rating).toMatchObject({
      source: 'moderator',
      by: 'mod',
      before: 2,
      recorded: true,
    });
  });

  it('credits no one for a write that kept the level', async () => {
    await resolve({ reviewId: String(DISPUTE), appliedLevel: '2', modComment: 'Fits PG-13.' });
    await flush();
    expect((await get(SONG)).body.rating).toEqual({
      source: 'unknown',
      by: null,
      at: null,
      before: null,
      recorded: false,
    });
  });

  it('names the last moderator of a rating recorded before its levels were, with no level before it', async () => {
    await db.exec(`
      UPDATE "Image" SET "nsfwLevelLocked" = true WHERE id = ${SONG};
      INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity, "createdAt")
        VALUES (${MOD}, 'image', ${SONG}, 'setNsfwLevel', '2026-10-28');
    `);
    expect((await get(SONG)).body.rating).toEqual({
      source: 'moderator',
      by: 'mod',
      at: '2026-10-28T00:00:00.000Z',
      before: null,
      recorded: false,
    });
  });

  it("reads the song's plays, likes and comments for that song alone", async () => {
    metricRows.current = [
      { metricType: 'Play', value: '742' },
      { metricType: 'Like', value: '40' },
      { metricType: 'Heart', value: '3' },
      { metricType: 'commentCount', value: '6' },
    ];
    expect((await get(SONG)).body.activity).toEqual({ plays: 742, likes: 40, comments: 6 });
    expect(metricQueries).toEqual([{ songId: SONG }]);
  });

  it('names the lyrics scan by its verdict, and none for a song without lyrics', async () => {
    expect((await get(SONG)).body.checks).toMatchObject({ song: 'passed', lyrics: null });
    await db.exec(`
      INSERT INTO "TrackLyrics" ("imageId", text, lines, source) VALUES (${SONG}, 'words', '[]', 'user');
      INSERT INTO "EntityModeration" ("entityType", "entityId", status, blocked) VALUES ('TrackLyrics', ${SONG}, 'Succeeded', false);
    `);
    expect((await get(SONG)).body.checks).toMatchObject({ lyrics: 'passed' });
  });

  it('shows a CSAM lyrics hold as held only to a moderator who can open CSAM holds', async () => {
    await db.exec(`
      INSERT INTO "TrackLyrics" ("imageId", text, lines, source) VALUES (${SONG}, 'words', '[]', 'user');
      INSERT INTO "TextScanHold" (id, "entityType", "entityId", label, status) VALUES (1, 'TrackLyrics', ${SONG}, 'csam', 'Pending');
    `);
    const holds = { ...GRANTS, 'csam.report.file': true };
    expect((await get(SONG, 'disputes', WITH_GRANT, holds)).body.checks.lyrics).toBe('held');
    expect((await get(SONG)).body.checks.lyrics).toBe('pending');
  });

  it('reads the tallies and rating on the Disputes tab only, and nothing for a withheld song', async () => {
    const reported = (await get(SONG, 'reported')).body;
    expect(reported.owner.disputes).toBeNull();
    expect(reported.rating).toBeNull();
    expect((await get(WITHHELD_SONG, 'disputes', WITHOUT_GRANT)).status).toBe(404);
  });
});
