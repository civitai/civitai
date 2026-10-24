import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The strike review queue, its badge and its actions' subject check share one predicate. Seeded with
 * one account per way to be OUT of the queue, so a predicate missing any clause lists an extra account.
 */

const { dbHandle, setBanned, setMuted, voidStrike, banConfirmed } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  setBanned: vi.fn(),
  setMuted: vi.fn(),
  voidStrike: vi.fn(),
  banConfirmed: vi.fn(),
}));

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
vi.mock('$lib/server/user-actions.service', () => ({
  setBanned,
  setMuted,
  voidStrike,
  banConfirmed,
}));

const { countStrikeReview, getStrikeReviewQueue, isInStrikeReview } = await import(
  '../strike-review.service'
);
const { actions } = await import('../../../routes/users/strike-review/+page.server');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  HERE,
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20261031120000_user_strike_review_idx/migration.sql'
);

const SCHEMA = `
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT,
  "meta" JSONB,
  "muted" BOOLEAN NOT NULL DEFAULT FALSE,
  "mutedAt" TIMESTAMP(3),
  "muteExpiresAt" TIMESTAMP(3),
  "bannedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);
CREATE TABLE "UserStrike" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Active',
  "points" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL DEFAULT 'd',
  "internalNotes" TEXT,
  "entityType" TEXT,
  "entityId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT now() + interval '30 days',
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "issuedBy" INTEGER
);
`;

const flagged = (at: string) =>
  JSON.stringify({ strikeFlaggedForReview: true, strikeFlaggedAt: at });

// Queued: 1 (flagged second), 2 (flagged first). Every other row is out for exactly one reason.
const USERS: [number, string, string | null, boolean, string | null, string | null][] = [
  // id, username, meta, muted, bannedAt, deletedAt
  [1, 'second', flagged('2026-10-14T05:00:00.000Z'), true, null, null],
  [2, 'first', flagged('2026-10-14T00:20:00.000Z'), true, null, null],
  [3, 'unmuted', flagged('2026-10-13T00:00:00.000Z'), false, null, null],
  [4, 'banned', flagged('2026-10-13T00:00:00.000Z'), true, '2026-10-15', null],
  [5, 'deleted', flagged('2026-10-13T00:00:00.000Z'), true, null, '2026-10-15'],
  [6, 'cleared', JSON.stringify({ strikeFlaggedForReview: false }), true, null, null],
  [7, 'never', null, true, null, null],
];

let db: PGlite;

