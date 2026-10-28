import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { blockLinkReview, clearLinkReview } = await import('../link-review.service');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_knights_payout_block_and_link_review/migration.sql'
);

const MOD = 7;
const SYSTEM = -1;

let db: PGlite;

const insertReview = (id: number, userIds: number[], status: string, autoBlocked = false) =>
  db.query(
    `INSERT INTO "NewOrderLinkReview" ("id", "fingerprint", "userIds", "evidence", "status", "autoBlocked")
     VALUES ($1, $2, $3, '{}', $4, $5)`,
    [id, `fp-${id}`, userIds, status, autoBlocked]
  );

const hold = (userId: number, at: string) =>
  db.query(
    `UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = $2, "payoutBlockReason" = 'held', "payoutBlockedBy" = $3
     WHERE "userId" = $1`,
    [userId, at, SYSTEM]
  );

const player = async (userId: number) =>
  (
    await db.query<{
      payoutBlockedAt: string | null;
      payoutBlockedBy: number | null;
      payoutReleaseFrom: string | null;
    }>(
      `SELECT "payoutBlockedAt"::text, "payoutBlockedBy", "payoutReleaseFrom"::text FROM "NewOrderPlayer" WHERE "userId" = $1`,
      [userId]
    )
  ).rows[0];

const statusOf = async (id: number) =>
  (
    await db.query<{ status: string; reviewedBy: number | null }>(
      `SELECT "status", "reviewedBy" FROM "NewOrderLinkReview" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "NewOrderPlayer" ("userId" INTEGER PRIMARY KEY);`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM "NewOrderLinkReview"; DELETE FROM "NewOrderPlayer";`);
  await db.exec(`INSERT INTO "NewOrderPlayer" ("userId") VALUES (1), (2), (3), (4);`);
});

describe('blockLinkReview', () => {
  it('holds every unheld member and keeps an existing hold untouched', async () => {
    await insertReview(1, [1, 2, 3], 'Pending');
    await hold(3, '2026-03-01 10:00:00');

    expect(await blockLinkReview(1, MOD)).toEqual({ ok: true });

    expect(await statusOf(1)).toEqual({ status: 'Blocked', reviewedBy: MOD });
    expect((await player(1)).payoutBlockedBy).toBe(MOD);
    expect((await player(2)).payoutBlockedAt).not.toBeNull();
    expect(await player(3)).toMatchObject({
      payoutBlockedAt: '2026-03-01 10:00:00',
      payoutBlockedBy: SYSTEM,
    });
    expect((await player(4)).payoutBlockedAt).toBeNull();
  });

  it.each(['Blocked', 'Cleared'])('refuses a review that is already %s', async (status) => {
    await insertReview(1, [1, 2], status);

    const outcome = await blockLinkReview(1, MOD);

    expect(outcome.ok).toBe(false);
    expect((await statusOf(1)).status).toBe(status);
    expect((await player(1)).payoutBlockedAt).toBeNull();
  });

  it('refuses an unknown review', async () => {
    expect((await blockLinkReview(99, MOD)).ok).toBe(false);
  });
});

describe('clearLinkReview', () => {
  it('releases a blocked review and marks the first held day two days before the block day', async () => {
    await insertReview(1, [1, 2], 'Blocked', true);
    await hold(1, '2026-03-10 15:30:00');
    await hold(2, '2026-03-10 15:30:00');

    expect(await clearLinkReview(1, MOD)).toEqual({ ok: true });

    expect(await statusOf(1)).toEqual({ status: 'Cleared', reviewedBy: MOD });
    expect(await player(1)).toEqual({
      payoutBlockedAt: null,
      payoutBlockedBy: null,
      payoutReleaseFrom: '2026-03-08 00:00:00',
    });
  });

  it('keeps the earlier of an existing release marker and the new one', async () => {
    await insertReview(1, [1, 2], 'Blocked');
    await hold(1, '2026-03-10 15:30:00');
    await hold(2, '2026-03-10 15:30:00');
    await db.query(`UPDATE "NewOrderPlayer" SET "payoutReleaseFrom" = $2 WHERE "userId" = $1`, [
      1,
      '2026-03-01 00:00:00',
    ]);
    await db.query(`UPDATE "NewOrderPlayer" SET "payoutReleaseFrom" = $2 WHERE "userId" = $1`, [
      2,
      '2026-03-20 00:00:00',
    ]);

    await clearLinkReview(1, MOD);

    expect((await player(1)).payoutReleaseFrom).toEqual('2026-03-01 00:00:00');
    expect((await player(2)).payoutReleaseFrom).toEqual('2026-03-08 00:00:00');
  });

  it('clears a pending review without touching any hold', async () => {
    await insertReview(1, [1, 2], 'Pending');
    await insertReview(2, [2, 3], 'Blocked');
    await hold(2, '2026-03-10 15:30:00');
    await hold(3, '2026-03-10 15:30:00');

    expect(await clearLinkReview(1, MOD)).toEqual({ ok: true });

    expect((await statusOf(1)).status).toBe('Cleared');
    expect((await player(2)).payoutBlockedAt).not.toBeNull();
    expect((await player(2)).payoutReleaseFrom).toBeNull();
    expect((await player(3)).payoutBlockedAt).not.toBeNull();
  });

  it('keeps the hold of a member who is also in another blocked review', async () => {
    await insertReview(1, [1, 2], 'Blocked');
    await insertReview(2, [2, 3], 'Blocked');
    await hold(1, '2026-03-10 15:30:00');
    await hold(2, '2026-03-10 15:30:00');
    await hold(3, '2026-03-10 15:30:00');

    await clearLinkReview(1, MOD);

    expect((await player(1)).payoutBlockedAt).toBeNull();
    expect((await player(2)).payoutBlockedAt).not.toBeNull();
    expect((await player(2)).payoutReleaseFrom).toBeNull();
    expect((await player(3)).payoutBlockedAt).not.toBeNull();

    await clearLinkReview(2, MOD);

    expect((await player(2)).payoutBlockedAt).toBeNull();
    expect((await player(2)).payoutReleaseFrom).toEqual('2026-03-08 00:00:00');
  });

  it('releases a member whose other review was already cleared', async () => {
    await insertReview(1, [1, 2], 'Blocked');
    await insertReview(2, [2, 3], 'Cleared');
    await hold(2, '2026-03-10 15:30:00');

    await clearLinkReview(1, MOD);

    expect((await player(2)).payoutBlockedAt).toBeNull();
  });

  it('refuses a review that is already cleared', async () => {
    await insertReview(1, [1], 'Cleared');

    expect((await clearLinkReview(1, MOD)).ok).toBe(false);
  });
});
