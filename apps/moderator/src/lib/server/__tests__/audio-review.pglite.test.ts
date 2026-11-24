import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { RETRACTED_REFUSED, WITHHELD_REFUSED } from '$lib/held-media';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';

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

const { getReportedSongs, getReportedSongRows, boundSongReports, getSongAppeals } = await import(
  '../audio-review.service'
);
const { getAppealImageQueue } = await import('../image-review.service');
const { loadImageQueue } = await import('../image-queue');
const { countReportedSongs, withSongBadges } = await import('../audio-review-count');
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
    ${SET_ASIDE_TABLE_SQL}
    ${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
    CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
    CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
      PRIMARY KEY ("entityType", "entityId", "type"));
    CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
    CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
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
      (18, ${REPORTER_A}, 'TOSViolation', 'Pending', NULL, '2026-10-20', NULL),
      (19, ${REPORTER_B}, 'TOSViolation', 'Actioned', NULL, '2026-09-01', NULL);
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
      (${SONG}, 11), (${SONG}, 12), (${RULED_SONG}, 13), (${QUIET_SONG}, 14),
      (${QUIET_SONG}, 15), (${PICTURE}, 16), (${WITHHELD}, 17), (${RULE_SONG}, 18), (${SONG}, 19);
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

  it('moves the song reports out of the Image Reports badge into Audio review', () => {
    const reports = { 'report:image': 12, 'report:post': 3 };
    expect(withSongBadges(reports, { songs: 4, reports: 5 })).toEqual({
      'report:image': 7,
      'report:post': 3,
      audioReview: 4,
    });
    expect(withSongBadges(reports, null)).toEqual(reports);
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
    for (const action of ['dismiss', 'remove', 'setRating'] as const)
      expect(
        await act(
          action,
          { imageId: String(SONG), reportIds: '11', violationType: 'hate', nsfwLevel: '2' },
          {}
        )
      ).toMatchObject({ status: 403 });
  });

  const statuses = async () =>
    Object.fromEntries(
      (
        await db.query<{ id: number; status: string }>(
          `SELECT id, status FROM "Report" ORDER BY id`
        )
      ).rows.map((r) => [r.id, r.status])
    );

  it("dismisses through Image reports' writer, closing only the song's Pending reports", async () => {
    const before = await statuses();
    // 19 is on the song but already ruled; 13 and 16 are on other images.
    const result = await act('dismiss', { imageId: String(SONG), reportIds: '11,12,13,16,19' });
    expect(result).toMatchObject({ success: true });
    expect(await statuses()).toEqual({ ...before, 11: 'Unactioned', 12: 'Unactioned' });
  });

  it("removes through Image reports' writer, closing the song's Pending reports as Actioned", async () => {
    const before = await statuses();
    const result = await act('remove', {
      imageId: String(SONG),
      reportIds: '11,12,19',
      violationType: 'hate',
    });
    expect(result).toMatchObject({ success: true });
    expect(await statuses()).toEqual({ ...before, 11: 'Actioned', 12: 'Actioned' });
    const { rows } = await db.query<{ ingestion: string }>(
      `SELECT ingestion FROM "Image" WHERE id = ${SONG}`
    );
    expect(rows[0].ingestion).toBe('Blocked');
  });

  it('refuses a rating of a song its own scans have not reviewed, naming the song', async () => {
    await db.query(`UPDATE "Image" SET ingestion = 'Pending' WHERE id = ${SONG}`);
    expect(await act('setRating', { imageId: String(SONG), nsfwLevel: '2' })).toMatchObject({
      status: 409,
      data: { key: SONG, error: expect.stringMatching(/not been reviewed yet/) },
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

  it('sends a cover the player would show without its file to a moderator it is withheld from', async () => {
    // A scanned own cover whose key a still-scanning image shares: the access rule withholds it.
    await db.exec(`
      INSERT INTO "Image" (id, url, type, ingestion, "userId", "nsfwLevel") VALUES
        (630, 'shared-scanned-cover', 'image', 'Scanned', ${OWNER}, 1),
        (631, 'shared-scanned-cover', 'image', 'Pending', 1, 0);
      UPDATE "Track" SET "coverImageId" = 630 WHERE "imageId" = ${QUIET_SONG};
      UPDATE "Image" SET "needsReview" = NULL WHERE id = 621;
    `);
    expect((await get(WITH_GRANT, QUIET_SONG)).body.cover).toEqual({
      id: 630,
      url: 'shared-scanned-cover',
      nsfwLevel: 1,
      shown: true,
    });
    expect((await get(WITHOUT_GRANT, QUIET_SONG)).body.cover).toMatchObject({ id: 630, url: null });
  });
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
    request: new Request('https://mod.example/audio-review', {
      method: 'POST',
      body: formOf(fields),
    }),
    locals: { user, grants },
    getClientAddress: () => '127.0.0.1',
    url: new URL('https://mod.example/audio-review'),
  } as never);
const imageRow = async (id: number) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM "Image" WHERE id = ${id}`)).rows[0];

describe('Remove cover on a reported song (S2)', () => {
  it('is offered only for the song’s own cover that is not removed or withheld', async () => {
    const rows = await getReportedSongRows(
      [SONG, QUIET_SONG, RULE_SONG, WITHHELD],
      WITH_GRANT as never
    );
    expect(rows.map((r) => [r.id, r.removableCoverId])).toEqual([
      [SONG, 620],
      [QUIET_SONG, 621],
      // Its cover is already removed.
      [RULE_SONG, null],
      [WITHHELD, null],
    ]);
    // A cover a still-scanning image shares a key with is withheld without the grant.
    await db.exec(`
      INSERT INTO "Image" (id, url, type, ingestion, "userId", "nsfwLevel") VALUES
        (630, 'shared-scanned-cover', 'image', 'Scanned', ${OWNER}, 1),
        (631, 'shared-scanned-cover', 'image', 'Pending', 1, 0);
      UPDATE "Track" SET "coverImageId" = 630 WHERE "imageId" = ${QUIET_SONG};
    `);
    await db.exec(`UPDATE "Image" SET "needsReview" = NULL WHERE id = 621`);
    const [quiet] = await getReportedSongRows([QUIET_SONG], WITHOUT_GRANT as never);
    expect(quiet.removableCoverId).toBeNull();
    // The list thumbnail follows the same rule as the detail's cover card.
    expect(quiet.coverUrl).toBeNull();
    const [open] = await getReportedSongRows([QUIET_SONG], WITH_GRANT as never);
    expect(open).toMatchObject({ coverUrl: 'shared-scanned-cover', removableCoverId: 630 });
    // Someone else's image named as the cover is not the song's own.
    await db.exec(`UPDATE "Image" SET "userId" = 1 WHERE id = 620`);
    const [song] = await getReportedSongRows([SONG], WITH_GRANT as never);
    expect(song.removableCoverId).toBeNull();
  });

  it('removes only the cover: the song row is unchanged, its reports stay open, and its card shows the placeholder', async () => {
    const before = await imageRow(SONG);
    const result = await pageAction('removeCover', {
      imageId: String(SONG),
      coverId: '620',
      violationType: 'gore',
    });
    expect(result).toMatchObject({ success: true, coverId: 620, key: SONG });
    expect(await imageRow(SONG)).toEqual(before);
    expect(await imageRow(620)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    const { rows } = await db.query<{ id: number; status: string }>(
      `SELECT id, status FROM "Report" WHERE id IN (11, 12) ORDER BY id`
    );
    expect(rows.map((r) => r.status)).toEqual(['Pending', 'Pending']);
    const [row] = await getReportedSongRows([SONG], WITH_GRANT as never);
    expect(row).toMatchObject({ coverUrl: null, removableCoverId: null, removed: false });
    const res = await details.GET({
      params: { imageId: String(SONG) },
      locals: { user: WITH_GRANT },
    } as never);
    expect((await res.json()).cover).toMatchObject({ id: 620, url: null, shown: false });
  });

  it('refuses a song with no cover to remove, and one with no violation type', async () => {
    expect(
      await pageAction('removeCover', {
        imageId: String(RULE_SONG),
        coverId: '620',
        violationType: 'gore',
      })
    ).toMatchObject({ status: 409, data: { key: RULE_SONG } });
    expect(
      await pageAction('removeCover', { imageId: String(SONG), coverId: '620' })
    ).toMatchObject({
      status: 400,
      data: { error: 'Pick a violation type.' },
    });
    expect((await imageRow(620)).ingestion).toBe('Scanned');
  });

  it('refuses a cover other than the one the moderator saw: the song has a new cover since', async () => {
    expect(
      await pageAction('removeCover', {
        imageId: String(SONG),
        coverId: '699',
        violationType: 'gore',
      })
    ).toMatchObject({ status: 409, data: { key: SONG } });
    expect((await imageRow(620)).ingestion).toBe('Scanned');
  });

  it('says so when the cover cannot be checked, rather than that there is none', async () => {
    await db.exec(`ALTER TABLE "Track" RENAME TO "TrackGone"`);
    expect(
      await pageAction('removeCover', {
        imageId: String(SONG),
        coverId: '620',
        violationType: 'gore',
      })
    ).toMatchObject({
      status: 503,
      data: { error: "Couldn't check the cover. Try again.", key: SONG },
    });
  });

  it('refuses a cover withheld from the moderator as withheld, not as missing', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, type, ingestion, "userId") VALUES (632, 'cover-key', 'image', 'Pending', 1);
    `);
    expect(
      await pageAction(
        'removeCover',
        { imageId: String(SONG), coverId: '620', violationType: 'gore' },
        GRANTS,
        WITHOUT_GRANT
      )
    ).toMatchObject({
      status: 403,
      data: { error: expect.stringContaining(WITHHELD_REFUSED), key: SONG },
    });
    expect((await imageRow(620)).ingestion).toBe('Scanned');
  });

  it('refuses a withheld song without the grant to see it', async () => {
    await db.exec(`UPDATE "Track" SET "coverImageId" = 620 WHERE "imageId" = ${WITHHELD};
      UPDATE "Track" SET "coverImageId" = NULL WHERE "imageId" = ${SONG}`);
    expect(
      await pageAction(
        'removeCover',
        { imageId: String(WITHHELD), coverId: '620', violationType: 'gore' },
        GRANTS,
        WITHOUT_GRANT
      )
    ).toMatchObject({ status: 403 });
    expect((await imageRow(620)).ingestion).toBe('Scanned');
  });
});

