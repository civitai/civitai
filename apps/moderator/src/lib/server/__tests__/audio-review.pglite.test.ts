import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { RETRACTED_REFUSED } from '$lib/held-media';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * Audio review's Reported tab (Music T10, docs/features/music.md "Moderating songs"): one row per
 * song with Pending reports, the media access rule applied to it, and the refusals its decisions
 * make before they reach the image queue's shared writers. Real SQL against pglite.
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

const { getReportedSongs, boundSongReports } = await import('../audio-review.service');
const { countReportedSongs } = await import('../audio-review-count');
const page = await import('../../../routes/audio-review/+page.server');
const details = await import('../../../routes/audio-review/details/[imageId]/+server');
const { setImageFlag, SONG_FLAG_REFUSED } = await import('../user-actions.service');

const OWNER = 7;
const REPORTER_A = 8;
const REPORTER_B = 9;
const SONG = 601;
const QUIET_SONG = 602;
const RULED_SONG = 603;
const PICTURE = 604;
// Shares its key with an image still scanning, so the access rule withholds it without the grant.
const WITHHELD = 605;
// Blocked by an automated Block rule: its dismissal would restore it.
const RULE_SONG = 607;
const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };
const GRANTS = { 'image.moderate': true };

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(`
    CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE, genre TEXT);
    CREATE TABLE "TrackLyrics" ("imageId" INTEGER PRIMARY KEY, text TEXT NOT NULL, lines JSONB NOT NULL, source TEXT);
    CREATE TABLE "ModerationRule" (id INTEGER PRIMARY KEY, action TEXT NOT NULL);
    CREATE TABLE "ModerationRuleVersion" (id SERIAL PRIMARY KEY, "ruleId" INTEGER NOT NULL, action TEXT NOT NULL);
    INSERT INTO "ModerationRule" VALUES (1, 'Block');
    CREATE TABLE "UserStrike" ("userId" INTEGER, points INTEGER, status TEXT, "voidedAt" TIMESTAMP, "expiresAt" TIMESTAMP);
    INSERT INTO "User" (id, username) VALUES
      (${OWNER}, 'owner'), (${REPORTER_A}, 'reporter-a'), (${REPORTER_B}, 'reporter-b');
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", "userId", metadata) VALUES
      (${SONG}, 'song-key', 'audio', 'Scanned', NULL, ${OWNER}, '{"title": "Neon Rain"}'),
      (${QUIET_SONG}, 'quiet-key', 'audio', 'Scanned', NULL, ${OWNER}, '{"title": "Paper Boats"}'),
      (${RULED_SONG}, 'ruled-key', 'audio', 'Scanned', NULL, ${OWNER}, '{"title": "Ruled"}'),
      (${PICTURE}, 'picture-key', 'image', 'Scanned', NULL, ${OWNER}, NULL),
      (${WITHHELD}, 'shared-key', 'audio', 'Blocked', 'moderated', ${OWNER}, '{"title": "Held"}'),
      (606, 'shared-key', 'image', 'Pending', NULL, 1, NULL),
      (${RULE_SONG}, 'rule-key', 'audio', 'Blocked', 'moderated', ${OWNER}, '{"title": "Rule", "ruleId": 1}'),
      (620, 'cover-key', 'image', 'Scanned', NULL, ${OWNER}, NULL),
      (622, 'shared-cover', 'image', 'Blocked', 'moderated', ${OWNER}, NULL),
      (623, 'shared-cover', 'image', 'Pending', NULL, 1, NULL);
    INSERT INTO "Image" (id, url, type, ingestion, "userId", "needsReview", "nsfwLevel") VALUES
      (621, 'quiet-cover', 'image', 'Scanned', ${OWNER}, 'minor', 1);
    UPDATE "Image" SET "nsfwLevel" = 2 WHERE id = 620;
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES
      (${SONG}, 620), (${QUIET_SONG}, 621), (${RULE_SONG}, 622);
    INSERT INTO "Report" (id, "userId", reason, status, details, "createdAt", "alsoReportedBy") VALUES
      (11, ${REPORTER_A}, 'TOSViolation', 'Pending', '{"comment": "Bullying line", "timestampSec": 84}', '2026-11-01', '{${REPORTER_B}}'),
      (12, ${REPORTER_B}, 'Spam', 'Pending', NULL, '2026-11-02', NULL),
      (13, ${REPORTER_A}, 'TOSViolation', 'Actioned', NULL, '2026-10-01', NULL),
      (14, ${REPORTER_A}, 'Automated', 'Pending', NULL, '2026-10-02', NULL),
      (15, ${REPORTER_A}, 'TOSViolation', 'Pending', NULL, '2026-11-03', NULL),
      (16, ${REPORTER_A}, 'TOSViolation', 'Pending', NULL, '2026-10-15', NULL),
      (17, ${REPORTER_B}, 'TOSViolation', 'Pending', '{"comment": "names a person", "timestampSec": 3}', '2026-11-04', NULL),
      (18, ${REPORTER_A}, 'TOSViolation', 'Pending', NULL, '2026-10-20', NULL);
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
      (${SONG}, 11), (${SONG}, 12), (${RULED_SONG}, 13), (${QUIET_SONG}, 14),
      (${QUIET_SONG}, 15), (${PICTURE}, 16), (${WITHHELD}, 17), (${RULE_SONG}, 18);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const reported = (
  user: { id: number; roles: string[] },
  opts: Partial<Parameters<typeof getReportedSongs>[0]> = {}
) =>
  getReportedSongs({
    sort: 'oldest',
    filter: 'all',
    q: '',
    page: 1,
    user: user as never,
    ...opts,
  });

describe('the Reported tab', () => {
  it('lists each song with Pending reports once, its reports under it, and no picture', async () => {
    const { items, total } = await reported(WITH_GRANT);
    expect(total).toBe(4);
    expect(items.map((r) => [r.id, r.reportCount, r.reports.map((x) => x.id)])).toEqual([
      [RULE_SONG, 1, [18]],
      [SONG, 3, [11, 12]],
      [QUIET_SONG, 1, [15]],
      [WITHHELD, 1, [17]],
    ]);
    expect(items[1]).toMatchObject({
      title: 'Neon Rain',
      url: 'song-key',
      owner: { id: OWNER, username: 'owner' },
      withheld: false,
      removed: false,
      removal: null,
      coverUrl: 'cover-key',
    });
    expect(items[0]).toMatchObject({
      removed: true,
      removal: { blockedFor: 'moderated', ruleBlocked: true, needsReview: null },
    });
    expect(items.find((r) => r.id === QUIET_SONG)?.coverUrl).toBeNull();
    expect(items[1].reports[0]).toMatchObject({
      label: 'TOSViolation',
      comment: 'Bullying line',
      timeSec: 84,
      also: 1,
      reporter: { id: REPORTER_A, username: 'reporter-a' },
    });
    expect(items[1].reports[1].timeSec).toBeNull();
  });

  it('narrows to songs with a reported time or three reporters, and counts each chip', async () => {
    const timed = await reported(WITH_GRANT, { filter: 'timed' });
    expect(timed.items.map((r) => r.id)).toEqual([SONG, WITHHELD]);
    expect(timed.facets).toEqual({ all: 4, timed: 2, many: 1 });
    expect((await reported(WITH_GRANT, { filter: 'many' })).items.map((r) => r.id)).toEqual([SONG]);
    expect((await reported(WITH_GRANT, { sort: 'newest' })).items.map((r) => r.id)).toEqual([
      WITHHELD,
      QUIET_SONG,
      SONG,
      RULE_SONG,
    ]);
    expect((await reported(WITH_GRANT, { q: 'paper' })).items.map((r) => r.id)).toEqual([
      QUIET_SONG,
    ]);
  });

  it('sends a withheld song with no title, media, owner or report text', async () => {
    const withheld = (await reported(WITHOUT_GRANT)).items.find((r) => r.id === WITHHELD);
    expect(withheld).toMatchObject({
      withheld: true,
      title: null,
      url: null,
      coverUrl: null,
      owner: null,
      nsfwLevel: null,
      removed: true,
      removal: null,
      reportCount: 1,
    });
    expect(withheld?.reports).toEqual([
      expect.objectContaining({ id: 17, label: '', comment: null, timeSec: null }),
    ]);
    const open = (await reported(WITH_GRANT)).items.find((r) => r.id === WITHHELD);
    expect(open).toMatchObject({ withheld: false, title: 'Held' });
  });

  it('matches a withheld song only by its exact id, and leaves it out of the time chip', async () => {
    const ids = async (q: string) => (await reported(WITHOUT_GRANT, { q })).items.map((r) => r.id);
    expect(await ids('Held')).toEqual([]);
    expect(await ids('own')).toEqual([RULE_SONG, SONG, QUIET_SONG]);
    expect(await ids(String(WITHHELD))).toEqual([WITHHELD]);
    const { facets } = await reported(WITHOUT_GRANT);
    expect(facets).toEqual({ all: 4, timed: 1, many: 1 });
    expect((await reported(WITHOUT_GRANT, { filter: 'timed' })).items.map((r) => r.id)).toEqual([
      SONG,
    ]);
    expect(
      await (async () => (await reported(WITH_GRANT, { q: 'Held' })).items.map((r) => r.id))()
    ).toEqual([WITHHELD]);
  });

  it('counts songs and their reports for the sidebar', async () => {
    expect(await countReportedSongs()).toEqual({ songs: 4, reports: 5 });
  });
});

describe('a decision on a song', () => {
  it('closes only the Pending reports filed on that song', async () => {
    expect(await boundSongReports(SONG, [11, 12, 13, 15, 16, 999])).toEqual([11, 12]);
    expect(await boundSongReports(PICTURE, [16])).toEqual([]);
  });

  const act = (
    action: 'dismiss' | 'remove' | 'setRating',
    fields: Record<string, string>,
    grants: Record<string, boolean> = GRANTS
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return page.actions[action]({
      request: new Request('https://mod.example/audio-review', { method: 'POST', body: form }),
      locals: { user: WITH_GRANT, grants },
      getClientAddress: () => '127.0.0.1',
      url: new URL('https://mod.example/audio-review'),
    } as never);
  };

  it('refuses a dismissal or removal whose reports are no longer Pending on that song', async () => {
    for (const action of ['dismiss', 'remove'] as const)
      expect(
        await act(action, { imageId: String(SONG), reportIds: '13,16', violationType: 'hate' })
      ).toMatchObject({ status: 409, data: { key: SONG } });
  });

  it('refuses a removal with no violation type', async () => {
    expect(await act('remove', { imageId: String(SONG), reportIds: '11,12' })).toMatchObject({
      status: 400,
      data: { error: 'Pick a violation type.', key: SONG },
    });
  });

  it('refuses a rating outside PG to XXX, and a rating of something that is not a song', async () => {
    expect(await act('setRating', { imageId: String(SONG), nsfwLevel: '32' })).toMatchObject({
      status: 400,
      data: { key: SONG },
    });
    expect(await act('setRating', { imageId: String(PICTURE), nsfwLevel: '2' })).toMatchObject({
      status: 404,
      data: { key: PICTURE },
    });
  });

  it('refuses every decision without the image moderation grant', async () => {
    expect(await act('dismiss', { imageId: String(SONG), reportIds: '11' }, {})).toMatchObject({
      status: 403,
    });
  });
});

describe('Minor and POI on a song', () => {
  it('cannot be set by any writer, and nothing reaches the main app', async () => {
    const result = await setImageFlag({
      imageIds: [PICTURE, SONG],
      flag: 'minor',
      value: true,
      moderatorId: 3,
    });
    expect(result).toEqual({
      ok: false,
      error: `${SONG_FLAG_REFUSED} Nothing was changed: ${SONG}.`,
    });
    expect(
      await setImageFlag({ imageIds: [SONG], flag: 'poi', value: true, moderatorId: 3 })
    ).toMatchObject({ ok: false });
  });

  it('can still be cleared, which goes on to the main app', async () => {
    // No WEBHOOK_TOKEN in this test: reaching the call is the refusal it answers with.
    expect(
      await setImageFlag({ imageIds: [SONG], flag: 'minor', value: false, moderatorId: 3 })
    ).toEqual({ ok: false, error: 'WEBHOOK_TOKEN is not configured.' });
  });
});

describe('the open song details', () => {
  const get = async (user: { id: number; roles: string[] }, imageId: number) => {
    const res = await details.GET({
      params: { imageId: String(imageId) },
      locals: { user },
    } as never);
    return { status: res.status, body: await res.json() };
  };

  it('refuses a withheld song without the grant, owner and all', async () => {
    expect(await get(WITHOUT_GRANT, WITHHELD)).toEqual({
      status: 404,
      body: { message: RETRACTED_REFUSED },
    });
  });

  it('answers a song with its facts, scans and owner', async () => {
    const { status, body } = await get(WITH_GRANT, SONG);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      checks: { song: 'passed', cover: 'passed' },
      owner: { id: OWNER, username: 'owner', strikes: 0, removedSongs: 2, otherReported: 3 },
      cover: { id: 620, url: 'cover-key', nsfwLevel: 2, shown: true },
    });
    expect((await get(WITH_GRANT, PICTURE)).status).toBe(404);
  });

  it('sends a cover the public player would not show, or one withheld, without its file', async () => {
    expect((await get(WITH_GRANT, QUIET_SONG)).body.cover).toEqual({
      id: 621,
      url: null,
      nsfwLevel: 1,
      shown: false,
    });
    expect((await get(WITHOUT_GRANT, RULE_SONG)).body.cover).toMatchObject({ id: 622, url: null });
  });
});
