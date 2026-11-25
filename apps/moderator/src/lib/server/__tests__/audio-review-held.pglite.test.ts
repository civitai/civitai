import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';

/**
 * Audio review's Held tab (Music T10 item 4, docs/features/music.md "Moderating songs"): songs whose
 * lyrics are under a CSAM text hold, songs whose own cover is flagged for review and songs flagged
 * themselves; what each row carries, the decisions and their grants, and the songs the generic image
 * review queues leave to this tab. Real SQL against pglite.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
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
// ClickHouse is the boundary: the scanner has no rows.
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { getHeldSongs } = await import('../audio-review.service');
const { countHeldSongs, songTabCounts } = await import('../audio-review-count');
const { getImageReviewQueue, getImageReviewCounts } = await import('../image-review.service');
const page = await import('../../../routes/audio-review/+page.server');

const OWNER = 7;
const OTHER = 1;
// Its lyrics are under a Pending CSAM text hold (the song carries the csam flag, as
// `holdSongForCsam` leaves it); its own cover is flagged too.
const LYRICS_SONG = 701;
const LYRICS_COVER = 711;
// Its lyrics hold was decided.
const DECIDED_SONG = 702;
// Its own cover is flagged for review.
const COVER_SONG = 703;
const FLAGGED_COVER = 713;
// The image named as its cover is someone else's: not the song's own.
const FOREIGN_SONG = 704;
const FOREIGN_COVER = 714;
// Its cover is under CSAM review: the CSAM queue's, not this tab's.
const CSAM_SONG = 705;
const CSAM_COVER = 715;
// Flagged itself by a moderation rule.
const FLAGGED_SONG = 706;
const PICTURE = 707;
// Its flagged cover shares a key with an image in the CSAM queue: withheld without the grant.
const WITHHELD_SONG = 708;
const WITHHELD_COVER = 718;

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };
const GRANTS = { 'image.moderate': true };
const ALL_LEVELS = 0x7fffffff;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(`
    CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, genre TEXT);
    CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL, source TEXT);
    ${SET_ASIDE_TABLE_SQL}
    ${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
    ALTER TABLE "TextScanHold" ADD COLUMN "userId" INTEGER, ADD COLUMN text TEXT,
      ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now();
    CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
    CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
      PRIMARY KEY ("entityType", "entityId", "type"));
    CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
    CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
    CREATE TABLE "ModerationRule" (id INTEGER PRIMARY KEY, action TEXT NOT NULL);
    CREATE TABLE "ModerationRuleVersion" (id SERIAL PRIMARY KEY, "ruleId" INTEGER NOT NULL, action TEXT NOT NULL);
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS image TEXT;
    CREATE TABLE IF NOT EXISTS "CsamReport" (id SERIAL PRIMARY KEY, "userId" INTEGER, "reportSentAt" TIMESTAMP(3), images JSONB NOT NULL DEFAULT '[]', details JSONB);
    ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'Image';
    CREATE TABLE "UserStrike" ("userId" INTEGER, points INTEGER, status TEXT, "voidedAt" TIMESTAMP, "expiresAt" TIMESTAMP);
    CREATE TABLE "RatingReview" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, status TEXT NOT NULL);
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${OTHER}, 'other');
    INSERT INTO "Image" (id, url, type, ingestion, "userId", "needsReview", "nsfwLevel", metadata, "createdAt") VALUES
      (${LYRICS_SONG}, 'lyrics-key', 'audio', 'Scanned', ${OWNER}, 'csam', 1, '{"title": "Hush"}', '2026-11-01'),
      (${LYRICS_COVER}, 'lyrics-cover', 'image', 'Scanned', ${OWNER}, 'minor', 1, NULL, '2026-11-01'),
      (${DECIDED_SONG}, 'decided-key', 'audio', 'Scanned', ${OWNER}, NULL, 1, '{"title": "Done"}', '2026-11-01'),
      (${COVER_SONG}, 'cover-song-key', 'audio', 'Scanned', ${OWNER}, NULL, 1, '{"title": "Orbit Garden"}', '2026-11-02'),
      (${FLAGGED_COVER}, 'flagged-cover', 'image', 'Scanned', ${OWNER}, 'tag', 2, NULL, '2026-11-03'),
      (${FOREIGN_SONG}, 'foreign-key', 'audio', 'Scanned', ${OWNER}, NULL, 1, '{"title": "Borrowed"}', '2026-11-02'),
      (${FOREIGN_COVER}, 'foreign-cover', 'image', 'Scanned', ${OTHER}, 'tag', 1, NULL, '2026-11-02'),
      (${CSAM_SONG}, 'csam-song-key', 'audio', 'Scanned', ${OWNER}, NULL, 1, '{"title": "Lantern"}', '2026-11-02'),
      (${CSAM_COVER}, 'csam-cover', 'image', 'Scanned', ${OWNER}, 'csam', 1, NULL, '2026-11-02'),
      (${FLAGGED_SONG}, 'flagged-song-key', 'audio', 'Scanned', ${OWNER}, 'modRule', 1, '{"title": "Pocket Thunder"}', '2026-11-04'),
      (${PICTURE}, 'picture-key', 'image', 'Scanned', ${OWNER}, 'tag', 1, NULL, '2026-11-02'),
      (${WITHHELD_SONG}, 'withheld-song-key', 'audio', 'Scanned', ${OWNER}, NULL, 1, '{"title": "Dandelion"}', '2026-11-02'),
      (${WITHHELD_COVER}, 'shared-cover', 'image', 'Scanned', ${OWNER}, 'tag', 1, NULL, '2026-11-05'),
      (719, 'shared-cover', 'image', 'Pending', ${OTHER}, 'csam', 0, NULL, '2026-11-05');
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES
      (${LYRICS_SONG}, ${LYRICS_COVER}), (${COVER_SONG}, ${FLAGGED_COVER}),
      (${FOREIGN_SONG}, ${FOREIGN_COVER}), (${CSAM_SONG}, ${CSAM_COVER}),
      (${FLAGGED_SONG}, NULL), (${WITHHELD_SONG}, ${WITHHELD_COVER});
    INSERT INTO "TextScanHold" (id, "entityType", "entityId", label, status, "userId", text, "createdAt") VALUES
      (1, 'TrackLyrics', ${LYRICS_SONG}, 'csam', 'Pending', ${OWNER}, 'held words', '2026-10-30'),
      (2, 'TrackLyrics', ${DECIDED_SONG}, 'csam', 'Dismissed', ${OWNER}, 'cleared words', '2026-10-29'),
      (3, 'Post', ${COVER_SONG}, 'csam', 'Pending', ${OWNER}, 'a post', '2026-10-28');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const held = (
  user: { id: number; roles: string[] },
  opts: Partial<Parameters<typeof getHeldSongs>[0]> = {}
) =>
  getHeldSongs({
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
const pageAction = (
  action: keyof typeof page.actions,
  fields: Record<string, string>,
  grants: Record<string, boolean> = GRANTS,
  user = WITH_GRANT
) =>
  page.actions[action]({
    request: new Request('https://mod.example/audio-review?tab=held', {
      method: 'POST',
      body: formOf(fields),
    }),
    locals: { user, grants },
    getClientAddress: () => '127.0.0.1',
    url: new URL('https://mod.example/audio-review?tab=held'),
  } as never);
const imageRow = async (id: number) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM "Image" WHERE id = ${id}`)).rows[0];

describe('the Held tab', () => {
  it('lists songs under a Pending lyrics hold, songs with a flagged own cover and flagged songs, nothing else', async () => {
    const { items, facets } = await held(WITH_GRANT);
    expect(items.map((r) => [r.id, r.kind])).toEqual([
      [LYRICS_SONG, 'lyrics'],
      [COVER_SONG, 'cover'],
      [FLAGGED_SONG, 'song'],
      [WITHHELD_SONG, 'cover'],
    ]);
    expect(facets).toEqual({ all: 4, lyrics: 1, cover: 2, song: 1 });
    expect((await held(WITH_GRANT, { filter: 'cover' })).items.map((r) => r.id)).toEqual([
      COVER_SONG,
      WITHHELD_SONG,
    ]);
    expect((await held(WITH_GRANT, { sort: 'newest' })).items.map((r) => r.id)).toEqual([
      WITHHELD_SONG,
      FLAGGED_SONG,
      COVER_SONG,
      LYRICS_SONG,
    ]);
  });

  it('sends a lyrics-held song with no title, media, cover, owner or text, to every moderator', async () => {
    for (const user of [WITH_GRANT, WITHOUT_GRANT]) {
      const row = (await held(user)).items.find((r) => r.id === LYRICS_SONG);
      expect(row).toEqual({
        id: LYRICS_SONG,
        kind: 'lyrics',
        withheld: true,
        holdId: 1,
        waitingSince: expect.any(Date),
        title: null,
        url: null,
        coverUrl: null,
        cover: null,
        flag: null,
        nsfwLevel: null,
        owner: null,
        removed: false,
        removableCoverId: null,
      });
      // Its title and owner do not find it; its exact id does.
      expect((await held(user, { q: 'Hush' })).items).toEqual([]);
      expect((await held(user, { q: 'owner' })).items.map((r) => r.id)).not.toContain(LYRICS_SONG);
      expect((await held(user, { q: String(LYRICS_SONG) })).items.map((r) => r.id)).toEqual([
        LYRICS_SONG,
      ]);
    }
  });

  it('sends a flagged cover with the song, and a withheld one with nothing but its id', async () => {
    const open = (await held(WITH_GRANT)).items.find((r) => r.id === COVER_SONG);
    expect(open).toMatchObject({
      kind: 'cover',
      withheld: false,
      title: 'Orbit Garden',
      url: 'cover-song-key',
      owner: { id: OWNER, username: 'owner' },
      cover: { id: FLAGGED_COVER, url: 'flagged-cover', flag: 'tag', nsfwLevel: 2 },
      removableCoverId: FLAGGED_COVER,
      flag: null,
    });
    expect((await held(WITH_GRANT)).items.find((r) => r.id === FLAGGED_SONG)).toMatchObject({
      kind: 'song',
      flag: 'modRule',
      title: 'Pocket Thunder',
    });
    const withheld = (await held(WITHOUT_GRANT)).items.find((r) => r.id === WITHHELD_SONG);
    expect(withheld).toMatchObject({
      kind: 'cover',
      withheld: true,
      title: null,
      url: null,
      coverUrl: null,
      cover: null,
      owner: null,
      removableCoverId: null,
    });
  });

  it('counts the songs decided here for the sidebar, and the lyrics holds apart', async () => {
    expect(await countHeldSongs()).toEqual({ lyrics: 1, actionable: 3 });
  });

  it('gives the Held tab the badge its list totals, whichever tab is open', async () => {
    const counts = await songTabCounts();
    for (const tab of ['held', 'reported'] as const) {
      const loaded = (await page.load({
        url: new URL(`https://mod.example/audio-review?tab=${tab}`),
        locals: { user: WITH_GRANT, grants: GRANTS },
      } as never)) as { counts: Record<string, number> };
      expect(loaded.counts, tab).toEqual(counts);
    }
  });
});

describe('the Open in CSAM holds link', () => {
  const load = (user: { id: number; roles: string[] }, grants: Record<string, boolean>) =>
    page.load({
      url: new URL('https://mod.example/audio-review?tab=held'),
      locals: { user, grants },
    } as never) as Promise<Record<string, unknown>>;

  it('is open only to a moderator who can reach CSAM holds and holds its grant', async () => {
    expect(await load(WITH_GRANT, { 'csam.report.file': true })).toMatchObject({
      tab: 'held',
      canOpenHolds: true,
    });
    expect(await load(WITH_GRANT, {})).toMatchObject({ canOpenHolds: false });
    // The grant without the page: the page refuses to open.
    expect(
      await load({ id: 4, roles: ['moderator:basic'] }, { 'csam.report.file': true })
    ).toMatchObject({ canOpenHolds: false });
  });
});

describe('Approve cover', () => {
  it('clears only the cover’s review flag: the song is untouched', async () => {
    const song = await imageRow(COVER_SONG);
    const result = await pageAction('approveCover', {
      imageId: String(COVER_SONG),
      coverId: String(FLAGGED_COVER),
      needsReview: 'tag',
    });
    expect(result).toMatchObject({ success: true, key: COVER_SONG });
    expect(await imageRow(FLAGGED_COVER)).toMatchObject({
      needsReview: null,
      ingestion: 'Scanned',
    });
    expect(await imageRow(COVER_SONG)).toEqual(song);
    expect((await held(WITH_GRANT)).items.map((r) => r.id)).not.toContain(COVER_SONG);
  });

  it('refuses a cover under CSAM review, a song with no flagged cover, and a changed flag', async () => {
    const before = (await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows;
    for (const [imageId, coverId] of [
      [CSAM_SONG, CSAM_COVER],
      [FLAGGED_SONG, FLAGGED_COVER],
      [FOREIGN_SONG, FOREIGN_COVER],
    ])
      expect(
        await pageAction('approveCover', {
          imageId: String(imageId),
          coverId: String(coverId),
          needsReview: 'tag',
        }),
        String(imageId)
      ).toMatchObject({ status: 409, data: { key: imageId } });
    expect(
      await pageAction('approveCover', {
        imageId: String(COVER_SONG),
        coverId: String(FLAGGED_COVER),
        needsReview: 'minor',
      })
    ).toMatchObject({ status: 409 });
    // Posting the CSAM flag it shows does not clear it here: that flag is the CSAM queue's.
    expect(
      await pageAction('approveCover', {
        imageId: String(CSAM_SONG),
        coverId: String(CSAM_COVER),
        needsReview: 'csam',
      })
    ).toMatchObject({ status: 409 });
    expect((await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows).toEqual(before);
  });

  it('refuses a withheld cover without the grant to see it', async () => {
    expect(
      await pageAction(
        'approveCover',
        { imageId: String(WITHHELD_SONG), coverId: String(WITHHELD_COVER), needsReview: 'tag' },
        GRANTS,
        WITHOUT_GRANT
      )
    ).toMatchObject({ status: 403 });
    expect((await imageRow(WITHHELD_COVER)).needsReview).toBe('tag');
  });

  it('refuses when the song has a new cover since the page showed one, even with the same flag', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, type, ingestion, "userId", "needsReview", "nsfwLevel", "createdAt")
        VALUES (730, 'new-cover', 'image', 'Scanned', ${OWNER}, 'tag', 1, '2026-11-06');
      UPDATE "Track" SET "coverImageId" = 730 WHERE "imageId" = ${COVER_SONG};
    `);
    expect(
      await pageAction('approveCover', {
        imageId: String(COVER_SONG),
        coverId: String(FLAGGED_COVER),
        needsReview: 'tag',
      })
    ).toMatchObject({ status: 409, data: { key: COVER_SONG } });
    expect((await imageRow(730)).needsReview).toBe('tag');
  });
});

describe('a flagged song', () => {
  it('Approve song clears the song’s flag', async () => {
    expect(
      await pageAction('approveSong', { imageId: String(FLAGGED_SONG), needsReview: 'modRule' })
    ).toMatchObject({ success: true, key: FLAGGED_SONG });
    expect((await imageRow(FLAGGED_SONG)).needsReview).toBeNull();
  });

  it('Approve song refuses a song that is not flagged for review here', async () => {
    for (const imageId of [COVER_SONG, LYRICS_SONG, PICTURE])
      expect(
        await pageAction('approveSong', { imageId: String(imageId), needsReview: '' }),
        String(imageId)
      ).toMatchObject({ status: 409 });
    expect(
      await pageAction('approveSong', { imageId: String(LYRICS_SONG), needsReview: 'csam' })
    ).toMatchObject({ status: 409 });
    expect((await imageRow(LYRICS_SONG)).needsReview).toBe('csam');
  });

  it('Remove song removes it with its violation type, and refuses anything else', async () => {
    expect(await pageAction('removeSong', { imageId: String(FLAGGED_SONG) })).toMatchObject({
      status: 400,
      data: { error: 'Pick a violation type.' },
    });
    expect(
      await pageAction('removeSong', { imageId: String(PICTURE), violationType: 'hate' })
    ).toMatchObject({ status: 404 });
    expect(
      await pageAction('removeSong', { imageId: String(FLAGGED_SONG), violationType: 'hate' })
    ).toMatchObject({ success: true, key: FLAGGED_SONG });
    expect(await imageRow(FLAGGED_SONG)).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
    });
  });
});

describe('every Held decision', () => {
  it('refuses without the image moderation grant and changes nothing', async () => {
    const before = (await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows;
    for (const action of [
      'approveCover',
      'approveSong',
      'removeSong',
      'removeCover',
      'setRating',
    ] as const)
      expect(
        await pageAction(
          action,
          {
            imageId: String(action === 'approveSong' ? FLAGGED_SONG : COVER_SONG),
            coverId: String(FLAGGED_COVER),
            needsReview: action === 'approveSong' ? 'modRule' : 'tag',
            violationType: 'hate',
            nsfwLevel: '2',
          },
          {}
        ),
        action
      ).toMatchObject({ status: 403 });
    expect((await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows).toEqual(before);
  });
});

describe('the generic image review queues', () => {
  const queue = async (needsReview: 'tag' | 'minor' | 'modRule' | 'csam') =>
    (await getImageReviewQueue({ needsReview, browsingLevel: ALL_LEVELS, limit: 50 })).items
      .map((i) => i.id)
      .sort();

  it('leave out the songs and own covers the Held tab decides, and keep everything else', async () => {
    // A picture and someone else's image named as a cover stay; the song's own flagged covers go.
    expect(await queue('tag')).toEqual([PICTURE, FOREIGN_COVER]);
    // The flagged cover of a lyrics-held song is not on the Held tab, so it stays.
    expect(await queue('minor')).toEqual([LYRICS_COVER]);
    expect(await queue('modRule')).toEqual([]);
    // The CSAM queue keeps songs and covers: the Held tab does not decide that flag.
    expect(await queue('csam')).toEqual([LYRICS_SONG, CSAM_COVER]);
  });

  it('count as they list', async () => {
    const counts = await getImageReviewCounts();
    expect(counts.tag).toBe(2);
    expect(counts.minor).toBe(1);
    expect(counts.modRule ?? 0).toBe(0);
    expect(counts.csam).toBe(2);
  });
});
