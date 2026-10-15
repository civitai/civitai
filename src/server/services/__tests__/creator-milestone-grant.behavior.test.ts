import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(async () => undefined),
  refreshCosmetics: vi.fn<(ids: number[]) => Promise<void>>(async () => undefined),
  purgeCache: vi.fn<(input: { tags?: string[] }) => Promise<void>>(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const original = await importOriginal<typeof Caches>();
  return {
    ...original,
    userCosmeticCache: { ...original.userCosmeticCache, refresh: mocks.refreshCosmetics },
  };
});
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Cloudflare>()),
  purgeCache: mocks.purgeCache,
}));

import type * as Cloudflare from '~/server/cloudflare/client';
import type * as Caches from '~/server/redis/caches';
import type * as NotificationService from '~/server/services/notification.service';
import { applyUserScoreUpdates, persistScoreBatch } from '~/server/jobs/update-user-score';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import {
  achievedAtIsObserved,
  achievedAtIsObservedSql,
  backfillScoreTierBatch,
  grantMilestoneCosmeticsBatch,
  grantMilestones,
  grantScoreTierMilestones,
  previewMilestoneCosmetics,
  previewScoreTierBackfill,
} from '~/server/services/creator-milestone-grant.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the grant, backfill and preview SQL unmodified against the real creator_milestone migration
 * on an in-process Postgres. Every excluded account has an eligible twin that differs only in the
 * excluding property, so an exclusion that matched everyone would fail on the twin.
 */

const migrationPath = (name: string) =>
  join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql');
const MIGRATIONS = [
  '20261005120000_creator_milestone',
  '20261007120000_creator_milestone_cosmetic',
].map(migrationPath);
const CARD_DECORATION_MIGRATION = migrationPath('20261027140000_cosmetic_type_card_decoration');
const MYTHIC_MIGRATION = migrationPath('20261027150000_creator_milestone_mythic');

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const ELIGIBLE = 10;
const DELETED = 11;
const BANNED = 12;
const SYSTEM = -1;
const LATE = 13;
const NO_PRIOR_TOTAL = 14;

async function addUser(id: number, total: number | null, flag: 'deleted' | 'banned' | null = null) {
  await q(`INSERT INTO "User" (id, meta, "deletedAt", "bannedAt") VALUES ($1, $2, $3, $4)`, [
    id,
    total == null ? null : JSON.stringify({ scores: { total, models: total } }),
    flag === 'deleted' ? new Date() : null,
    flag === 'banned' ? new Date() : null,
  ]);
}

const held = (userId: number) =>
  q<{ milestoneKey: string; seen: boolean }>(
    `SELECT "milestoneKey", "seenAt" IS NOT NULL AS seen FROM "UserCreatorMilestone"
     WHERE "userId" = $1 ORDER BY "milestoneKey"`,
    [userId]
  );

async function attachCosmetic(key: string) {
  const [{ id }] = await q<{ id: number }>(`INSERT INTO "Cosmetic" DEFAULT VALUES RETURNING id`);
  await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = $2`, [id, key]);
  return id;
}

async function attachExtraCosmetic(key: string) {
  const [{ id }] = await q<{ id: number }>(`INSERT INTO "Cosmetic" DEFAULT VALUES RETURNING id`);
  await q(`INSERT INTO "CreatorMilestoneCosmetic" ("milestoneKey", "cosmeticId") VALUES ($1, $2)`, [
    key,
    id,
  ]);
  return id;
}

const cosmeticsOf = (userId: number) =>
  q<{ cosmeticId: number; claimKey: string }>(
    `SELECT "cosmeticId", "claimKey" FROM "UserCosmetic" WHERE "userId" = $1 ORDER BY 1`,
    [userId]
  );

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    -- The enum as prod has it before the CardDecoration migration: every grant must still parse.
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration',
      'ProfileDecoration', 'ProfileBackground', 'Sticker', 'ChatTheme');
    CREATE TABLE "Cosmetic" (
      id serial PRIMARY KEY, name text, description text,
      type "CosmeticType" NOT NULL DEFAULT 'Badge', source text, "permanentUnlock" boolean, data jsonb
    );
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL REFERENCES "User"(id),
      "cosmeticId" int NOT NULL REFERENCES "Cosmetic"(id),
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(),
      "claimKey" text NOT NULL DEFAULT 'claimed',
      "equippedAt" timestamp(3),
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
  `);
  // Twice: migrations are applied by hand, possibly more than once.
  for (const migration of [...MIGRATIONS, ...MIGRATIONS])
    await holder.db.exec(readFileSync(migration, 'utf8'));
  // Definitions the score detector must ignore: another track below every score, and a score row
  // without a threshold. The migration seeds neither, so without them the track and threshold
  // filters would be untested.
  await holder.db.exec(`
    INSERT INTO "CreatorMilestone" (key, track, threshold, name)
    VALUES ('create:decoy', 'create', 1, 'Decoy'), ('score:unthresholded', 'score', NULL, 'Decoy');
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "UserCosmetic", "UserCreatorMilestone", "User", "CreatorMilestoneCosmetic";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;
  `);
});

