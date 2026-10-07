import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityWatermark,
  ActivityWatermarkStore,
} from '~/server/services/creator-milestone-activity.service';
import {
  announceFromFor,
  previewActivityGrants,
  runActivityGroup,
  definitionsFingerprint,
  watermarkKeyFor,
} from '~/server/services/creator-milestone-activity.service';
import type { MilestoneDetectorGroup } from '~/server/services/creator-milestone-detectors';
import { activityDetectorGroups } from '~/server/services/creator-milestone-detectors';
import type { MilestoneGrant } from '~/server/services/creator-milestone-grant.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the activity detectors and the grant runner unmodified against every CreatorMilestone
 * migration on an in-process Postgres, with the source tables cut down to the columns they read.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const CREATOR = 10;
const QUIET = 11;
const BANNED = 12;
const TESTER = 13;

const groups = activityDetectorGroups();
const groupFor = (key: string) => {
  const group = groups.find((g) => g.keys.includes(key));
  if (!group) throw new Error(`no group for ${key}`);
  return group;
};
// Registered silent until the Achievements section ships (see the pin below), so the announcing
// rules are exercised on announced copies of the real groups.
const announced = (group: MilestoneDetectorGroup) => ({ ...group, silent: false });
const MODELS = announced(groupFor('create:models-1'));
const ARTICLES = announced(groupFor('create:articles-1'));
const DOWNLOADS = groupFor('reach:downloads-100');
const FOLLOWERS = announced(groupFor('reach:followers-100'));

const AFTER_LAUNCH = new Date('2026-11-01T00:00:00Z');

function memoryStore(initial: Record<string, ActivityWatermark> = {}) {
  const rows = new Map(Object.entries(initial));
  const store: ActivityWatermarkStore = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, watermark) => void rows.set(key, watermark),
  };
  return { store, rows };
}

async function fingerprintFor(group: MilestoneDetectorGroup) {
  const definitions = await q<{ key: string; threshold: number | null }>(
    `SELECT key, threshold FROM "CreatorMilestone" WHERE key = ANY($1::text[])`,
    [group.keys]
  );
  return definitionsFingerprint(definitions);
}

type PreviousRun = Omit<ActivityWatermark, 'definitions'> & { definitions?: string };

async function run(
  group: MilestoneDetectorGroup,
  {
    watermark = null as PreviousRun | null,
    gated = false,
    audience = null as number[] | null,
    now = AFTER_LAUNCH,
    chunkSize = undefined as number | undefined,
  } = {}
) {
  const { store, rows } = memoryStore(
    watermark
      ? {
          [watermarkKeyFor(group)]: {
            definitions: await fingerprintFor(group),
            ...watermark,
          },
        }
      : {}
  );
  const notified: MilestoneGrant[] = [];
  const result = await runActivityGroup(group, {
    readPg: pg,
    writePg: pg,
    store,
    gated,
    now,
    audienceAmong: async (ids) => new Set(ids.filter((id) => !audience || audience.includes(id))),
    notify: async (grants) => void notified.push(...grants),
    chunkSize,
  });
  return { result, notified, rows };
}

const held = (userId: number) =>
  q<{ key: string; seen: boolean; at: string }>(
    `SELECT "milestoneKey" AS key, "seenAt" IS NOT NULL AS seen,
       to_char("achievedAt", 'YYYY-MM-DD HH24:MI') AS at
     FROM "UserCreatorMilestone" WHERE "userId" = $1 ORDER BY 1`,
    [userId]
  );

