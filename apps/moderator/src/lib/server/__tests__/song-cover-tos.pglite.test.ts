import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A song and its cover are removed apart (Music T10 item 2, docs/features/music.md "Moderating
 * songs"): both are `blockImage` on their own row. Removing the cover leaves the song public with the
 * placeholder; removing the song leaves the cover alone; each removal carries its own violation type
 * and leaves its own row appealable. A cover in a queue links back to its song (`getSongLinks`).
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../removal-hold', () => ({
  // No approved appeals here; the hold itself is covered by image-removal-confirmation.pglite.test.ts.
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
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
// The notice, analytics and caches a block fires: what they are given is asserted, their own
// behaviour has its own suites (song-tos-notice.pglite.test.ts for the notice).
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({
  insertModActivity: vi.fn(async () => 1),
  recordModActivity: vi.fn(async () => undefined),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { blockImage } = await import('../image-moderation.service');
const { applyBlockSideEffects } = await import('../image-moderation-effects');
const { getSongCard } = await import('../song-card.service');
const { getSongLinks } = await import('../song-links.service');

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'key',
  "type" TEXT NOT NULL DEFAULT 'image',
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT false
);
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending'
);
CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE);
CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL);
`;

const OWNER = 7;
const SONG = 20;
const COVER = 120;
/** A song whose cover sits in a post: not the song's own cover, so nothing links them. */
const POSTED_SONG = 21;
const POSTED_COVER = 121;
const PICTURE = 30;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Image" (id, type, "userId", "postId", metadata) VALUES
      (${SONG}, 'audio', ${OWNER}, 5, '{"title": "Night drive", "parentId": null}'),
      (${COVER}, 'image', ${OWNER}, NULL, '{"parentId": ${SONG}}'),
      (${POSTED_SONG}, 'audio', ${OWNER}, 6, NULL),
      (${POSTED_COVER}, 'image', ${OWNER}, 6, NULL),
      (${PICTURE}, 'image', ${OWNER}, 7, NULL);
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES
      (${SONG}, ${COVER}), (${POSTED_SONG}, ${POSTED_COVER});
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  vi.mocked(applyBlockSideEffects).mockClear();
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const row = async (id: number) =>
  (await db.query(`SELECT * FROM "Image" WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

/** What `isAppealableImage` (src/shared/utils/appeal.ts) reads: a moderator removal, no review flag. */
const appealable = (image: Record<string, unknown>) =>
  image.blockedFor === 'moderated' && image.needsReview == null;

const sideEffectsFor = (imageId: number) =>
  vi
    .mocked(applyBlockSideEffects)
    .mock.calls.filter(([, actor]) => actor.imageId === imageId)
    .map(([, actor]) => actor.violationType);

describe('Remove cover', () => {
  it('leaves the song public with the placeholder', async () => {
    const song = await row(SONG);
    expect((await getSongCard(SONG))?.cover).toEqual({ id: COVER, url: 'key' });

    await blockImage({ imageId: COVER, userId: 2, violationType: 'gore' });

    expect(await row(SONG)).toEqual(song);
    expect(await row(COVER)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    // The player's rule: a blocked cover is the placeholder, the song itself still plays.
    expect(await getSongCard(SONG)).toMatchObject({ id: SONG, cover: null });
  });

  it('records its own violation type and leaves the cover appealable on its own', async () => {
    await blockImage({ imageId: COVER, userId: 2, violationType: 'gore' });

    expect(sideEffectsFor(COVER)).toEqual(['gore']);
    expect(sideEffectsFor(SONG)).toEqual([]);
    expect(appealable(await row(COVER))).toBe(true);
    expect(appealable(await row(SONG))).toBe(false);
  });
});

describe('Remove song', () => {
  it('takes the song off the site and leaves the cover alone', async () => {
    const cover = await row(COVER);

    await blockImage({ imageId: SONG, userId: 2, violationType: 'realPerson' });

    expect(await row(COVER)).toEqual(cover);
    expect(await row(SONG)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: 32 });
  });

  it('records its own violation type and leaves the song appealable on its own', async () => {
    await blockImage({ imageId: SONG, userId: 2, violationType: 'realPerson' });
    await blockImage({ imageId: COVER, userId: 2, violationType: 'gore' });

    expect(sideEffectsFor(SONG)).toEqual(['realPerson']);
    expect(sideEffectsFor(COVER)).toEqual(['gore']);
    expect(appealable(await row(SONG))).toBe(true);
    expect(appealable(await row(COVER))).toBe(true);
  });
});

describe('an image removal', () => {
  it('is unchanged: one row blocked, its own violation type', async () => {
    await blockImage({ imageId: PICTURE, userId: 2, violationType: 'realPerson' });

    expect(await row(PICTURE)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(sideEffectsFor(PICTURE)).toEqual(['realPerson']);
  });
});

describe('getSongLinks', () => {
  it('gives a song its cover to remove, and a cover the song it links to', async () => {
    const links = await getSongLinks([SONG, COVER, PICTURE]);
    expect(links.get(SONG)).toEqual({ songCoverId: COVER, coverOf: null });
    expect(links.get(COVER)).toEqual({
      songCoverId: null,
      coverOf: { songId: SONG, title: 'Night drive' },
    });
    expect(links.get(PICTURE)).toBeUndefined();
  });

  it("links nothing for a cover in a post, which is not the song's own", async () => {
    const links = await getSongLinks([POSTED_SONG, POSTED_COVER]);
    expect(links.size).toBe(0);
  });

  it('offers no cover to remove once the cover is removed, and still links the cover to its song', async () => {
    await blockImage({ imageId: COVER, userId: 2 });
    const links = await getSongLinks([SONG, COVER]);
    expect(links.get(SONG)).toBeUndefined();
    expect(links.get(COVER)?.coverOf).toEqual({ songId: SONG, title: 'Night drive' });
  });
});