describe('nightly grant', () => {
  beforeEach(async () => {
    await addUser(ELIGIBLE, 400);
    await addUser(DELETED, 400, 'deleted');
    await addUser(BANNED, 400, 'banned');
    await addUser(SYSTEM, 400);
    await addUser(LATE, 4000);
    await addUser(NO_PRIOR_TOTAL, null);
  });

  async function runNight() {
    const transitions = await applyUserScoreUpdates(pg, [
      [String(ELIGIBLE), { models: 1200 }],
      [String(DELETED), { models: 1200 }],
      [String(BANNED), { models: 1200 }],
      [String(SYSTEM), { models: 1200 }],
      [String(LATE), { models: 3000 }],
      [String(NO_PRIOR_TOTAL), { models: 600 }],
    ]);
    return { transitions, crossings: await grantScoreTierMilestones(pg, transitions) };
  }

  it('reads each total from before and after the write', async () => {
    const { transitions } = await runNight();
    const byUser = Object.fromEntries(transitions.map((t) => [t.userId, t]));
    expect(byUser[ELIGIBLE]).toEqual({ userId: ELIGIBLE, oldTotal: 400, newTotal: 1200 });
    expect(byUser[LATE]).toEqual({ userId: LATE, oldTotal: 4000, newTotal: 3000 });
    expect(byUser[NO_PRIOR_TOTAL]).toEqual({
      userId: NO_PRIOR_TOTAL,
      oldTotal: null,
      newTotal: 600,
    });
  });

  it('announces only real crossings by eligible accounts', async () => {
    const { crossings } = await runNight();
    expect(crossings.map((c) => `${c.userId}:${c.milestoneKey}`).sort()).toEqual([
      `${ELIGIBLE}:score:kindle`,
      `${ELIGIBLE}:score:spark`,
      `${NO_PRIOR_TOTAL}:score:spark`,
    ]);
  });

  it('grants nothing to deleted, banned or system accounts', async () => {
    await runNight();
    expect(await held(DELETED)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
    expect(await held(SYSTEM)).toEqual([]);
    expect(await held(ELIGIBLE)).toHaveLength(2);
  });

  it('grants a tier the old total already held silently, as seen', async () => {
    await runNight();
    expect(await held(LATE)).toEqual([
      { milestoneKey: 'score:kindle', seen: true },
      { milestoneKey: 'score:spark', seen: true },
    ]);
  });

  it('returns each crossing with the tier name and threshold the notification names', async () => {
    const { crossings } = await runNight();
    expect(crossings.find((c) => c.userId === NO_PRIOR_TOTAL)).toEqual({
      userId: NO_PRIOR_TOTAL,
      milestoneKey: 'score:spark',
      name: 'Spark',
      threshold: 500,
    });
  });

  // An old total sitting exactly on a threshold had already reached it, so that tier is a late grant.
  it.each([
    [500, []],
    [499, ['score:spark']],
  ])('at an old total of %i, announces %j', async (oldTotal, announced) => {
    const AT_EDGE = 20;
    await addUser(AT_EDGE, oldTotal);
    const transitions = await applyUserScoreUpdates(pg, [[String(AT_EDGE), { models: 600 }]]);
    const crossings = await grantScoreTierMilestones(pg, transitions);
    expect(crossings.map((c) => c.milestoneKey)).toEqual(announced);
    expect(await held(AT_EDGE)).toEqual([
      { milestoneKey: 'score:spark', seen: announced.length === 0 },
    ]);
  });

  // A model a moderator takes down stops counting, so a total can fall below a tier already held.
  it('revokes and announces nothing when a total falls below tiers already held', async () => {
    const cosmeticId = await attachCosmetic('score:spark');
    await runNight();
    const before = await held(ELIGIBLE);
    expect(before).toHaveLength(2);

    const transitions = await applyUserScoreUpdates(pg, [[String(ELIGIBLE), { models: 0 }]]);
    expect(transitions).toEqual([{ userId: ELIGIBLE, oldTotal: 1200, newTotal: 0 }]);
    expect(await grantScoreTierMilestones(pg, transitions)).toEqual([]);
    expect(await held(ELIGIBLE)).toEqual(before);
    expect(await cosmeticsOf(ELIGIBLE)).toEqual([{ cosmeticId, claimKey: 'score:spark' }]);
  });

  it('grants nothing twice', async () => {
    const { transitions } = await runNight();
    expect(await grantScoreTierMilestones(pg, transitions)).toEqual([]);
    expect(await held(ELIGIBLE)).toHaveLength(2);
  });

  it('grants the cosmetic of a tier that has one, keyed by the tier, silent grants included', async () => {
    const cosmeticId = await attachCosmetic('score:spark');
    await runNight();
    const granted = await q(
      `SELECT "userId", "claimKey" FROM "UserCosmetic" WHERE "cosmeticId" = $1 ORDER BY 1`,
      [cosmeticId]
    );
    expect(granted).toEqual([
      { userId: ELIGIBLE, claimKey: 'score:spark' },
      { userId: LATE, claimKey: 'score:spark' },
      { userId: NO_PRIOR_TOTAL, claimKey: 'score:spark' },
    ]);
  });
});

describe('shared writer', () => {
  const ACHIEVED = '2025-03-04 05:06:07';
  const candidates = (rows: { userId: number; achievedAt: string | null; silent: boolean }[]) => ({
    sql: `SELECT x."userId", 'create:decoy' AS "milestoneKey", x."achievedAt", x.silent
      FROM jsonb_to_recordset($1::jsonb) AS x("userId" int, "achievedAt" timestamp, silent boolean)`,
    params: [JSON.stringify(rows)],
  });

  beforeEach(async () => {
    await addUser(ELIGIBLE, null);
    await addUser(LATE, null);
    await addUser(DELETED, null, 'deleted');
    await addUser(BANNED, null, 'banned');
    await addUser(SYSTEM, null);
  });

  it('grants any detector key with its own achievedAt, silent rows seen, excluded accounts skipped', async () => {
    const cosmeticId = await attachCosmetic('create:decoy');
    const grants = await grantMilestones(
      pg,
      candidates([
        { userId: ELIGIBLE, achievedAt: ACHIEVED, silent: false },
        { userId: LATE, achievedAt: null, silent: true },
        { userId: DELETED, achievedAt: null, silent: false },
        { userId: BANNED, achievedAt: null, silent: false },
        { userId: SYSTEM, achievedAt: null, silent: false },
      ])
    );
    expect(grants.map((g) => `${g.userId}:${g.silent}`).sort()).toEqual([
      `${ELIGIBLE}:false`,
      `${LATE}:true`,
    ]);
    expect(
      await q(
        `SELECT "userId", to_char("achievedAt", 'YYYY-MM-DD HH24:MI:SS') AS at, "seenAt" IS NOT NULL AS seen
         FROM "UserCreatorMilestone" WHERE "userId" = $1`,
        [ELIGIBLE]
      )
    ).toEqual([{ userId: ELIGIBLE, at: ACHIEVED, seen: false }]);
    expect(await held(LATE)).toEqual([{ milestoneKey: 'create:decoy', seen: true }]);
    expect(
      await q(`SELECT "userId" FROM "UserCosmetic" WHERE "cosmeticId" = $1 ORDER BY 1`, [
        cosmeticId,
      ])
    ).toEqual([{ userId: ELIGIBLE }, { userId: LATE }]);
  });

  it('stamps a candidate with no achievedAt at grant time', async () => {
    await grantMilestones(pg, candidates([{ userId: ELIGIBLE, achievedAt: null, silent: false }]));
    // Compared in SQL: a timestamp without zone round-tripped through a JS Date shifts by the host TZ.
    const [{ secondsAgo }] = await q<{ secondsAgo: number }>(
      `SELECT extract(epoch FROM CURRENT_TIMESTAMP::timestamp - "achievedAt")::float AS "secondsAgo"
       FROM "UserCreatorMilestone" WHERE "userId" = $1`,
      [ELIGIBLE]
    );
    expect(Math.abs(secondsAgo)).toBeLessThan(60);
  });

  // A detector whose silent expression can be NULL must fail quiet, never announce.
  it('treats a NULL silent as silent', async () => {
    const grants = await grantMilestones(
      pg,
      candidates([{ userId: ELIGIBLE, achievedAt: null, silent: null as unknown as boolean }])
    );
    expect(grants.map((g) => g.silent)).toEqual([true]);
    expect(await held(ELIGIBLE)).toEqual([{ milestoneKey: 'create:decoy', seen: true }]);
  });

  it('returns nothing for a milestone already held, and leaves the held row as it was', async () => {
    await grantMilestones(pg, candidates([{ userId: ELIGIBLE, achievedAt: null, silent: true }]));
    expect(
      await grantMilestones(pg, candidates([{ userId: ELIGIBLE, achievedAt: null, silent: false }]))
    ).toEqual([]);
    expect(await held(ELIGIBLE)).toEqual([{ milestoneKey: 'create:decoy', seen: true }]);
  });
});

describe('backfill', () => {
  beforeEach(async () => {
    await addUser(SYSTEM, 20_000_000);
    await addUser(ELIGIBLE, 20_000_000);
    await addUser(DELETED, 20_000_000, 'deleted');
    await addUser(BANNED, 20_000_000, 'banned');
    await addUser(LATE, 600);
    await addUser(NO_PRIOR_TOTAL, 100);
  });

  it('previews exactly what it then grants', async () => {
    const preview = await previewScoreTierBackfill(pg, { afterUserId: -10 });
    expect(preview).toEqual({ users: 2, rows: 10 });

    let cursor = -10;
    let inserted = 0;
    let users = 0;
    for (let i = 0; i < 10; i++) {
      const batch = await backfillScoreTierBatch(pg, { afterUserId: cursor, limit: 1 });
      if (!batch.users || batch.lastUserId == null) break;
      inserted += batch.inserted;
      users += batch.users;
      cursor = batch.lastUserId;
    }
    expect(inserted).toBe(preview.rows);
    expect(users).toBe(preview.users);
    expect(await previewScoreTierBackfill(pg, { afterUserId: -10 })).toEqual({
      users: 0,
      rows: 0,
    });
  });

  it('grants every tier of a user in one batch, all seen, and skips excluded accounts', async () => {
    const first = await backfillScoreTierBatch(pg, { afterUserId: -10, limit: 1 });
    expect(first).toEqual({ users: 1, inserted: 9, lastUserId: ELIGIBLE });
    const ladder = await held(ELIGIBLE);
    expect(ladder).toHaveLength(9);
    expect(ladder.every((row) => row.seen)).toBe(true);

    await backfillScoreTierBatch(pg, { afterUserId: ELIGIBLE, limit: 10 });
    expect(await held(SYSTEM)).toEqual([]);
    expect(await held(DELETED)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
    expect(await held(LATE)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);
  });
});

/**
 * Founding Legends and the showcase's "new this month" read achievedAtIsObserved, so each grant path
 * has to leave the row shape it expects. Not pinned here: a crossing before a definition launches is
 * inserted unseen and stamped seen in a later statement, so it reads as observed unless both land in
 * the same millisecond, in which case it reads as unobserved and simply goes undated. Wrapping the
 * grant and markMilestonesSeen in one transaction would make that every time, and nothing here would
 * notice.
 */
describe('achievedAtIsObserved on every grant path', () => {
  const rowOf = async (userId: number, key: string) => {
    const [row] = await q<{ achievedAt: Date; seenAt: Date | null }>(
      `SELECT "achievedAt", "seenAt" FROM "UserCreatorMilestone" WHERE "userId" = $1 AND "milestoneKey" = $2`,
      [userId, key]
    );
    return row;
  };

  it('is false for a nightly late grant of a tier the old total had already passed', async () => {
    await addUser(LATE, 4000);
    const transitions = await applyUserScoreUpdates(pg, [[String(LATE), { models: 3000 }]]);
    await grantScoreTierMilestones(pg, transitions);
    expect(achievedAtIsObserved(await rowOf(LATE, 'score:spark'))).toBe(false);
  });

  it('is true for a nightly crossing, before and after the user sees it', async () => {
    await addUser(ELIGIBLE, 400);
    const transitions = await applyUserScoreUpdates(pg, [[String(ELIGIBLE), { models: 600 }]]);
    await grantScoreTierMilestones(pg, transitions);
    expect(achievedAtIsObserved(await rowOf(ELIGIBLE, 'score:spark'))).toBe(true);
    await q(
      `UPDATE "UserCreatorMilestone" SET "seenAt" = "achievedAt" + interval '2 days' WHERE "userId" = $1`,
      [ELIGIBLE]
    );
    expect(achievedAtIsObserved(await rowOf(ELIGIBLE, 'score:spark'))).toBe(true);
  });

  it('is false for a row the launch backfill granted', async () => {
    await addUser(ELIGIBLE, 600);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    expect(achievedAtIsObserved(await rowOf(ELIGIBLE, 'score:spark'))).toBe(false);
  });

  it('agrees with its SQL form on every row shape', async () => {
    await addUser(LATE, 4000);
    await addUser(ELIGIBLE, 400);
    const transitions = await applyUserScoreUpdates(pg, [
      [String(LATE), { models: 3000 }],
      [String(ELIGIBLE), { models: 600 }],
    ]);
    await grantScoreTierMilestones(pg, transitions);
    await q(
      `UPDATE "UserCreatorMilestone" SET "seenAt" = "achievedAt" + interval '1 day' WHERE "userId" = $1`,
      [ELIGIBLE]
    );
    await addUser(DELETED, null);
    await grantMilestones(pg, {
      sql: `SELECT $1::int AS "userId", 'create:decoy' AS "milestoneKey", NULL::timestamp AS "achievedAt", false AS silent`,
      params: [DELETED],
    });
    const rows = await q<{ achievedAt: Date; seenAt: Date | null; observed: boolean }>(
      `SELECT "achievedAt", "seenAt", ${achievedAtIsObservedSql('ucm')} AS observed
         FROM "UserCreatorMilestone" ucm`
    );
    expect(new Set(rows.map((row) => row.observed))).toEqual(new Set([true, false]));
    for (const row of rows) expect(row.observed).toBe(achievedAtIsObserved(row));
  });

  it('follows the detector on the shared writer: its own date is observed, none is not', async () => {
    await addUser(ELIGIBLE, null);
    await addUser(LATE, null);
    await grantMilestones(pg, {
      sql: `SELECT x."userId", 'create:decoy' AS "milestoneKey", x."achievedAt", true AS silent
        FROM jsonb_to_recordset($1::jsonb) AS x("userId" int, "achievedAt" timestamp)`,
      params: [
        JSON.stringify([
          { userId: ELIGIBLE, achievedAt: '2025-03-04 05:06:07' },
          { userId: LATE, achievedAt: null },
        ]),
      ],
    });
    expect(achievedAtIsObserved(await rowOf(ELIGIBLE, 'create:decoy'))).toBe(true);
    expect(achievedAtIsObserved(await rowOf(LATE, 'create:decoy'))).toBe(false);
  });
});

describe('cosmetics for existing holders', () => {
  it('grants an attached cosmetic only to eligible holders, and revokes nothing', async () => {
    await addUser(ELIGIBLE, 600);
    await addUser(DELETED, 600);
    await addUser(BANNED, 600);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [DELETED]);
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [BANNED]);
    await attachCosmetic('score:spark');

    expect(await previewMilestoneCosmetics(pg, { afterUserId: 0 })).toEqual({ users: 1, rows: 1 });
    expect(await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10 })).toEqual({
      users: 1,
      inserted: 1,
      lastUserId: ELIGIBLE,
    });
    expect(await q(`SELECT "userId", "claimKey" FROM "UserCosmetic"`)).toEqual([
      { userId: ELIGIBLE, claimKey: 'score:spark' },
    ]);
    expect(await held(DELETED)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);
    expect(await held(BANNED)).toEqual([{ milestoneKey: 'score:spark', seen: true }]);

    const again = await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10 });
    expect(again.inserted).toBe(0);
  });
});

