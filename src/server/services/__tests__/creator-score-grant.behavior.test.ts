import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUserScoreUpdates } from '~/server/jobs/update-user-score';
import { syncStaffAwarded } from '~/server/services/creator-score-grant.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the grant's score sync and the nightly job's score statement unmodified against the real
 * creator_score_grant migration on an in-process Postgres. The job never fetches `staffAwarded`, so
 * these pin that it carries the stored value into every total it rewrites.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261023120000_creator_score_grant/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const tx = {
  $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
    (await holder.db.query(sql, params)).rows,
} as never;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const CREATOR = 10;
const MODERATOR = 20;

async function scores(userId: number) {
  const [row] = await q<{ scores: Record<string, number> }>(
    `SELECT meta->'scores' AS scores FROM "User" WHERE id = $1`,
    [userId]
  );
  return row.scores;
}

async function addGrant(amount: number, revoked = false) {
  await q(
    `INSERT INTO "CreatorScoreGrant" ("userId", amount, reason, "grantedById", "revokedAt")
     VALUES ($1, $2, 'test', $3, $4)`,
    [CREATOR, amount, MODERATOR, revoked ? new Date() : null]
  );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb)`);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "CreatorScoreGrant"; DELETE FROM "User";`);
  await q(`INSERT INTO "User" (id, meta) VALUES ($1, $2), ($3, NULL)`, [
    CREATOR,
    { scores: { models: 1000, images: 200, total: 1200 } },
    MODERATOR,
  ]);
});

describe('syncStaffAwarded', () => {
  it('writes the sum of unrevoked grants and adds it to the total', async () => {
    await addGrant(300);
    await addGrant(50);
    await addGrant(9999, true);

    const transition = await syncStaffAwarded(tx, CREATOR);

    expect(await scores(CREATOR)).toEqual({
      models: 1000,
      images: 200,
      staffAwarded: 350,
      total: 1550,
    });
    expect(transition).toEqual({ userId: CREATOR, oldTotal: 1200, newTotal: 1550 });
  });

  it('drops a revoked grant from the total on the next sync', async () => {
    await addGrant(300);
    await syncStaffAwarded(tx, CREATOR);
    await q(`UPDATE "CreatorScoreGrant" SET "revokedAt" = now()`);

    const transition = await syncStaffAwarded(tx, CREATOR);

    expect(await scores(CREATOR)).toMatchObject({ staffAwarded: 0, total: 1200 });
    expect(transition).toEqual({ userId: CREATOR, oldTotal: 1500, newTotal: 1200 });
  });

  it('is absolute: syncing twice does not count a grant twice', async () => {
    await addGrant(300);
    await syncStaffAwarded(tx, CREATOR);
    await syncStaffAwarded(tx, CREATOR);
    expect(await scores(CREATOR)).toMatchObject({ staffAwarded: 300, total: 1500 });
  });
});

describe('the nightly score statement', () => {
  it('keeps a staff award in the total when it rescores another category', async () => {
    await addGrant(300);
    await syncStaffAwarded(tx, CREATOR);

    const [transition] = await applyUserScoreUpdates(pg, [[String(CREATOR), { models: 1100 }]]);

    expect(await scores(CREATOR)).toEqual({
      models: 1100,
      images: 200,
      staffAwarded: 300,
      total: 1600,
    });
    expect(transition).toEqual({ userId: CREATOR, oldTotal: 1500, newTotal: 1600 });
  });
});
