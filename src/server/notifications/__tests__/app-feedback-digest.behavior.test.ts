import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { appFeedbackDigestQuery } from '~/server/notifications/app-feedback.notifications';
import type * as AppAccess from '~/server/services/blocks/app-access.service';

/**
 * Runs the real `app-feedback-new` digest query against an in-process Postgres whose `Feedback`
 * table is built by the REAL migrations — the same files a human applies by hand — so a column the
 * query names and the DDL does not fails here instead of in the job. The owner inbox's own raw
 * reads (the list and the New counts) run against the SAME database, through the real service
 * functions, so "the digest never counts a row the inbox would not show" is checked by executing
 * both, not by comparing their text.
 *
 * The clock is pinned (`public.now()` shadows `pg_catalog.now()` via `search_path`) so the 7-day
 * floor does not depend on when the test runs. Every timestamp is written and read as a STRING:
 * PGlite shifts a JS `Date` sent against a `timestamp WITHOUT time zone` by the local offset (see
 * the moderator app's `feedback-pglite.harness.ts`), so no `Date` crosses the boundary here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const access = vi.hoisted(() => ({
  seatListingId: '',
  allIds: [] as string[],
}));

vi.mock('~/server/services/blocks/app-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccess>()),
  resolveListingAccess: async () => ({ role: 'owner', seatListingId: access.seatListingId }),
  resolveAccessibleListingIds: async () => ({ allIds: access.allIds }),
}));

const { countNewAppFeedbackForMyListings, listAppFeedbackForListing } = await import(
  '~/server/services/blocks/app-feedback.service'
);

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/** The app-block migration is two separately-run parts; `CREATE INDEX CONCURRENTLY` refuses a block. */
function appListingMigrationParts() {
  const sql = migration('20261011120000_feedback_app_listing');
  const marker = '\n-- Part 2 — ';
  const at = sql.indexOf(marker);
  if (at === -1 || sql.indexOf(marker, at + 1) !== -1) throw new Error('Part 2 marker not unique');
  return [sql.slice(0, at), sql.slice(at)];
}

type Row = {
  key: string;
  userId: number;
  type: string;
  details: { appListingId: string; appName: string; count: number };
};

// Users — pairwise distinct, and none equal to a count or feedback id the assertions name.
const OWNER = 101; // canonical owner of L_ONSITE, via OauthClient
const STALE = 102; // L_ONSITE's stale denormalized user_id — must never be notified
const OFFSITE_OWNER = 103;
const OPTED_OUT_OWNER = 104;
const EDITOR = 105;
const R1 = 201;
const R2 = 202;
const R3 = 203;
const BANNED = 204;
const BLOCKED_BY_OWNER = 205;
const BLOCKS_OWNER = 206;
const HIDDEN_BY_OWNER = 207;

const L_ONSITE = 'apl_onsite';
const L_OFFSITE = 'apl_offsite';
const L_SHADOW = 'apl_shadow';
const L_OPTED_OUT = 'apl_optout';
const L_SYSTEM = 'apl_system';

const NOW = '2026-10-20 00:30:00+00';
/** The previous run's cursor. Rows after it are this run's batch. */
const LAST_SENT = '2026-10-20T00:00:00.000Z';
/** A time inside this run's batch. */
const IN_BATCH = '2026-10-20 00:10';

let db: PGlite;

const run = async (lastSent = LAST_SENT) =>
  (await db.query<Row>(appFeedbackDigestQuery({ lastSent }))).rows.sort((a, b) =>
    a.key.localeCompare(b.key)
  );

const setNow = (ts: string) => db.query(`UPDATE test_clock SET t = $1::timestamptz`, [ts]);