async function addModels(userId: number, publishedAt: string[], status = 'Published') {
  for (const at of publishedAt)
    await q(
      `INSERT INTO "Model" ("userId", status, "publishedAt") VALUES ($1, $2, $3::timestamp)`,
      [userId, status, at]
    );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL, "cosmeticId" int NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Model" (
      id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', mode text,
      "deletedAt" timestamp(3), "publishedAt" timestamp(3)
    );
    CREATE TABLE "Article" (
      id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', "publishedAt" timestamp(3)
    );
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      availability text NOT NULL DEFAULT 'Public', "downloadCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "UserMetric" (
      "userId" int NOT NULL, timeframe text NOT NULL,
      "followerCount" int NOT NULL DEFAULT 0, "reactionCount" int NOT NULL DEFAULT 0,
      PRIMARY KEY ("userId", timeframe)
    );
  `);
  const migrations = readdirSync(MIGRATIONS)
    .sort()
    .map((dir) => join(MIGRATIONS, dir, 'migration.sql'))
    .filter((file) => {
      try {
        return readFileSync(file, 'utf8').includes('"CreatorMilestone"');
      } catch {
        return false;
      }
    });
  for (const file of migrations) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "UserCosmetic", "UserCreatorMilestone", "User", "Model", "Article", "ModelMetric", "UserMetric";
  `);
  for (const id of [CREATOR, QUIET, TESTER]) await q(`INSERT INTO "User" (id) VALUES ($1)`, [id]);
  await q(`INSERT INTO "User" (id, "bannedAt") VALUES ($1, now())`, [BANNED]);
});

describe('published-count detector', () => {
  it('dates each milestone by the publish of the item that reached it, still-published items only', async () => {
    await addModels(CREATOR, [
      '2026-01-01 10:00',
      '2026-01-02 10:00',
      '2026-01-03 10:00',
      '2026-01-04 10:00',
      '2026-01-05 10:00',
    ]);
    await addModels(QUIET, ['2026-01-01 10:00', '2026-01-02 10:00'], 'Draft');
    await q(
      `INSERT INTO "Model" ("userId", status, "deletedAt", availability, mode, "publishedAt") VALUES
        ($1, 'Published', now(), 'Public', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Private', NULL, '2026-01-01'),
        ($1, 'Published', NULL, 'Public', 'Archived', '2026-01-01')`,
      [QUIET]
    );
    await run(MODELS);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-01-01 10:00' },
      { key: 'create:models-5', seen: true, at: '2026-01-05 10:00' },
    ]);
    expect(await held(QUIET)).toEqual([]);
  });

  it('counts articles separately from models', async () => {
    await q(
      `INSERT INTO "Article" ("userId", status, "publishedAt") VALUES ($1, 'Published', '2026-02-01')`,
      [CREATOR]
    );
    await addModels(QUIET, ['2026-02-01']);
    await q(
      `INSERT INTO "Article" ("userId", status, availability, "publishedAt") VALUES
        ($1, 'Published', 'Private', '2026-02-01'),
        ($1, 'Published', 'Public', now() + interval '1 day')`,
      [TESTER]
    );
    await run(ARTICLES);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['create:articles-1']);
    expect(await held(QUIET)).toEqual([]);
    expect(await held(TESTER)).toEqual([]);
  });
});