describe('cosmetics beyond the badge', () => {
  it('grants a crossing its badge and every extra, each claimed under the milestone key', async () => {
    await addUser(ELIGIBLE, 400);
    const badge = await attachCosmetic('score:spark');
    const plate = await attachExtraCosmetic('score:spark');
    const transitions = await applyUserScoreUpdates(pg, [[String(ELIGIBLE), { models: 600 }]]);
    await grantScoreTierMilestones(pg, transitions);
    expect(await cosmeticsOf(ELIGIBLE)).toEqual([
      { cosmeticId: badge, claimKey: 'score:spark' },
      { cosmeticId: plate, claimKey: 'score:spark' },
    ]);
  });

  it('grants an extra on a milestone that has no badge', async () => {
    await addUser(ELIGIBLE, 400);
    const plate = await attachExtraCosmetic('score:spark');
    const transitions = await applyUserScoreUpdates(pg, [[String(ELIGIBLE), { models: 600 }]]);
    await grantScoreTierMilestones(pg, transitions);
    expect(await cosmeticsOf(ELIGIBLE)).toEqual([{ cosmeticId: plate, claimKey: 'score:spark' }]);
  });

  it('gives an extra added later to holders who already have the badge, previewed exactly', async () => {
    await addUser(ELIGIBLE, 600);
    await addUser(LATE, 600);
    const badge = await attachCosmetic('score:spark');
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    expect(await cosmeticsOf(ELIGIBLE)).toEqual([{ cosmeticId: badge, claimKey: 'score:spark' }]);

    const plate = await attachExtraCosmetic('score:spark');
    expect(await previewMilestoneCosmetics(pg, { afterUserId: 0 })).toEqual({ users: 2, rows: 2 });
    expect(
      await grantMilestoneCosmeticsBatch(pg, {
        afterUserId: 0,
        limit: 10,
        milestoneKey: 'score:spark',
      })
    ).toEqual({ users: 2, inserted: 2, lastUserId: LATE });
    for (const holderId of [ELIGIBLE, LATE]) {
      expect(await cosmeticsOf(holderId)).toEqual([
        { cosmeticId: badge, claimKey: 'score:spark' },
        { cosmeticId: plate, claimKey: 'score:spark' },
      ]);
    }
    expect(await previewMilestoneCosmetics(pg, { afterUserId: 0 })).toEqual({ users: 0, rows: 0 });
  });

  it('counts a cosmetic listed as both badge and extra once, in the preview as in the grant', async () => {
    await addUser(ELIGIBLE, 600);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    const badge = await attachCosmetic('score:spark');
    await q(
      `INSERT INTO "CreatorMilestoneCosmetic" ("milestoneKey", "cosmeticId") VALUES ($1, $2)`,
      ['score:spark', badge]
    );
    expect(await previewMilestoneCosmetics(pg, { afterUserId: 0 })).toEqual({ users: 1, rows: 1 });
    expect(await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10 })).toEqual({
      users: 1,
      inserted: 1,
      lastUserId: ELIGIBLE,
    });
  });
});