let nextId = 1;
async function feedback(
  userId: number,
  appListingId: string,
  createdAt: string,
  extra: Partial<{
    hiddenFromOwnerAt: string;
    ownerStatus: string;
    ownerFlaggedAt: string;
  }> = {}
) {
  const id = nextId++;
  await db.query(
    `INSERT INTO "Feedback" (id, area, "userId", message, "appListingId", "createdAt",
       "hiddenFromOwnerAt", "ownerStatus", "ownerFlaggedAt")
     VALUES ($1, 'app-block', $2, 'SECRET-MESSAGE-TEXT', $3, $4::timestamp, $5::timestamp, $6, $7::timestamp)`,
    [
      id,
      userId,
      appListingId,
      createdAt,
      extra.hiddenFromOwnerAt ?? null,
      extra.ownerStatus ?? null,
      extra.ownerFlaggedAt ?? null,
    ]
  );
  return id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE test_clock (t timestamptz NOT NULL);
    INSERT INTO test_clock VALUES ('${NOW}');
    CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT t FROM test_clock';
    CREATE TABLE "User" (id INT PRIMARY KEY, username TEXT, "bannedAt" TIMESTAMP(3));
    CREATE TABLE "OauthClient" (id TEXT PRIMARY KEY, "userId" INT NOT NULL);
    CREATE TABLE "app_blocks" (id TEXT PRIMARY KEY, app_id TEXT);
    CREATE TABLE "app_listings" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id INT NOT NULL,
      app_block_id TEXT,
      revision_of_id TEXT
    );
    CREATE TABLE "app_collaborators" (app_listing_id TEXT, user_id INT, status TEXT);
    CREATE TABLE "UserEngagement" ("userId" INT NOT NULL, "targetUserId" INT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE "UserNotificationSettings" ("userId" INT NOT NULL, type TEXT NOT NULL);
    CREATE TYPE "DomainColor" AS ENUM ('blue', 'green', 'red', 'all');
  `);
  await db.exec(migration('20260521120000_add_bug_table'));
  await db.exec(migration('20260813180000_feedback'));
  await db.exec(migration('20260911120000_feedback_triage'));
  for (const part of appListingMigrationParts()) await db.exec(part);
  // After the migrations, so their own DDL resolves names as written; from here on an unqualified
  // `now()` is the pinned clock.
  await db.exec(`SET search_path = public, pg_catalog;`);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    SET TIME ZONE 'UTC';
    TRUNCATE "Feedback", "User", "OauthClient", "app_blocks", "app_listings", "app_collaborators",
      "UserEngagement", "UserNotificationSettings" CASCADE;
    UPDATE test_clock SET t = '${NOW}';
  `);
  // Start ids well away from every count the assertions name, so a key built from the count (or
  // from the row count) instead of the highest id cannot pass.
  nextId = 11;
  for (const id of [
    OWNER,
    STALE,
    OFFSITE_OWNER,
    OPTED_OUT_OWNER,
    EDITOR,
    R1,
    R2,
    R3,
    BLOCKED_BY_OWNER,
    BLOCKS_OWNER,
    HIDDEN_BY_OWNER,
  ])
    await db.query(`INSERT INTO "User" (id, username) VALUES ($1, $2)`, [id, `u${id}`]);
  await db.query(
    `INSERT INTO "User" (id, username, "bannedAt") VALUES ($1, 'banned', '2026-10-19 12:00')`,
    [BANNED]
  );
  await db.exec(`
    INSERT INTO "OauthClient" VALUES ('oc_onsite', ${OWNER});
    INSERT INTO "app_blocks" VALUES ('blk_onsite', 'oc_onsite');
    INSERT INTO "app_listings" VALUES
      ('${L_ONSITE}', 'Pixel Forge', 'onsite', ${STALE}, 'blk_onsite', NULL),
      ('${L_OFFSITE}', 'Far Away', 'offsite', ${OFFSITE_OWNER}, NULL, NULL),
      ('${L_SHADOW}', 'Pixel Forge (draft)', 'onsite', ${STALE}, NULL, '${L_ONSITE}'),
      ('${L_OPTED_OUT}', 'Quiet App', 'offsite', ${OPTED_OUT_OWNER}, NULL, NULL),
      ('${L_SYSTEM}', 'System App', 'offsite', -1, NULL, NULL);
    INSERT INTO "app_collaborators" VALUES ('${L_ONSITE}', ${EDITOR}, 'accepted');
    INSERT INTO "UserNotificationSettings" VALUES (${OPTED_OUT_OWNER}, 'app-feedback-new');
    -- A settings row for ANOTHER type must not silence the digest.
    INSERT INTO "UserNotificationSettings" VALUES (${OWNER}, 'new-app-listing-comment');
    INSERT INTO "UserEngagement" VALUES (${OWNER}, ${BLOCKED_BY_OWNER}, 'Block');
    INSERT INTO "UserEngagement" VALUES (${BLOCKS_OWNER}, ${OWNER}, 'Block');
    INSERT INTO "UserEngagement" VALUES (${OWNER}, ${HIDDEN_BY_OWNER}, 'Hide');
  `);
});

