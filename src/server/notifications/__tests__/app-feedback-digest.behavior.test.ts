import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appFeedbackDigestQuery } from '~/server/notifications/app-feedback.notifications';

/**
 * Runs the real `app-feedback-new` digest query against an in-process Postgres whose `Feedback`
 * table is built by the REAL migrations — the same three files a human applies by hand — so a
 * column the query names and the DDL does not fails here instead of in the job.
 *
 * 🔴 THE CLOCK IS PINNED. The query's window is about time (a bucket is sent once, in the run
 * whose window holds its due time), so a test reading the wall clock would pass or fail by the
 * hour it ran at. `public.now()` shadows `pg_catalog.now()` via `search_path`, and every timestamp
 * is written and read as a STRING: PGlite shifts a JS `Date` sent against a
 * `timestamp WITHOUT time zone` by the local offset (see the moderator app's
 * `feedback-pglite.harness.ts`), so no `Date` crosses the boundary here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

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

// Users — pairwise distinct, and none equal to a count the assertions name.
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

/** 2026-10-20 00:30 UTC. Yesterday's bucket (10-19) fell due at 00:05. */
const NOW = '2026-10-20 00:30:00+00';
/** The previous run: before 10-19's due time (00:05), after 10-18's. */
const LAST_SENT = '2026-10-20T00:00:00.000Z';

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
  await db.query(
    `INSERT INTO "Feedback" (id, area, "userId", message, "appListingId", "createdAt",
       "hiddenFromOwnerAt", "ownerStatus", "ownerFlaggedAt")
     VALUES ($1, 'app-block', $2, 'SECRET-MESSAGE-TEXT', $3, $4::timestamp, $5::timestamp, $6, $7::timestamp)`,
    [
      nextId++,
      userId,
      appListingId,
      createdAt,
      extra.hiddenFromOwnerAt ?? null,
      extra.ownerStatus ?? null,
      extra.ownerFlaggedAt ?? null,
    ]
  );
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
  nextId = 1;
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
  it('one row per listing per bucket, to the canonical owner, with the count of NEW visible reports', async () => {
    // Yesterday (2026-10-19): due at 2026-10-20 00:05, inside (LAST_SENT, NOW].
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    await feedback(R2, L_ONSITE, '2026-10-19 23:59:59');
    await feedback(R3, L_OFFSITE, '2026-10-19 10:00');

    expect(await run()).toEqual([
      {
        key: 'app-feedback-new:apl_offsite:2026-10-19T00',
        userId: OFFSITE_OWNER,
        type: 'app-feedback-new',
        details: { appListingId: L_OFFSITE, appName: 'Far Away', count: 1 },
      },
      {
        key: 'app-feedback-new:apl_onsite:2026-10-19T00',
        userId: OWNER,
        type: 'app-feedback-new',
        details: { appListingId: L_ONSITE, appName: 'Pixel Forge', count: 2 },
      },
    ]);
  });

  it('🔴 excludes hidden, banned-reporter, already-handled, flagged and blocked rows', async () => {
    await feedback(R1, L_ONSITE, '2026-10-19 01:00'); // the one that counts
    await feedback(R2, L_ONSITE, '2026-10-19 02:00', { hiddenFromOwnerAt: '2026-10-19 05:00' });
    await feedback(BANNED, L_ONSITE, '2026-10-19 03:00');
    await feedback(R3, L_ONSITE, '2026-10-19 04:00', {
      ownerStatus: 'acknowledged',
    });
    await feedback(R3, L_ONSITE, '2026-10-19 05:00', { ownerFlaggedAt: '2026-10-19 06:00' });
    await feedback(BLOCKED_BY_OWNER, L_ONSITE, '2026-10-19 06:00');
    await feedback(BLOCKS_OWNER, L_ONSITE, '2026-10-19 07:00');
    await feedback(HIDDEN_BY_OWNER, L_ONSITE, '2026-10-19 08:00');

    const rows = await run();
    expect(rows.map((r) => [r.userId, r.details.count])).toEqual([[OWNER, 1]]);
  });

  it('each exclusion alone drops its row (so none is masked by another)', async () => {
    const cases: Array<[string, () => Promise<void>]> = [
      [
        'hidden',
        () => feedback(R2, L_ONSITE, '2026-10-19 02:00', { hiddenFromOwnerAt: '2026-10-19 05:00' }),
      ],
      ['banned', () => feedback(BANNED, L_ONSITE, '2026-10-19 03:00')],
      [
        'acknowledged',
        () => feedback(R3, L_ONSITE, '2026-10-19 04:00', { ownerStatus: 'acknowledged' }),
      ],
      ['resolved', () => feedback(R3, L_ONSITE, '2026-10-19 04:00', { ownerStatus: 'resolved' })],
      [
        'flagged',
        () => feedback(R3, L_ONSITE, '2026-10-19 05:00', { ownerFlaggedAt: '2026-10-19 06:00' }),
      ],
      ['owner blocked reporter', () => feedback(BLOCKED_BY_OWNER, L_ONSITE, '2026-10-19 06:00')],
      ['reporter blocked owner', () => feedback(BLOCKS_OWNER, L_ONSITE, '2026-10-19 07:00')],
      ['owner hid reporter', () => feedback(HIDDEN_BY_OWNER, L_ONSITE, '2026-10-19 08:00')],
      ['owner is the reporter', () => feedback(OWNER, L_ONSITE, '2026-10-19 09:00')],
      ['shadow revision', () => feedback(R1, L_SHADOW, '2026-10-19 10:00')],
      ['system-owned listing', () => feedback(R1, L_SYSTEM, '2026-10-19 11:00')],
      ['owner opted out', () => feedback(R1, L_OPTED_OUT, '2026-10-19 12:00')],
    ];
    for (const [label, seed] of cases) {
      await db.exec(`TRUNCATE "Feedback"`);
      await seed();
      expect(await run(), label).toEqual([]);
    }
    // Positive control: the same harness, an ordinary row, DOES produce a digest.
    await db.exec(`TRUNCATE "Feedback"`);
    await feedback(R1, L_ONSITE, '2026-10-19 10:00');
    expect((await run()).map((r) => r.userId)).toEqual([OWNER]);
  });

  it('🔴 the owner only — never the stale denormalized owner, never an accepted editor', async () => {
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    const recipients = (await run()).map((r) => r.userId);
    expect(recipients).toEqual([OWNER]);
    expect(recipients).not.toContain(STALE);
    expect(recipients).not.toContain(EDITOR);
  });

  it('🔴 carries no message text', async () => {
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    const rows = await run();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('SECRET-MESSAGE-TEXT');
    expect(JSON.stringify(rows)).not.toContain(`u${R1}`);
    expect(Object.keys(rows[0].details).sort()).toEqual(['appListingId', 'appName', 'count']);
  });
});

