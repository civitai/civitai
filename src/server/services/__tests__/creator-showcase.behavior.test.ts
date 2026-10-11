// A zone behind UTC, so the month window's UTC handling is checked under CI's UTC as well.
process.env.TZ = 'America/Los_Angeles';

import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  excluded: vi.fn(async (): Promise<number[]> => []),
  basic: vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { id, username: `u${id}`, image: `img${id}` }]))
  ),
  pictures: vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { id: id * 100 }]))
  ),
  cosmetics: vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, [{ cosmeticId: id }]]))
  ),
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcluded>()),
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: mocks.pictures,
  getCosmeticsForUsers: mocks.cosmetics,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const original = await importOriginal<typeof Caches>();
  return { ...original, userBasicCache: { ...original.userBasicCache, fetch: mocks.basic } };
});

import type * as MetricExcluded from '~/server/services/metric-excluded-users.service';
import type * as UserService from '~/server/services/user.service';
import type * as Caches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { getLegendStatus } from '~/server/services/creator-journey.service';
import { getCreatorShowcase, getShowcaseRows } from '~/server/services/creator-showcase.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the showcase SQL unmodified on an in-process Postgres. Every account the good-standing filter
 * drops has a twin that differs only in that one property, so a filter matching everyone fails on
 * the twin.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const queried = vi.fn();
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => {
    queried(sql);
    return {
      result: async () => (await holder.db.query(sql, params)).rows,
      cancel: async () => undefined,
    };
  },
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);
const candidateReads = () =>
  queried.mock.calls.filter(([sql]) => String(sql).includes('FROM "UserCreatorMilestone"')).length;

const NOW = new Date('2026-11-15T12:00:00Z');
const THIS_MONTH = '2026-11-02 08:00:00';
const LAST_MONTH = '2026-10-20 08:00:00';

const GOOD = 10;
const MUTED = 11;
const DELETED = 12;
const BANNED = 13;
const STRUCK = 14;
const SUPPRESSED = 15;
const EXPIRED_STRIKE = 16;
const LEADERBOARD_EXCLUDED = 17;
const OTHER = 18;
const SYSTEM = -1;