describe('app-feedback-new digest — who gets what, executed', () => {
  it("one row per listing per run, to the canonical owner, keyed by the batch's highest id", async () => {
    await feedback(R3, L_ONSITE, '2026-10-19 23:00'); // id 11: before the cursor, a previous run's
    await feedback(R1, L_ONSITE, '2026-10-20 00:05'); // 12
    await feedback(R2, L_ONSITE, '2026-10-20 00:10'); // 13
    await feedback(R3, L_OFFSITE, '2026-10-20 00:20'); // 14

    expect(await run()).toEqual([
      {
        key: 'app-feedback-new:apl_offsite:14',
        userId: OFFSITE_OWNER,
        type: 'app-feedback-new',
        details: { appListingId: L_OFFSITE, appName: 'Far Away', count: 1 },
      },
      {
        key: 'app-feedback-new:apl_onsite:13',
        userId: OWNER,
        type: 'app-feedback-new',
        details: { appListingId: L_ONSITE, appName: 'Pixel Forge', count: 2 },
      },
    ]);
  });

  it('🔴 excludes hidden, banned-reporter, already-handled and blocked rows', async () => {
    await feedback(R1, L_ONSITE, '2026-10-20 00:01'); // the one that counts
    await feedback(R2, L_ONSITE, '2026-10-20 00:02', { hiddenFromOwnerAt: '2026-10-20 00:05' });
    await feedback(BANNED, L_ONSITE, '2026-10-20 00:03');
    await feedback(R3, L_ONSITE, '2026-10-20 00:04', { ownerStatus: 'acknowledged' });
    await feedback(BLOCKED_BY_OWNER, L_ONSITE, '2026-10-20 00:06');
    await feedback(BLOCKS_OWNER, L_ONSITE, '2026-10-20 00:07');
    await feedback(HIDDEN_BY_OWNER, L_ONSITE, '2026-10-20 00:08');

    const rows = await run();
    expect(rows.map((r) => [r.userId, r.details.count])).toEqual([[OWNER, 1]]);
  });

  it('each exclusion alone drops its row (so none is masked by another)', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['hidden', () => feedback(R2, L_ONSITE, IN_BATCH, { hiddenFromOwnerAt: '2026-10-20 00:15' })],
      ['banned', () => feedback(BANNED, L_ONSITE, IN_BATCH)],
      ['acknowledged', () => feedback(R3, L_ONSITE, IN_BATCH, { ownerStatus: 'acknowledged' })],
      ['resolved', () => feedback(R3, L_ONSITE, IN_BATCH, { ownerStatus: 'resolved' })],
      ['owner blocked reporter', () => feedback(BLOCKED_BY_OWNER, L_ONSITE, IN_BATCH)],
      ['reporter blocked owner', () => feedback(BLOCKS_OWNER, L_ONSITE, IN_BATCH)],
      ['owner hid reporter', () => feedback(HIDDEN_BY_OWNER, L_ONSITE, IN_BATCH)],
      ['owner is the reporter', () => feedback(OWNER, L_ONSITE, IN_BATCH)],
      ['shadow revision', () => feedback(R1, L_SHADOW, IN_BATCH)],
      ['system-owned listing', () => feedback(R1, L_SYSTEM, IN_BATCH)],
      ['owner opted out', () => feedback(R1, L_OPTED_OUT, IN_BATCH)],
      ['before the cursor', () => feedback(R1, L_ONSITE, '2026-10-19 23:59:59')],
    ];
    for (const [label, seed] of cases) {
      await db.exec(`TRUNCATE "Feedback"`);
      await seed();
      expect(await run(), label).toEqual([]);
    }
    // Positive control: the same harness, an ordinary row, DOES produce a digest.
    await db.exec(`TRUNCATE "Feedback"`);
    await feedback(R1, L_ONSITE, IN_BATCH);
    expect((await run()).map((r) => r.userId)).toEqual([OWNER]);
  });

  it('a flagged report with no status still counts — the same "new" as the inbox', async () => {
    // The inbox's New filter is `ownerStatus IS NULL` alone, so a digest that also dropped flagged
    // rows would announce fewer than the New tab it links to shows.
    await feedback(R3, L_ONSITE, IN_BATCH, { ownerFlaggedAt: '2026-10-20 00:15' });
    expect((await run()).map((r) => r.details.count)).toEqual([1]);
  });

  it('🔴 the owner only — never the stale denormalized owner, never an accepted editor', async () => {
    await feedback(R1, L_ONSITE, IN_BATCH);
    const recipients = (await run()).map((r) => r.userId);
    expect(recipients).toEqual([OWNER]);
    expect(recipients).not.toContain(STALE);
    expect(recipients).not.toContain(EDITOR);
  });

  it('🔴 carries no message text', async () => {
    await feedback(R1, L_ONSITE, IN_BATCH);
    const rows = await run();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('SECRET-MESSAGE-TEXT');
    expect(JSON.stringify(rows)).not.toContain(`u${R1}`);
    expect(Object.keys(rows[0].details).sort()).toEqual(['appListingId', 'appName', 'count']);
  });
});

