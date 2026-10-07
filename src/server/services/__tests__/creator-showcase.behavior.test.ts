import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getShowcaseRows } from '~/server/services/creator-showcase.service';

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

const GOOD = 10;
const MUTED = 11;
const DELETED = 12;
const BANNED = 13;
const STRUCK = 14;
const SUPPRESSED = 15;
const EXPIRED_STRIKE = 16;
const SYSTEM = -1;

async function addUser(
  id: number,
  flags: { muted?: boolean; deleted?: boolean; banned?: boolean } = {}
) {
  await q(`INSERT INTO "User" (id, muted, "deletedAt", "bannedAt") VALUES ($1, $2, $3, $4)`, [
    id,
    !!flags.muted,
    flags.deleted ? new Date() : null,
    flags.banned ? new Date() : null,
  ]);
}

/** `silent` mirrors the grant writer: a silent grant stamps seenAt equal to achievedAt. */
const grant = (userId: number, key: string, achievedAt: string, silent = false) =>
  q(
    `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt", "seenAt")
     VALUES ($1, $2, $3::timestamp, CASE WHEN $4::boolean THEN $3::timestamp END)`,
    [userId, key, achievedAt, silent]
  );

const showcase = (excludedUserIds: number[] = []) =>
  getShowcaseRows(pg, { now: NOW, excludedUserIds });
const ids = (rows: { userId: number }[]) => rows.map((row) => row.userId);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
    CREATE TABLE "UserStrike" ("userId" int NOT NULL, status text NOT NULL,
      "expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY, "privacySettings" jsonb);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "UserCreatorMilestone", "UserStrike", "UserProfile", "User";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;`);
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
    await q(
      `INSERT INTO "UserStrike" VALUES ($1, 'Active', '2026-12-01'), ($2, 'Active', '2026-11-01'), ($3, 'Voided', '2026-12-01')`,
      [STRUCK, EXPIRED_STRIKE, GOOD]
    );
    for (const id of [GOOD, MUTED, DELETED, BANNED, STRUCK, SUPPRESSED, EXPIRED_STRIKE, SYSTEM])
      await grant(id, 'score:legend', THIS_MONTH);
  });

  it('lists only Legends in good standing, keeping a voided or expired strike', async () => {
    expect(ids((await showcase([SUPPRESSED])).legends)).toEqual([GOOD, EXPIRED_STRIKE]);
  });

  it('drops the metric-suppressed account only when it is on the list', async () => {
    expect(ids((await showcase([])).legends)).toContain(SUPPRESSED);
  });
});

describe('badge privacy', () => {
  const setPrivacy = (userId: number, settings: Record<string, unknown>) =>
    q(`INSERT INTO "UserProfile" ("userId", "privacySettings") VALUES ($1, $2)`, [
      userId,
      JSON.stringify(settings),
    ]);

  beforeEach(async () => {
    const { rows } = await q(`INSERT INTO "Cosmetic" DEFAULT VALUES RETURNING id`);
    await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = 'score:legend'`, [
      (rows[0] as { id: number }).id,
    ]);
    for (const id of [GOOD, MUTED, STRUCK]) {
      await addUser(id);
      await grant(id, 'score:legend', LAST_MONTH);
    }
  });

  it('leaves out a Legend who hides the Legend badge or all badges, not one hiding another', async () => {
    const [{ cosmeticId }] = (
      await q(`SELECT "cosmeticId" FROM "CreatorMilestone" WHERE key = 'score:legend'`)
    ).rows as { cosmeticId: number }[];
    await setPrivacy(MUTED, { hiddenBadgeIds: [cosmeticId] });
    await setPrivacy(STRUCK, { showBadges: false });
    await setPrivacy(GOOD, { hiddenBadgeIds: [cosmeticId + 1] });
    expect(ids((await showcase()).legends)).toEqual([GOOD]);
  });
});

describe('new Supernovas this month', () => {
  beforeEach(async () => {
    await addUser(GOOD);
    await addUser(MUTED);
    await addUser(STRUCK);
  });

  it('includes a crossing this month, not one last month', async () => {
    await grant(GOOD, 'score:supernova', THIS_MONTH);
    await grant(MUTED, 'score:supernova', LAST_MONTH);
    expect(ids((await showcase()).newSupernovas)).toEqual([GOOD]);
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