describe('nightly grant before a definition launches', () => {
  const { launchedAt } = creatorMilestoneRegistry['score:spark'];
  const BEFORE_LAUNCH = new Date(launchedAt.getTime() - 1);
  const AFTER_LAUNCH = launchedAt;

  beforeAll(async () => {
    await q(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isModerator" boolean NOT NULL DEFAULT false`
    );
  });

  beforeEach(async () => {
    mocks.createNotification.mockClear();
    // Moderators are always in the Creator Journey audience, so Flipt is never asked.
    await addUser(ELIGIBLE, 400);
    await q(`UPDATE "User" SET "isModerator" = true WHERE id = $1`, [ELIGIBLE]);
  });

  async function runBatch(now: Date, models = 600) {
    const ctx = {
      pg,
      jobContext: { on: vi.fn(), checkIfCanceled: vi.fn() } as never,
      tierUnlocks: [],
      tierGrantErrors: [] as unknown[],
    };
    await persistScoreBatch(ctx, [[String(ELIGIBLE), { models }]], { now });
    expect(ctx.tierGrantErrors).toEqual([]);
  }

  const notifiedKeys = () =>
    mocks.createNotification.mock.calls.map(([n]) => (n as { key: string }).key);

  it('grants a crossing seen and announces nothing, leaving other unseen rows alone', async () => {
    await q(
      `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey") VALUES ($1, 'score:kindle')`,
      [ELIGIBLE]
    );
    await runBatch(BEFORE_LAUNCH);
    expect(await held(ELIGIBLE)).toEqual([
      { milestoneKey: 'score:kindle', seen: false },
      { milestoneKey: 'score:spark', seen: true },
    ]);
    expect(notifiedKeys()).toEqual([]);
  });

  it('announces the same crossing unseen once the definition has launched', async () => {
    await runBatch(AFTER_LAUNCH);
    expect(await held(ELIGIBLE)).toEqual([{ milestoneKey: 'score:spark', seen: false }]);
    expect(notifiedKeys()).toEqual([`creator-score-tier-reached:${ELIGIBLE}:score:spark`]);
  });

  it('keeps a held tier and announces nothing when the total falls below it', async () => {
    await runBatch(AFTER_LAUNCH);
    const before = await held(ELIGIBLE);
    expect(before).toEqual([{ milestoneKey: 'score:spark', seen: false }]);
    mocks.createNotification.mockClear();

    await runBatch(AFTER_LAUNCH, 0);
    expect(await held(ELIGIBLE)).toEqual(before);
    expect(notifiedKeys()).toEqual([]);
  });
});

