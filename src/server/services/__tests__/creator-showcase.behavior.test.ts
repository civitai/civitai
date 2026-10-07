import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import { getShowcaseRows, newSupernovaCutoff } from '~/server/services/creator-showcase.service';

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
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const NOW = new Date('2026-11-15T12:00:00Z');
const THIS_MONTH = '2026-11-02 08:00:00';
const LAST_MONTH = '2026-10-20 08:00:00';
const { launchedAt } = creatorMilestoneRegistry['score:legend'];
const AT_LAUNCH = launchedAt.toISOString().replace('T', ' ').replace('Z', '');

const GOOD = 10;
const MUTED = 11;
const DELETED = 12;
const BANNED = 13;
const STRUCK = 14;
const SUPPRESSED = 15;
const EXPIRED_STRIKE = 16;
const SYSTEM = -1;

async function addUser(id: number, flags: { muted?: boolean; deleted?: boolean; banned?: boolean } = {}) {
  await q(`INSERT INTO "User" (id, muted, "deletedAt", "bannedAt") VALUES ($1, $2, $3, $4)`, [
    id,
    !!flags.muted,
    flags.deleted ? new Date() : null,
    flags.banned ? new Date() : null,
  ]);
}

const grant = (userId: number, key: string, achievedAt: string) =>
  q(
    `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt") VALUES ($1, $2, $3::timestamp)`,
    [userId, key, achievedAt]
  );

const rows = async (excludedUserIds: number[] = []) =>
  (await getShowcaseRows(pg, { now: NOW, excludedUserIds })).map(
    (row) => `${row.userId}:${row.milestoneKey}`
  );

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
    CREATE TABLE "UserStrike" ("userId" int NOT NULL, status text NOT NULL, "expiresAt" timestamp(3) NOT NULL);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "UserCreatorMilestone", "UserStrike", "User";`);
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
    await addUser(SYSTEM);
    await q(`INSERT INTO "UserStrike" VALUES ($1, 'Active', '2026-12-01'), ($2, 'Active', '2026-11-01')`, [
      STRUCK,
      EXPIRED_STRIKE,
    ]);
    await q(`INSERT INTO "UserStrike" VALUES ($1, 'Voided', '2026-12-01')`, [GOOD]);
    for (const id of [GOOD, MUTED, DELETED, BANNED, STRUCK, SUPPRESSED, EXPIRED_STRIKE, SYSTEM])
      await grant(id, 'score:legend', THIS_MONTH);
  });

  it('lists only Legends in good standing, keeping a voided or expired strike', async () => {
    expect(await rows([SUPPRESSED])).toEqual([
      `${GOOD}:score:legend`,
      `${EXPIRED_STRIKE}:score:legend`,
    ]);
  });

  it('drops the metric-suppressed account only when it is on the list', async () => {
    expect(await rows([])).toContain(`${SUPPRESSED}:score:legend`);
  });
});

describe('new Supernovas this month', () => {
  beforeEach(async () => {
    await addUser(GOOD);
    await addUser(MUTED);
    await addUser(DELETED);
  });

  it('includes this month, not last month', async () => {
    await grant(GOOD, 'score:supernova', THIS_MONTH);
    await grant(MUTED, 'score:supernova', LAST_MONTH);
    expect(await rows()).toEqual([`${GOOD}:score:supernova`]);
  });

  // Every Supernova was granted silently on launch night; none of them crossed that month.
  it('leaves out Supernovas backfilled before the tier launched', async () => {
    const launchMonthNow = new Date(launchedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(newSupernovaCutoff(launchMonthNow)).toEqual(launchedAt);
    await grant(GOOD, 'score:supernova', AT_LAUNCH);
    await grant(DELETED, 'score:supernova', '2026-10-05 23:00:00');
    const result = await getShowcaseRows(pg, { now: launchMonthNow, excludedUserIds: [] });
    expect(result.map((row) => row.userId)).toEqual([GOOD]);
  });
});

describe('newSupernovaCutoff', () => {
  it('is the start of the UTC month once the launch is in the past', () => {
    expect(newSupernovaCutoff(NOW)).toEqual(new Date('2026-11-01T00:00:00Z'));
  });
});