type Flags = { muted?: boolean; deleted?: boolean; banned?: boolean; excluded?: boolean };
async function addUser(id: number, flags: Flags = {}) {
  await q(
    `INSERT INTO "User" (id, muted, "deletedAt", "bannedAt", "excludeFromLeaderboards")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      !!flags.muted,
      flags.deleted ? new Date() : null,
      flags.banned ? new Date() : null,
      !!flags.excluded,
    ]
  );
}

/** `silent` mirrors the grant writer: a silent grant stamps seenAt equal to achievedAt. */
const grant = (userId: number, key: string, achievedAt: string, silent = false) =>
  q(
    `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt", "seenAt")
     VALUES ($1, $2, $3::timestamp, CASE WHEN $4::boolean THEN $3::timestamp END)`,
    [userId, key, achievedAt, silent]
  );

const setPrivacy = (userId: number, settings: Record<string, unknown>) =>
  q(`INSERT INTO "UserProfile" ("userId", "privacySettings") VALUES ($1, $2)`, [
    userId,
    JSON.stringify(settings),
  ]);

const showcase = (excludedUserIds: number[] = [], now = NOW) =>
  getShowcaseRows(pg, { now, excludedUserIds });
const ids = (rows: { userId: number }[]) => rows.map((row) => row.userId);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3),
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false, settings jsonb DEFAULT '{}');
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
    CREATE TABLE "UserStrike" ("userId" int NOT NULL, status text NOT NULL,
      "expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY, "privacySettings" jsonb);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

const cache = new Map<string, unknown>();

beforeEach(async () => {
  queried.mockClear();
  cache.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) => cache.get(key) ?? null);
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, value);
    return 'OK';
  });
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  mocks.excluded.mockReset().mockResolvedValue([]);
  await holder.db.exec(`
    TRUNCATE "UserCreatorMilestone", "UserStrike", "UserProfile", "User";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;
  `);
});

describe('good standing', () => {
  beforeEach(async () => {
    await addUser(GOOD);
    await addUser(MUTED, { muted: true });
    await addUser(DELETED, { deleted: true });
    await addUser(BANNED, { banned: true });
    await addUser(STRUCK);
    await addUser(SUPPRESSED);
    await addUser(EXPIRED_STRIKE);
    await addUser(LEADERBOARD_EXCLUDED, { excluded: true });
    await addUser(SYSTEM);
    // EXPIRED_STRIKE's strike ran out after the month began but before now: it no longer counts.
    await q(
      `INSERT INTO "UserStrike" VALUES ($1, 'Active', '2026-12-01'), ($2, 'Active', '2026-11-10'), ($3, 'Voided', '2026-12-01')`,
      [STRUCK, EXPIRED_STRIKE, GOOD]
    );
    for (const id of [
      GOOD,
      MUTED,
      DELETED,
      BANNED,
      STRUCK,
      SUPPRESSED,
      EXPIRED_STRIKE,
      LEADERBOARD_EXCLUDED,
      SYSTEM,
    ])
      await grant(id, 'score:legend', THIS_MONTH);
  });

  it('lists only Legends in good standing, keeping a voided or expired strike', async () => {
    expect(ids((await showcase([SUPPRESSED])).legends)).toEqual([GOOD, EXPIRED_STRIKE]);
  });

  it('drops the metric-suppressed account only when it is on the list', async () => {
    expect(ids((await showcase([])).legends)).toContain(SUPPRESSED);
  });
});

describe('ordering', () => {
  beforeEach(async () => {
    for (const id of [GOOD, OTHER]) await addUser(id);
  });

  // Inserted against the expected order, and with ids against it too, so neither heap order nor a
  // userId sort can pass for the achievedAt sort.
  it('lists Legends oldest first', async () => {
    await grant(GOOD, 'score:legend', '2026-11-04 00:00:00');
    await grant(OTHER, 'score:legend', '2026-11-03 00:00:00');
    expect(ids((await showcase()).legends)).toEqual([OTHER, GOOD]);
  });

  it('lists new Supernovas newest first', async () => {
    await grant(GOOD, 'score:supernova', '2026-11-04 00:00:00');
    await grant(OTHER, 'score:supernova', '2026-11-03 00:00:00');
    expect(ids((await showcase()).newSupernovas)).toEqual([GOOD, OTHER]);
  });
});

describe('new Supernovas this month', () => {
  beforeEach(async () => {
    for (const id of [GOOD, MUTED, STRUCK]) await addUser(id);
  });

  it('starts exactly at the UTC month boundary', async () => {
    await grant(GOOD, 'score:supernova', '2026-11-01 00:00:00');
    await grant(MUTED, 'score:supernova', '2026-10-31 23:59:59.999');
    expect(ids((await showcase()).newSupernovas)).toEqual([GOOD]);
  });

  it('is already this month at the first instant of it', async () => {
    await grant(GOOD, 'score:supernova', '2026-11-01 00:00:00');
    await grant(MUTED, 'score:supernova', LAST_MONTH);
    const atMonthStart = new Date('2026-11-01T00:00:00Z');
    expect(ids((await showcase([], atMonthStart)).newSupernovas)).toEqual([GOOD]);
  });

  // The launch backfill grants every existing Supernova silently, in whatever month it runs.
  it('leaves out a Supernova granted silently this month', async () => {
    await grant(GOOD, 'score:supernova', THIS_MONTH);
    await grant(STRUCK, 'score:supernova', THIS_MONTH, true);
    expect(ids((await showcase()).newSupernovas)).toEqual([GOOD]);
  });

  it('keeps a silently granted Legend in the Hall of Fame', async () => {
    await grant(GOOD, 'score:legend', LAST_MONTH, true);
    expect(ids((await showcase()).legends)).toEqual([GOOD]);
  });
});

describe('badge privacy', () => {
  const attachBadge = async (key: string) => {
    const { rows } = await q(`INSERT INTO "Cosmetic" DEFAULT VALUES RETURNING id`);
    const { id } = rows[0] as { id: number };
    await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = $2`, [id, key]);
    return id;
  };

  beforeEach(async () => {
    for (const id of [GOOD, MUTED, STRUCK]) await addUser(id);
  });

  it('leaves out a Legend who hides the Legend badge or all badges, not one hiding another', async () => {
    const badge = await attachBadge('score:legend');
    for (const id of [GOOD, MUTED, STRUCK]) await grant(id, 'score:legend', LAST_MONTH);
    await setPrivacy(MUTED, { hiddenBadgeIds: [badge] });
    await setPrivacy(STRUCK, { showBadges: false });
    await setPrivacy(GOOD, { hiddenBadgeIds: [badge + 1] });
    expect(ids((await showcase()).legends)).toEqual([GOOD]);
  });

  it('leaves out a new Supernova who hides the Supernova badge', async () => {
    const badge = await attachBadge('score:supernova');
    for (const id of [GOOD, MUTED]) await grant(id, 'score:supernova', THIS_MONTH);
    await setPrivacy(MUTED, { hiddenBadgeIds: [badge] });
    expect(ids((await showcase()).newSupernovas)).toEqual([GOOD]);
  });
});