beforeEach(async () => {
  vi.resetAllMocks();
  db = await freshPglite();
  await db.exec(SCHEMA);
  for (const [id, username, meta, muted, bannedAt, deletedAt] of USERS)
    await db.query(
      `INSERT INTO "User" ("id", "username", "meta", "muted", "bannedAt", "deletedAt") VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, username, meta, muted, bannedAt, deletedAt]
    );
  await db.query(`INSERT INTO "User" ("id", "username") VALUES (99, 'issuer')`);
  await db.exec(`
    INSERT INTO "UserStrike" ("id", "userId", "reason", "points", "issuedBy", "entityType", "entityId", "createdAt") VALUES
      (10, 1, 'ManualModAction', 2, 99, 'Image', 555, now() - interval '2 days'),
      (11, 1, 'ManualModAction', 1, NULL, NULL, NULL, now() - interval '1 day');
    INSERT INTO "UserStrike" ("id", "userId", "reason", "points", "status", "voidedAt", "voidReason") VALUES
      (12, 1, 'ManualModAction', 5, 'Voided', now(), 'mistake');
    INSERT INTO "UserStrike" ("id", "userId", "reason", "points", "expiresAt") VALUES
      (13, 1, 'ManualModAction', 4, now() - interval '1 day');
    INSERT INTO "UserStrike" ("id", "userId", "reason", "points") VALUES
      (20, 2, 'ManualModAction', 3),
      (30, 3, 'ManualModAction', 3);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('strike review queue', () => {
  it('lists only flagged, muted, unbanned, undeleted accounts, oldest flag first', async () => {
    const { rows, total } = await getStrikeReviewQueue();

    expect(rows.map((r) => r.userId)).toEqual([2, 1]);
    expect(total).toBe(2);
    expect(await countStrikeReview()).toBe(2);
  });

  it('counts only active, unexpired, unvoided points and attaches every strike', async () => {
    const { rows } = await getStrikeReviewQueue();
    const second = rows.find((r) => r.userId === 1)!;

    expect(second.activePoints).toBe(3);
    expect(second.strikes.map((s) => s.id)).toEqual([13, 12, 11, 10]);
    expect(second.strikes.find((s) => s.id === 10)).toMatchObject({
      issuedByName: 'issuer',
      entityType: 'Image',
      entityId: 555,
    });
    expect(second.strikes.find((s) => s.id === 12)?.voidReason).toBe('mistake');
    expect(rows.find((r) => r.userId === 2)?.strikes.map((s) => s.id)).toEqual([20]);
  });

  it.each([1, 2])('treats queued account %i as in the queue', async (id) => {
    expect(await isInStrikeReview(id)).toBe(true);
  });

  it.each([3, 4, 5, 6, 7, 404])('treats account %i as out of the queue', async (id) => {
    expect(await isInStrikeReview(id)).toBe(false);
  });

  it('plans the badge count on the migration’s partial index', async () => {
    const sql = readFileSync(MIGRATION, 'utf8').replace(/CONCURRENTLY /g, '');
    await db.exec(sql);
    const queries: { sql: string; parameters: readonly unknown[] }[] = [];
    dbHandle.current = new Kysely({
      dialect: pgliteDialect(db),
      log: (event) => {
        queries.push(event.query);
      },
    });
    await countStrikeReview();
    await db.exec('SET enable_seqscan = off');

    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ${queries[0].sql}`,
      queries[0].parameters as unknown[]
    );
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('User_strikeReview_idx');
  });
});

const formData = (fields: Record<string, string | number>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return form;
};
// The slice of the event the actions read.
const event = (fields: Record<string, string | number>, grants: Record<string, boolean> = {}) =>
  ({
    request: { formData: async () => formData(fields) },
    locals: { user: { id: 42 }, grants },
  } as never);

const banFields = { reasonCode: 'SpamBot', detailsInternal: 'note' };

describe('strike review actions', () => {
  it('bans a queued account and confirms the ban landed', async () => {
    setBanned.mockResolvedValue({ ok: true });
    banConfirmed.mockResolvedValue(true);

    const result = await actions.ban(
      event({ ...banFields, userId: 1 }, { 'audit.ban.execute': true })
    );

    expect(result).toEqual({ success: true });
    expect(setBanned).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, ban: true, moderatorId: 42 })
    );
  });

  it('refuses to ban an account that is not in the queue', async () => {
    const result = await actions.ban(
      event({ ...banFields, userId: 3 }, { 'audit.ban.execute': true })
    );

    expect(result).toMatchObject({ status: 409 });
    expect(setBanned).not.toHaveBeenCalled();
  });

  it('refuses to ban without audit.ban.execute', async () => {
    const result = await actions.ban(event({ ...banFields, userId: 1 }));

    expect(result).toMatchObject({ status: 403 });
    expect(setBanned).not.toHaveBeenCalled();
  });

  it('unmutes a queued account through the main app', async () => {
    setMuted.mockResolvedValue({ ok: true });

    expect(await actions.unmute(event({ userId: 2 }))).toEqual({ success: true });
    expect(setMuted).toHaveBeenCalledWith({ userId: 2, muted: false, moderatorId: 42 });
  });

  const flagOf = async (id: number) =>
    (
      await db.query<{ flag: string | null }>(
        `SELECT meta->>'strikeFlaggedForReview' AS flag FROM "User" WHERE id = $1`,
        [id]
      )
    ).rows[0].flag;

  it('clears the review flag once the unmute has landed, so a later mute does not requeue it', async () => {
    setMuted.mockImplementation(async ({ userId }: { userId: number }) => {
      await db.query(`UPDATE "User" SET muted = false WHERE id = $1`, [userId]);
      return { ok: true };
    });

    expect(await actions.unmute(event({ userId: 2 }))).toEqual({ success: true });
    expect(await flagOf(2)).toBe('false');

    await db.query(`UPDATE "User" SET muted = true WHERE id = 2`);
    expect(await isInStrikeReview(2)).toBe(false);
  });

  it('keeps the flag when the unmute reported success but the account is still muted', async () => {
    setMuted.mockResolvedValue({ ok: true });

    await actions.unmute(event({ userId: 2 }));

    expect(await flagOf(2)).toBe('true');
  });

  it('refuses to unmute an account that is not in the queue', async () => {
    expect(await actions.unmute(event({ userId: 6 }))).toMatchObject({ status: 409 });
    expect(setMuted).not.toHaveBeenCalled();
  });

  it('voids an active strike on a queued account, attributed to its owner', async () => {
    voidStrike.mockResolvedValue({ ok: true });

    const result = await actions.voidStrike(event({ strikeId: 20, voidReason: ' wrong user ' }));

    expect(result).toEqual({ success: true });
    expect(voidStrike).toHaveBeenCalledWith({
      strikeId: 20,
      voidReason: 'wrong user',
      userId: 2,
      moderatorId: 42,
    });
  });

  it.each([
    ['a voided strike', 12],
    ['a strike on an account out of the queue', 30],
    ['a strike that does not exist', 404],
  ])('refuses to void %s', async (_label, strikeId) => {
    const result = await actions.voidStrike(event({ strikeId, voidReason: 'r' }));

    expect(result).toMatchObject({ status: 409 });
    expect(voidStrike).not.toHaveBeenCalled();
  });

  it('refuses a void without a reason', async () => {
    const result = await actions.voidStrike(event({ strikeId: 20, voidReason: '   ' }));

    expect(result).toMatchObject({ status: 400 });
    expect(voidStrike).not.toHaveBeenCalled();
  });
});