describe('download and user-metric detectors', () => {
  it('takes the best published, non-private model, and grants every threshold it passes', async () => {
    await q(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, availability, "downloadCount") VALUES
        (1, $1, 'Published', 'Public', 600),
        (4, $1, 'Published', 'Public', 500),
        (2, $1, 'Published', 'Private', 900000),
        (3, $2, 'Draft', 'Public', 900000)`,
      [CREATOR, QUIET]
    );
    await run(DOWNLOADS);
    // 600 + 500 would pass 1,000: the definition is one model's downloads, not the creator's total.
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['reach:downloads-100']);
    expect(await held(QUIET)).toEqual([]);
  });

  it('reads the AllTime row only, and never grants an excluded account', async () => {
    await q(
      `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES
        ($1, 'AllTime', 150), ($2, 'Day', 5000), ($3, 'AllTime', 5000)`,
      [CREATOR, QUIET, BANNED]
    );
    await run(FOLLOWERS);
    expect((await held(CREATOR)).map((r) => r.key)).toEqual(['reach:followers-100']);
    expect(await held(QUIET)).toEqual([]);
    expect(await held(BANNED)).toEqual([]);
  });
});

/**
 * 🔴 The launch-burst guard. Each of these is a decision, not an accident: without a previous complete
 * run nothing can be told apart from a backlog, so ~150k qualifying creators would each be notified
 * at once. If you are about to relax one of these, the first ungated run in production is what it
 * breaks.
 */
describe('announcing', () => {
  const yesterday = (gated = false): PreviousRun => ({
    at: new Date('2026-10-31T00:00:00Z').getTime(),
    gated,
  });

  it('NO WATERMARK MEANS NO NOTIFICATIONS: a first run grants everything seen and announces nothing', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await q(
      `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES ($1, 'AllTime', 150)`,
      [CREATOR]
    );
    const models = await run(MODELS);
    const followers = await run(FOLLOWERS);
    expect(models.notified).toEqual([]);
    expect(followers.notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-31 12:00' },
      { key: 'reach:followers-100', seen: true, at: expect.any(String) },
    ]);
  });

  it('announces a dated milestone reached since the previous run, and not one from before it', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(QUIET, ['2026-10-30 12:00']);
    const { notified } = await run(MODELS, { watermark: yesterday() });
    expect(notified.map((g) => `${g.userId}:${g.milestoneKey}`)).toEqual([
      `${CREATOR}:create:models-1`,
    ]);
    expect(await held(QUIET)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-30 12:00' },
    ]);
  });

  it.each([
    { when: 'both runs ungated', previousGated: false, gated: false, announced: true },
    { when: 'the previous run gated', previousGated: true, gated: false, announced: false },
    { when: 'this run gated', previousGated: false, gated: true, announced: false },
  ])(
    'an undated milestone, $when: announced=$announced',
    async ({ previousGated, gated, announced }) => {
      await q(
        `INSERT INTO "UserMetric" ("userId", timeframe, "followerCount") VALUES ($1, 'AllTime', 150)`,
        [CREATOR]
      );
      const { notified } = await run(FOLLOWERS, { watermark: yesterday(previousGated), gated });
      expect(notified.length > 0).toBe(announced);
      expect((await held(CREATOR)).map((r) => r.seen)).toEqual([!announced]);
    }
  );

  it('never announces a silent definition', async () => {
    await q(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, "downloadCount") VALUES (1, $1, 'Published', 150)`,
      [CREATOR]
    );
    const { notified } = await run(DOWNLOADS, { watermark: yesterday() });
    expect(notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'reach:downloads-100', seen: true, at: expect.any(String) },
    ]);
  });

  it('while gated, grants only the flag audience', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 12:00']);
    const { result } = await run(MODELS, {
      watermark: yesterday(true),
      gated: true,
      audience: [TESTER],
    });
    expect(result).toMatchObject({ candidates: 2, audience: 1, granted: 1 });
    expect(await held(CREATOR)).toEqual([]);
    expect((await held(TESTER)).map((r) => r.key)).toEqual(['create:models-1']);
  });

  it('records the run, and a second run grants and announces nothing', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const first = await run(MODELS, { watermark: yesterday() });
    expect([...first.rows.values()]).toEqual([
      { at: AFTER_LAUNCH.getTime(), gated: false, definitions: await fingerprintFor(MODELS) },
    ]);
    const second = await run(MODELS, { watermark: yesterday() });
    expect(second.result.granted).toBe(0);
    expect(second.notified).toEqual([]);
  });

  it('refuses to run a group whose definitions are not seeded, and records nothing', async () => {
    const { store, rows } = memoryStore();
    await expect(
      runActivityGroup(
        { ...MODELS, keys: [...MODELS.keys, 'create:models-999'] },
        {
          readPg: pg,
          writePg: pg,
          store,
          gated: false,
          audienceAmong: async (ids) => new Set(ids),
          notify: async () => undefined,
        }
      )
    ).rejects.toThrow('No CreatorMilestone row for create:models-999');
    expect(rows.size).toBe(0);
  });

  it('ungated, grants everyone but tells only the flag audience', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 12:00']);
    const { notified } = await run(MODELS, { watermark: yesterday(), audience: [TESTER] });
    expect(notified.map((g) => g.userId)).toEqual([TESTER]);
    expect((await held(CREATOR)).map((r) => r.seen)).toEqual([false]);
  });

  it('grants and announces across chunks', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    await addModels(TESTER, ['2026-10-31 13:00']);
    const { notified } = await run(MODELS, { watermark: yesterday(), chunkSize: 1 });
    expect(notified.map((g) => g.userId).sort()).toEqual([CREATOR, TESTER]);
  });

  // publishedAt is stored in UTC with no zone; the cutoff must not move with the session's zone.
  it('compares the cutoff in UTC whatever the session zone', async () => {
    await addModels(CREATOR, ['2026-10-31 00:30']);
    await addModels(QUIET, ['2026-10-30 23:30']);
    await q(`SET TIME ZONE 'America/New_York'`);
    try {
      const { notified } = await run(MODELS, { watermark: yesterday() });
      expect(notified.map((g) => g.userId)).toEqual([CREATOR]);
    } finally {
      await q(`SET TIME ZONE 'UTC'`);
    }
  });

  it('leaves the watermark alone when a grant fails, so the next run is not told it completed', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const { store, rows } = memoryStore();
    const failing = {
      cancellableQuery: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO')) throw new Error('write failed');
        return (pg as { cancellableQuery: (s: string, p?: unknown[]) => unknown }).cancellableQuery(
          sql,
          params
        );
      },
    } as never;
    await expect(
      runActivityGroup(MODELS, {
        readPg: pg,
        writePg: failing,
        store,
        gated: false,
        audienceAmong: async (ids) => new Set(ids),
        notify: async () => undefined,
      })
    ).rejects.toThrow('write failed');
    expect(rows.size).toBe(0);
  });
});