describe('app-feedback-new digest — the window', () => {
  it('a bucket is sent in the run whose window holds its due time, and in no other', async () => {
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    // Due 2026-10-20 00:05. NOW is 00:30.
    expect(await run('2026-10-20T00:04:59.000Z')).toHaveLength(1); // window holds 00:05
    expect(await run('2026-10-20T00:05:00.000Z')).toHaveLength(0); // already sent by that run
    expect(await run('2026-10-20T00:20:00.000Z')).toHaveLength(0);

    // Not due yet: the same run, a minute before the due time.
    await setNow('2026-10-20 00:04:00+00');
    expect(await run()).toHaveLength(0);
    // ...and due the moment it arrives.
    await setNow('2026-10-20 00:05:00+00');
    expect(await run('2026-10-20T00:04:00.000Z')).toHaveLength(1);
  });

  it("today's reports wait for today's bucket to close", async () => {
    await feedback(R1, L_ONSITE, '2026-10-20 00:10');
    expect(await run('2026-10-19T00:00:00.000Z')).toHaveLength(0);
    await setNow('2026-10-21 00:06:00+00');
    expect((await run('2026-10-21T00:00:00.000Z')).map((r) => r.key)).toEqual([
      'app-feedback-new:apl_onsite:2026-10-20T00',
    ]);
  });

  it('a report written in the grace period after midnight lands in its own (previous) bucket', async () => {
    // Stamped 23:59:59 but not visible to the replica until 00:03. The runs at 00:01 and 00:02
    // could not see it — and did not need to, because the bucket is not due until 00:05, so the
    // first run after that (previous run 00:03) counts it.
    await feedback(R1, L_ONSITE, '2026-10-19 23:59:59');
    await setNow('2026-10-20 00:02:00+00');
    expect(await run('2026-10-20T00:01:00.000Z')).toEqual([]);
    await setNow('2026-10-20 00:05:30+00');
    expect((await run('2026-10-20T00:03:00.000Z')).map((r) => r.details.count)).toEqual([1]);
  });

  it('overlapping windows re-emit the SAME key, which the service collapses', async () => {
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    const a = await run();
    const b = await run('2026-10-20T00:04:00.000Z');
    expect(a.map((r) => r.key)).toEqual(['app-feedback-new:apl_onsite:2026-10-19T00']);
    expect(b.map((r) => r.key)).toEqual(a.map((r) => r.key));
  });

  it('a drifted cursor reaches back at most 7 days', async () => {
    await feedback(R1, L_ONSITE, '2026-10-12 23:00'); // 7d 1.5h before NOW — outside
    await feedback(R2, L_ONSITE, '2026-10-13 01:00'); // inside
    const rows = await run('1970-01-01T00:00:00.000Z');
    expect(rows.map((r) => r.key)).toEqual(['app-feedback-new:apl_onsite:2026-10-13T00']);
  });

  it('🔴 is independent of the session time zone', async () => {
    // `createdAt` holds UTC in a zone-less column. Compared against a bare NOW(), its due time
    // would be read in the session zone and land hours outside the cursor's window.
    await feedback(R1, L_ONSITE, '2026-10-19 03:00');
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      await db.exec(`SET TIME ZONE '${zone}'`);
      expect(
        (await run()).map((r) => r.key),
        zone
      ).toEqual(['app-feedback-new:apl_onsite:2026-10-19T00']);
    }
  });
});