describe('getCreatorShowcase', () => {
  it('refuses to list anyone when the suppressed-account list cannot be read', async () => {
    mocks.excluded.mockRejectedValue(new Error('clickhouse down'));
    await expect(getCreatorShowcase({ pg, now: NOW })).rejects.toThrow('clickhouse down');
    expect(queried).not.toHaveBeenCalled();
  });

  it('passes the suppressed list to the query and shapes each creator for the avatar', async () => {
    await addUser(GOOD);
    await addUser(SUPPRESSED);
    await grant(GOOD, 'score:legend', LAST_MONTH, true);
    await grant(SUPPRESSED, 'score:legend', LAST_MONTH);
    await grant(GOOD, 'score:supernova', THIS_MONTH);
    mocks.excluded.mockResolvedValue([SUPPRESSED]);

    const result = await getCreatorShowcase({ pg, now: NOW });
    const user = {
      id: GOOD,
      username: `u${GOOD}`,
      image: `img${GOOD}`,
      profilePicture: { id: GOOD * 100 },
      cosmetics: [{ cosmeticId: GOOD }],
    };
    expect(result.legends).toEqual([{ user, founding: true, since: null }]);
    expect(result.newSupernovas).toEqual([{ user, achievedAt: expect.any(Date) }]);
  });
});