describe('announceFromFor', () => {
  const launchedAt = new Date('2026-10-07T00:00:00Z');
  const previous = { at: new Date('2026-10-10T00:00:00Z').getTime(), gated: false };

  it('announces a timed group from the later of launch and the previous run', () => {
    const timed = { launchedAt, silent: false, timed: true };
    expect(announceFromFor(timed, previous, false)).toEqual(new Date(previous.at));
    expect(announceFromFor(timed, { ...previous, at: 0 }, false)).toEqual(launchedAt);
  });

  it('does not announce an undated group launched after the previous run', () => {
    const untimed = { launchedAt: new Date('2026-10-11T00:00:00Z'), silent: false, timed: false };
    expect(announceFromFor(untimed, previous, false)).toBeNull();
  });
});

describe('watermark definitions', () => {
  const rows = [
    { key: 'create:models-1', threshold: 1 },
    { key: 'create:models-5', threshold: 5 },
  ];

  it('fingerprints the keys and thresholds a run used, so adding a key or moving a threshold changes it', () => {
    const base = definitionsFingerprint(rows);
    expect(definitionsFingerprint([...rows, { key: 'create:models-50', threshold: 50 }])).not.toBe(
      base
    );
    expect(definitionsFingerprint([rows[0], { key: 'create:models-5', threshold: 4 }])).not.toBe(
      base
    );
  });

  it('does not depend on the order Postgres returns the rows in', () => {
    expect(definitionsFingerprint([...rows].reverse())).toBe(definitionsFingerprint(rows));
  });

  // Keyed by group, not by definitions, so reverting a threshold cannot pick up a weeks-old row.
  it('treats a watermark recorded against other definitions as none, so the run is silent', async () => {
    await addModels(CREATOR, ['2026-10-31 12:00']);
    const { notified, rows: stored } = await run(MODELS, {
      watermark: {
        at: new Date('2026-10-31T00:00:00Z').getTime(),
        gated: false,
        definitions: 'other',
      },
    });
    expect(notified).toEqual([]);
    expect(await held(CREATOR)).toEqual([
      { key: 'create:models-1', seen: true, at: '2026-10-31 12:00' },
    ]);
    expect([...stored.values()][0]).toMatchObject({ definitions: await fingerprintFor(MODELS) });
  });
});

/**
 * 🔴 Shipping these announced before the journey page can show them sends people to a page where the
 * milestone does not appear. The Achievements section's PR turns this off; flipping it renames each
 * group's watermark, so the first announced run is silent.
 */
describe('activity milestones before the Achievements section', () => {
  it('registers every activity group silent', () => {
    expect(groups.filter((group) => !group.silent).map((group) => group.id)).toEqual([]);
    expect(groups.length).toBeGreaterThan(0);
  });
});

describe('launch-day preview', () => {
  it('counts what an ungated run would grant, excluding accounts that cannot receive one', async () => {
    await addModels(CREATOR, [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
    await addModels(BANNED, ['2026-01-01']);
    const preview = await previewActivityGrants(pg, [MODELS]);
    expect(preview).toEqual([{ group: MODELS.id, users: 1, rows: 2 }]);
    expect(await held(CREATOR)).toEqual([]);
  });
});