describe('Mythic', () => {
  const MYTHIC = 'score:mythic';
  const WEARER = 30;

  const mythicCosmetics = () =>
    q<{ id: number; type: string }>(
      `SELECT c.id, c.type::text AS type FROM "Cosmetic" c
       WHERE c.id IN (
         SELECT "cosmeticId" FROM "CreatorMilestone" WHERE key = $1
         UNION SELECT "cosmeticId" FROM "CreatorMilestoneCosmetic" WHERE "milestoneKey" = $1
       ) ORDER BY c.type::text`,
      [MYTHIC]
    );
  const worn = (userId: number) =>
    q<{ cosmeticId: number; type: string }>(
      `SELECT uc."cosmeticId", c.type::text AS type FROM "UserCosmetic" uc
       JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
       WHERE uc."userId" = $1 AND uc."equippedAt" IS NOT NULL ORDER BY 1`,
      [userId]
    );
  const cross = async (userId: number, from: number, to: number) => {
    await addUser(userId, from);
    const transitions = await applyUserScoreUpdates(pg, [[String(userId), { models: to }]]);
    return grantScoreTierMilestones(pg, transitions);
  };

  beforeAll(async () => {
    // Twice, as it may be applied by hand more than once; the rows that use the value come after.
    for (const migration of [CARD_DECORATION_MIGRATION, CARD_DECORATION_MIGRATION])
      await holder.db.exec(readFileSync(migration, 'utf8'));
  });

  beforeEach(async () => {
    // The file-wide reset unlinks every milestone cosmetic; the migration is idempotent and relinks.
    for (const migration of [MYTHIC_MIGRATION, MYTHIC_MIGRATION])
      await holder.db.exec(readFileSync(migration, 'utf8'));
    mocks.refreshCosmetics.mockClear();
    mocks.purgeCache.mockClear();
  });

  it('seeds one Mythic row above Legend, with one badge and one card glow', async () => {
    expect(
      await q(
        `SELECT key, threshold, "sortOrder" FROM "CreatorMilestone"
         WHERE key IN ('score:legend', $1) ORDER BY "sortOrder"`,
        [MYTHIC]
      )
    ).toEqual([
      { key: 'score:legend', threshold: 10_000_000, sortOrder: 9 },
      { key: MYTHIC, threshold: 100_000_000, sortOrder: 10 },
    ]);
    expect((await mythicCosmetics()).map((c) => c.type)).toEqual(['Badge', 'CardDecoration']);
    // Applied twice per test, so a second insert would show here.
    expect(await q(`SELECT count(*)::int AS n FROM "Cosmetic" WHERE name LIKE 'Mythic %'`)).toEqual(
      [{ n: 2 }]
    );
  });

  it.each([
    [99_999_999, []],
    [100_000_000, [MYTHIC]],
  ])('at a new total of %i, crosses %j', async (total, crossed) => {
    const crossings = await cross(ELIGIBLE, 50_000_000, total);
    expect(crossings.map((c) => c.milestoneKey).filter((key) => key === MYTHIC)).toEqual(crossed);
  });

  it('grants a crossing the badge and the glow, wearing the glow and not the badge', async () => {
    await cross(ELIGIBLE, 50_000_000, 100_000_000);
    const cosmetics = await mythicCosmetics();
    const glow = cosmetics.find((c) => c.type === 'CardDecoration');
    expect(
      (await cosmeticsOf(ELIGIBLE)).filter((c) => c.claimKey === MYTHIC).map((c) => c.cosmeticId)
    ).toEqual(cosmetics.map((c) => c.id).sort((a, b) => a - b));
    expect(await worn(ELIGIBLE)).toEqual([{ cosmeticId: glow?.id, type: 'CardDecoration' }]);
    expect(mocks.refreshCosmetics).toHaveBeenCalledTimes(1);
    expect(mocks.refreshCosmetics).toHaveBeenCalledWith([ELIGIBLE]);
    expect(mocks.purgeCache).toHaveBeenCalledTimes(1);
    expect(mocks.purgeCache).toHaveBeenCalledWith({ tags: [`user-creator-${ELIGIBLE}`] });
  });

  const mythicGlowOf = async (userId: number) => {
    const glow = (await mythicCosmetics()).find((c) => c.type === 'CardDecoration');
    return q<{ worn: boolean }>(
      `SELECT "equippedAt" IS NOT NULL AS worn FROM "UserCosmetic"
       WHERE "userId" = $1 AND "cosmeticId" = $2`,
      [userId, glow?.id]
    );
  };
  /** A glow from elsewhere (the shop, later) that `userId` owns, worn or not. */
  const giveShopGlow = async (userId: number, wearing: boolean) => {
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "Cosmetic" (name, type) VALUES ('Shop glow', 'CardDecoration') RETURNING id`
    );
    await q(
      `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "equippedAt")
       VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END)`,
      [userId, id, wearing]
    );
    return id;
  };

  afterEach(async () => {
    await q(`DELETE FROM "UserCosmetic" WHERE "cosmeticId" IN (
      SELECT id FROM "Cosmetic" WHERE name = 'Shop glow')`);
    await q(`DELETE FROM "Cosmetic" WHERE name = 'Shop glow'`);
  });

  it('leaves a glow the creator already wears on, and grants the Mythic one unworn', async () => {
    await addUser(WEARER, 50_000_000);
    const own = await giveShopGlow(WEARER, true);
    const transitions = await applyUserScoreUpdates(pg, [
      [String(WEARER), { models: 100_000_000 }],
    ]);
    const crossings = await grantScoreTierMilestones(pg, transitions);
    expect(crossings.map((c) => c.milestoneKey)).toContain(MYTHIC);
    expect(await mythicGlowOf(WEARER)).toEqual([{ worn: false }]);
    expect(await worn(WEARER)).toEqual([{ cosmeticId: own, type: 'CardDecoration' }]);
    expect(mocks.refreshCosmetics).not.toHaveBeenCalled();
  });

  it('wears the Mythic glow for a creator who owns another glow but is not wearing it', async () => {
    await addUser(WEARER, 50_000_000);
    await giveShopGlow(WEARER, false);
    const transitions = await applyUserScoreUpdates(pg, [
      [String(WEARER), { models: 100_000_000 }],
    ]);
    await grantScoreTierMilestones(pg, transitions);
    expect(await mythicGlowOf(WEARER)).toEqual([{ worn: true }]);
  });

  it('decides per creator: one wearing a glow does not stop another being equipped', async () => {
    await addUser(WEARER, 50_000_000);
    await addUser(ELIGIBLE, 50_000_000);
    await giveShopGlow(WEARER, true);
    const transitions = await applyUserScoreUpdates(pg, [
      [String(WEARER), { models: 100_000_000 }],
      [String(ELIGIBLE), { models: 100_000_000 }],
    ]);
    await grantScoreTierMilestones(pg, transitions);
    expect(await mythicGlowOf(WEARER)).toEqual([{ worn: false }]);
    expect(await mythicGlowOf(ELIGIBLE)).toEqual([{ worn: true }]);
    expect(mocks.refreshCosmetics).toHaveBeenCalledTimes(1);
    expect(mocks.refreshCosmetics).toHaveBeenCalledWith([ELIGIBLE]);
  });

  it('keeps the committed grant when refreshing the caches fails', async () => {
    mocks.refreshCosmetics.mockRejectedValueOnce(new Error('redis down'));
    const crossings = await cross(ELIGIBLE, 50_000_000, 100_000_000);
    expect(crossings.map((c) => c.milestoneKey)).toContain(MYTHIC);
    expect(await mythicGlowOf(ELIGIBLE)).toEqual([{ worn: true }]);
  });

  it('wears the glow for a creator the backfill grants silently, and refreshes their card', async () => {
    await addUser(ELIGIBLE, 150_000_000);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    expect(await held(ELIGIBLE)).toContainEqual({ milestoneKey: MYTHIC, seen: true });
    expect((await worn(ELIGIBLE)).map((c) => c.type)).toEqual(['CardDecoration']);
    expect(mocks.refreshCosmetics).toHaveBeenCalledWith([ELIGIBLE]);
  });

  it('wears a glow attached to an existing holder by the cosmetics batch', async () => {
    await addUser(ELIGIBLE, 150_000_000);
    await q(`DELETE FROM "CreatorMilestoneCosmetic" WHERE "milestoneKey" = $1`, [MYTHIC]);
    await backfillScoreTierBatch(pg, { afterUserId: 0, limit: 10 });
    expect(await worn(ELIGIBLE)).toEqual([]);

    await holder.db.exec(readFileSync(MYTHIC_MIGRATION, 'utf8'));
    await grantMilestoneCosmeticsBatch(pg, { afterUserId: 0, limit: 10, milestoneKey: MYTHIC });
    expect((await worn(ELIGIBLE)).map((c) => c.type)).toEqual(['CardDecoration']);
    expect(mocks.refreshCosmetics).toHaveBeenLastCalledWith([ELIGIBLE]);
  });
});