describe('cached candidates, live standing', () => {
  const legendRow = {
    achievedAt: new Date(LAST_MONTH),
    seenAt: null,
    milestone: { cosmeticId: null },
  };

  beforeEach(() => {
    dbMock.dbRead.userCreatorMilestone.findUnique.mockResolvedValue(legendRow as never);
    dbMock.dbRead.userProfile.findUnique.mockResolvedValue(null);
  });

  // Pinned for the CJ lead (2026-10-07): the profile's "one of N" and the Hall of Fame must never
  // disagree, so both read one cached candidate list. Either may be the first to fill it.
  it('is the Hall of Fame length, read from the same cached entry', async () => {
    await addUser(GOOD);
    await addUser(OTHER);
    await addUser(MUTED, { muted: true });
    for (const id of [GOOD, OTHER, MUTED]) await grant(id, 'score:legend', LAST_MONTH);

    const status = await getLegendStatus(GOOD, { pg, now: NOW });
    const { legends } = await getCreatorShowcase({ pg, now: NOW });

    expect(legends).toHaveLength(2);
    expect(status?.oneOf).toBe(legends.length);
    expect(candidateReads()).toBe(1);
    expect(cache.has(REDIS_KEYS.CACHES.CREATOR_SHOWCASE_CANDIDATES)).toBe(true);
  });

  it('gives no count to a Legend the Hall of Fame leaves out', async () => {
    await addUser(GOOD);
    await addUser(MUTED, { muted: true });
    for (const id of [GOOD, MUTED]) await grant(id, 'score:legend', LAST_MONTH);

    expect(await getLegendStatus(GOOD, { pg, now: NOW })).toMatchObject({ oneOf: 1 });
    expect(await getLegendStatus(MUTED, { pg, now: NOW })).toMatchObject({ oneOf: null });
    expect(candidateReads()).toBe(1);
  });

  // A ban, mute, strike or hidden badge must take a creator off the public page on the next view,
  // not when the cached list next refills.
  it.each([
    ['muted', () => q(`UPDATE "User" SET muted = true WHERE id = $1`, [GOOD])],
    ['banned', () => q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [GOOD])],
    [
      'struck',
      () =>
        q(`INSERT INTO "UserStrike" ("userId", status, "expiresAt") VALUES ($1, 'Active', $2)`, [
          GOOD,
          '2027-01-01 00:00:00',
        ]),
    ],
    ['hiding badges', () => setPrivacy(GOOD, { showBadges: false })],
    ['metric-suppressed', async () => void mocks.excluded.mockResolvedValue([GOOD])],
    [
      'leaderboard-excluded',
      () => q(`UPDATE "User" SET "excludeFromLeaderboards" = true WHERE id = $1`, [GOOD]),
    ],
    [
      'opting out',
      () =>
        q(`UPDATE "User" SET settings = '{"hideFromCreatorShowcase": true}' WHERE id = $1`, [GOOD]),
    ],
  ])('drops a Legend newly %s while the candidate list is cached', async (_, change) => {
    await addUser(GOOD);
    await addUser(OTHER);
    for (const id of [GOOD, OTHER]) await grant(id, 'score:legend', LAST_MONTH);
    const before = await getCreatorShowcase({ pg, now: NOW });
    expect(before.legends.map(({ user }) => user.id)).toEqual([GOOD, OTHER]);

    await change();

    const { legends } = await getCreatorShowcase({ pg, now: NOW });
    expect(legends.map(({ user }) => user.id)).toEqual([OTHER]);
    expect(candidateReads()).toBe(1);
  });

  it('drops the count rather than wait while another request fills an empty cache', async () => {
    await addUser(GOOD);
    await grant(GOOD, 'score:legend', LAST_MONTH);
    redisMock.redis.setNxKeepTtlWithEx.mockClear().mockResolvedValue(false);

    expect(await getLegendStatus(GOOD, { pg, now: NOW })).toMatchObject({ oneOf: null });
    expect(redisMock.redis.setNxKeepTtlWithEx).toHaveBeenCalledTimes(1);
  });

  it('keeps a creator whose opt-out is off or never set', async () => {
    await addUser(GOOD);
    await addUser(OTHER);
    await addUser(MUTED);
    for (const id of [GOOD, OTHER, MUTED]) await grant(id, 'score:legend', LAST_MONTH);
    await q(`UPDATE "User" SET settings = '{"hideFromCreatorShowcase": false}' WHERE id = $1`, [
      GOOD,
    ]);
    await q(`UPDATE "User" SET settings = NULL WHERE id = $1`, [OTHER]);

    const { legends } = await getCreatorShowcase({ pg, now: NOW });
    expect(legends.map(({ user }) => user.id)).toEqual([GOOD, MUTED, OTHER]);
  });

  it('moves "this month" at the UTC month boundary while the candidate list is cached', async () => {
    await addUser(GOOD);
    await grant(GOOD, 'score:supernova', '2026-10-31 20:00:00');
    const before = await getCreatorShowcase({ pg, now: new Date('2026-10-31T23:30:00Z') });
    const after = await getCreatorShowcase({ pg, now: new Date('2026-11-01T00:30:00Z') });

    expect(before.newSupernovas.map(({ user }) => user.id)).toEqual([GOOD]);
    expect(after.newSupernovas).toEqual([]);
    expect(candidateReads()).toBe(1);
  });
});