describe('app-feedback-new digest — the cursor', () => {
  it('counts only rows after the cursor; a row exactly at it belongs to the previous run', async () => {
    await feedback(R1, L_ONSITE, '2026-10-20 00:00:00'); // 11: at the cursor
    await feedback(R2, L_ONSITE, '2026-10-20 00:00:01'); // 12: just after it
    expect((await run()).map((r) => [r.key, r.details.count])).toEqual([
      ['app-feedback-new:apl_onsite:12', 1],
    ]);
  });

  it('consecutive runs count disjoint batches under distinct keys; a repeated run repeats its key', async () => {
    await feedback(R1, L_ONSITE, '2026-10-20 00:01'); // 11
    await feedback(R2, L_ONSITE, '2026-10-20 00:02'); // 12
    const first = await run('2026-10-20T00:00:00.000Z');
    await feedback(R3, L_ONSITE, '2026-10-20 00:04'); // 13, after the first run's cursor
    const second = await run('2026-10-20T00:03:00.000Z');
    expect(first.map((r) => [r.key, r.details.count])).toEqual([
      ['app-feedback-new:apl_onsite:12', 2],
    ]);
    expect(second.map((r) => [r.key, r.details.count])).toEqual([
      ['app-feedback-new:apl_onsite:13', 1],
    ]);
  });

  it('a run repeated before its cursor advanced, with nothing new, re-emits the same key', async () => {
    // The notifications service delivers a key once, so a retry of the same batch is not a second
    // notification.
    await feedback(R1, L_ONSITE, '2026-10-20 00:01');
    await feedback(R2, L_ONSITE, '2026-10-20 00:02');
    const a = await run();
    expect(a.map((r) => r.key)).toEqual(['app-feedback-new:apl_onsite:12']);
    expect((await run()).map((r) => r.key)).toEqual(a.map((r) => r.key));
  });

  it('a drifted cursor reaches back at most 7 days', async () => {
    await feedback(R1, L_ONSITE, '2026-10-12 23:00'); // 7d 1.5h before NOW — outside
    await feedback(R2, L_ONSITE, '2026-10-13 01:00'); // 12: inside
    const rows = await run('1970-01-01T00:00:00.000Z');
    expect(rows.map((r) => [r.key, r.details.count])).toEqual([
      ['app-feedback-new:apl_onsite:12', 1],
    ]);
    // The floor moves with the clock: a day later the same row has aged out too.
    await setNow('2026-10-21 02:00:00+00');
    expect(await run('1970-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('🔴 one visibility rule — the digest never counts a row the owner inbox would not show', () => {
  // The inbox's raw reads go through the db mock's `$queryRaw`; here it runs them on this PGlite.
  beforeEach(() => {
    access.seatListingId = L_ONSITE;
    access.allIds = [L_ONSITE];
    dbMock.dbRead.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      const result = await db.query(query.text, query.values as unknown[]);
      return result.rows;
    });
  });

  const inboxNewIds = async () =>
    (
      await listAppFeedbackForListing({
        userId: OWNER,
        input: { appListingId: L_ONSITE, limit: 50, ownerStatus: 'new' },
      })
    ).items.map((i) => i.id);
  const inboxNewCount = async () => (await countNewAppFeedbackForMyListings(OWNER))[L_ONSITE] ?? 0;
  const digestCount = async () =>
    (await run()).find((r) => r.details.appListingId === L_ONSITE)?.details.count ?? 0;

  it('positive control: a visible new row is in the inbox list, the inbox count and the digest', async () => {
    const id = await feedback(R1, L_ONSITE, IN_BATCH);
    expect(await inboxNewIds()).toEqual([id]);
    expect(await inboxNewCount()).toBe(1);
    expect(await digestCount()).toBe(1);
  });

  it('hidden, banned-reporter and already-handled rows are dropped by ALL THREE reads', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'hidden from the owner',
        () => feedback(R2, L_ONSITE, IN_BATCH, { hiddenFromOwnerAt: '2026-10-20 00:15' }),
      ],
      ['banned reporter', () => feedback(BANNED, L_ONSITE, IN_BATCH)],
      ['not new', () => feedback(R3, L_ONSITE, IN_BATCH, { ownerStatus: 'wont_fix' })],
      // No "another area" case: `Feedback_app_columns_check` refuses a listing id on any other
      // area, so no row can reach the area clause through a listing join. It is pinned as text.
    ];
    for (const [label, seed] of cases) {
      await db.exec(`TRUNCATE "Feedback"`);
      await seed();
      expect(await inboxNewIds(), `${label}: inbox list`).toEqual([]);
      expect(await inboxNewCount(), `${label}: inbox count`).toBe(0);
      expect(await digestCount(), `${label}: digest`).toBe(0);
    }
  });

  it("the digest-only rules: blocked pairs and the owner's own row are in the inbox, not the digest", async () => {
    // The inbox shows every visible report, including one from a user the owner blocked (the
    // owner may want to read and act on it); the digest does not push a notification about it.
    for (const reporter of [BLOCKED_BY_OWNER, BLOCKS_OWNER, HIDDEN_BY_OWNER, OWNER]) {
      await db.exec(`TRUNCATE "Feedback"`);
      const id = await feedback(reporter, L_ONSITE, IN_BATCH);
      expect(await inboxNewIds(), String(reporter)).toEqual([id]);
      expect(await digestCount(), String(reporter)).toBe(0);
    }
  });
});