describe('the Appeals tab (S2)', () => {
  const APPEALED_SONG = 640;
  const ITS_COVER = 641;
  const LIVE_SONG = 642;
  const APPEALED_COVER = 643;
  const APPEALED_PICTURE = 644;
  const DECIDED_SONG = 645;
  const MOD = 3;

  beforeEach(async () => {
    await db.exec(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE "Appeal" ADD COLUMN IF NOT EXISTS "buzzTransactionId" TEXT,
        ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;
      CREATE TABLE "ComicPanel" ("projectId" INTEGER, "imageId" INTEGER);
      INSERT INTO "User" (id, username) VALUES (${MOD}, 'mod_sam');
      INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", "needsReview", "nsfwLevel", "userId", metadata) VALUES
        (${APPEALED_SONG}, 'appealed-song', 'audio', 'Blocked', 'moderated', 'appeal', 32, ${OWNER}, '{"title": "Cinder"}'),
        (${ITS_COVER}, 'its-cover', 'image', 'Scanned', NULL, NULL, 1, ${OWNER}, NULL),
        (${LIVE_SONG}, 'live-song', 'audio', 'Scanned', NULL, NULL, 2, ${OWNER}, '{"title": "Marigold"}'),
        (${APPEALED_COVER}, 'appealed-cover', 'image', 'Blocked', 'moderated', 'appeal', 32, ${OWNER}, NULL),
        (${APPEALED_PICTURE}, 'appealed-picture', 'image', 'Blocked', 'moderated', 'appeal', 32, ${OWNER}, NULL),
        (${DECIDED_SONG}, 'decided-song', 'audio', 'Blocked', 'moderated', 'appeal', 32, ${OWNER}, '{"title": "Old"}');
      INSERT INTO "Track" ("imageId", "coverImageId") VALUES
        (${APPEALED_SONG}, ${ITS_COVER}), (${LIVE_SONG}, ${APPEALED_COVER}), (${DECIDED_SONG}, NULL);
      UPDATE "Image" SET "needsReview" = 'appeal' WHERE id = ${WITHHELD};
      INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "appealMessage", "createdAt") VALUES
        (${OWNER}, 'Image', ${APPEALED_SONG}, 'Rejected', 'first try', '2026-11-01'),
        (${OWNER}, 'Image', ${APPEALED_SONG}, 'Pending', 'It is a story', '2026-11-10'),
        (${OWNER}, 'Image', ${APPEALED_COVER}, 'Pending', 'It is abstract', '2026-11-11'),
        (${OWNER}, 'Image', ${APPEALED_PICTURE}, 'Pending', 'A picture', '2026-11-12'),
        (${OWNER}, 'Image', ${DECIDED_SONG}, 'Rejected', 'Decided', '2026-11-13'),
        (${OWNER}, 'Image', ${WITHHELD}, 'Pending', 'Held words', '2026-11-14');
      INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity, "createdAt") VALUES
        (${MOD}, 'image', ${APPEALED_SONG}, 'review', '2026-11-09');
    `);
  });

  const appeals = (user = WITH_GRANT, opts: Partial<Parameters<typeof getSongAppeals>[0]> = {}) =>
    getSongAppeals({ sort: 'oldest', filter: 'all', q: '', page: 1, user: user as never, ...opts });

  it('lists only Pending appeals of a song or a song’s own cover', async () => {
    const { items, facets } = await appeals();
    expect(items.map((r) => [r.id, r.kind])).toEqual([
      [APPEALED_SONG, 'song'],
      [APPEALED_COVER, 'cover'],
      [WITHHELD, 'song'],
    ]);
    expect(facets).toEqual({ all: 3, song: 2, cover: 1 });
    expect(items[0]).toMatchObject({
      withheld: false,
      song: { id: APPEALED_SONG, title: 'Cinder' },
      url: 'appealed-song',
      coverUrl: 'its-cover',
      owner: { id: OWNER, username: 'owner' },
      message: 'It is a story',
      removal: { by: 'mod_sam', reason: 'Moderated' },
      appeals: 2,
    });
    expect(items[1]).toMatchObject({ song: { id: LIVE_SONG, title: 'Marigold' }, appeals: 1 });
    expect((await appeals(WITH_GRANT, { filter: 'cover' })).items.map((r) => r.id)).toEqual([
      APPEALED_COVER,
    ]);
  });

  it('leaves out a list thumbnail withheld from the moderator', async () => {
    await db.exec(`
      UPDATE "Image" SET url = 'shared-thumb' WHERE id = ${ITS_COVER};
      INSERT INTO "Image" (id, url, type, ingestion, "userId") VALUES (646, 'shared-thumb', 'image', 'Pending', 1);
    `);
    const thumb = async (user: typeof WITH_GRANT) =>
      (await appeals(user)).items.find((r) => r.id === APPEALED_SONG)?.coverUrl;
    expect(await thumb(WITH_GRANT)).toBe('shared-thumb');
    expect(await thumb(WITHOUT_GRANT)).toBeNull();
  });

  it('sends a withheld appeal with nothing that shows or names it, found only by its id', async () => {
    const hidden = await appeals(WITHOUT_GRANT);
    expect(hidden.facets).toEqual({ all: 3, song: 2, cover: 1 });
    const withheld = hidden.items.find((r) => r.id === WITHHELD);
    expect(withheld).toEqual(
      expect.objectContaining({
        kind: 'song',
        withheld: true,
        song: null,
        url: null,
        coverUrl: null,
        owner: null,
        message: null,
        removal: null,
        nsfwLevel: null,
      })
    );
    expect((await appeals(WITHOUT_GRANT, { q: 'Held' })).items).toEqual([]);
    expect((await appeals(WITHOUT_GRANT, { q: String(WITHHELD) })).items.map((r) => r.id)).toEqual([
      WITHHELD,
    ]);
  });

  it('leaves songs and their covers out of the image Appeals queue, and every other image in it', async () => {
    const all = (
      await getAppealImageQueue({ browsingLevel: 0x7fffffff, limit: 50, csamReview: true })
    ).items.map((i) => i.id);
    expect(all).toEqual(
      expect.arrayContaining([APPEALED_SONG, APPEALED_COVER, APPEALED_PICTURE, DECIDED_SONG])
    );
    // The image Appeals queue page (`/images/appeals`), at its default levels.
    const queue = await loadImageQueue(
      'appeals',
      new URL('https://mod.example/images/appeals'),
      WITH_GRANT as never
    );
    // A song left flagged for appeal with no Pending appeal stays in the image queue, whose
    // resolve clears the flag; Audio review lists only Pending appeals.
    expect(queue.items.map((i) => i.id)).toEqual([APPEALED_PICTURE, DECIDED_SONG]);
  });

  const appealOf = async (imageId: number) =>
    (
      await db.query<{
        status: string;
        resolvedReason: string | null;
        resolvedMessage: string | null;
      }>(
        `SELECT status, "resolvedReason", "resolvedMessage" FROM "Appeal"
         WHERE "entityId" = ${imageId} ORDER BY id DESC LIMIT 1`
      )
    ).rows[0];

  it('approving a cover appeal restores the cover and leaves its song untouched', async () => {
    const song = await imageRow(LIVE_SONG);
    const result = await pageAction('approveAppeal', {
      imageId: String(APPEALED_COVER),
      resolvedReason: 'misclassified',
    });
    expect(result).toMatchObject({ success: true, key: APPEALED_COVER });
    expect(await imageRow(APPEALED_COVER)).toMatchObject({ needsReview: null, blockedFor: null });
    expect((await imageRow(APPEALED_COVER)).ingestion).not.toBe('Blocked');
    expect(await imageRow(LIVE_SONG)).toEqual(song);
    expect((await appealOf(APPEALED_COVER)).status).toBe('Approved');
  });

  it('approving a song appeal restores the song and leaves its cover untouched', async () => {
    const cover = await imageRow(ITS_COVER);
    expect(
      await pageAction('approveAppeal', {
        imageId: String(APPEALED_SONG),
        resolvedReason: 'misclassified',
      })
    ).toMatchObject({ success: true });
    expect(await imageRow(APPEALED_SONG)).toMatchObject({ needsReview: null, blockedFor: null });
    expect(await imageRow(ITS_COVER)).toEqual(cover);
  });

  it('rejecting keeps it removed and records the reason and the message to the owner', async () => {
    expect(
      await pageAction('rejectAppeal', {
        imageId: String(APPEALED_SONG),
        resolvedReason: 'violation-confirmed',
        resolvedMessage: 'The lyric names a real person.',
      })
    ).toMatchObject({ success: true });
    expect(await imageRow(APPEALED_SONG)).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      needsReview: null,
    });
    expect(await appealOf(APPEALED_SONG)).toEqual({
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      resolvedMessage: 'The lyric names a real person.',
    });
  });

  it('refuses an appeal that is not on a song or its cover, or already decided', async () => {
    for (const imageId of [APPEALED_PICTURE, DECIDED_SONG])
      expect(
        await pageAction('approveAppeal', {
          imageId: String(imageId),
          resolvedReason: 'misclassified',
        })
      ).toMatchObject({ status: 409 });
    expect((await appealOf(APPEALED_PICTURE)).status).toBe('Pending');
    expect((await imageRow(APPEALED_PICTURE)).ingestion).toBe('Blocked');
  });

  it('refuses a withheld appeal without the grant to see it', async () => {
    expect(
      await pageAction(
        'approveAppeal',
        { imageId: String(WITHHELD), resolvedReason: 'misclassified' },
        GRANTS,
        WITHOUT_GRANT
      )
    ).toMatchObject({ status: 403 });
    expect((await appealOf(WITHHELD)).status).toBe('Pending');
  });
});

describe('every Audio review action', () => {
  it('refuses without the image moderation grant and changes nothing', async () => {
    const before = (await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows;
    for (const action of Object.keys(page.actions) as (keyof typeof page.actions)[])
      expect(
        await pageAction(
          action,
          {
            imageId: String(SONG),
            reportIds: '11',
            violationType: 'hate',
            nsfwLevel: '2',
            resolvedReason: 'misclassified',
          },
          {}
        ),
        String(action)
      ).toMatchObject({ status: 403 });
    expect((await db.query(`SELECT * FROM "Image" ORDER BY id`)).rows).toEqual(before);
  });
});
