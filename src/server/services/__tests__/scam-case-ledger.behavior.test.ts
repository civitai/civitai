import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { linkScamStrike, voidScamCaseStrikes } from '~/server/services/scam-case-ledger';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Which strikes an overturn voids is decided entirely in SQL, so it runs on real rows.

const holder = { db: null as unknown as PGlite };
const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};
const client = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
    run(strings, ...values).then((r) => r.rows),
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
    run(strings, ...values).then((r) => r.affectedRows ?? 0),
} as unknown as Prisma.TransactionClient;

const T = (minutes: number) => `2026-10-06T12:${String(minutes).padStart(2, '0')}:00Z`;

beforeEach(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "StrikeStatus" AS ENUM ('Active', 'Expired', 'Voided');
    CREATE TYPE "StrikeReason" AS ENUM ('ManualModAction', 'Scam');
    CREATE TABLE "User" (id integer PRIMARY KEY, meta jsonb);
    CREATE TABLE "UserRestriction" (
      id integer PRIMARY KEY, "userId" integer, type text, triggers jsonb, "createdAt" timestamptz,
      status text NOT NULL DEFAULT 'Pending', "updatedAt" timestamptz
    );
    CREATE TABLE "UserStrike" (
      id integer PRIMARY KEY, "userId" integer, reason "StrikeReason", status "StrikeStatus",
      points integer, "createdAt" timestamptz, "expiresAt" timestamptz, "issuedBy" integer,
      "voidedAt" timestamptz, "voidedBy" integer, "voidReason" text
    );
    INSERT INTO "User" VALUES (42, '{"strikeFlaggedForReview": true}'), (43, '{}');
  `);
  dbMock.dbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb(client)
  );
});

const caseRow = (id: number, at: string, strikeIds: number[] = [], userId = 42) =>
  holder.db.query(`INSERT INTO "UserRestriction" VALUES ($1, $2, 'scam', $3::jsonb, $4)`, [
    id,
    userId,
    JSON.stringify(strikeIds.map((strikeId) => ({ dedupeKey: `k${strikeId}`, strikeId }))),
    at,
  ]);
const strike = (
  id: number,
  at: string,
  reason = 'Scam',
  userId = 42,
  issuedBy: number | null = null
) =>
  holder.db.query(
    `INSERT INTO "UserStrike" (id, "userId", reason, status, points, "createdAt", "expiresAt", "issuedBy")
     VALUES ($1, $2, $3, 'Active', 3, $4, '2126-01-01', $5)`,
    [id, userId, reason, at, issuedBy]
  );
const statuses = async () =>
  Object.fromEntries(
    (
      await holder.db.query<{ id: number; status: string }>(`SELECT id, status FROM "UserStrike"`)
    ).rows.map((r) => [r.id, r.status])
  );

describe('voidScamCaseStrikes on real rows', () => {
  it('voids the strike the case names, and clears the review flag', async () => {
    await caseRow(1, T(0), [10]);
    await strike(10, T(1));
    expect(await voidScamCaseStrikes([1], { voidedBy: 7, reason: 'x' }, client)).toEqual([10]);
    expect(await statuses()).toEqual({ 10: 'Voided' });
    const { rows } = await holder.db.query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM "User" WHERE id = 42`
    );
    expect(rows[0].meta.strikeFlaggedForReview).toBe(false);
  });

  it('voids an unlinked Scam strike from this case, but not one from the next case or another reason', async () => {
    await strike(9, '2026-10-06T11:00:00Z'); // before this case
    await caseRow(1, T(0));
    await strike(10, T(1)); // this case's strike, never linked
    await strike(14, T(1), 'Scam', 42, 7); // a moderator's own Scam strike
    await strike(11, T(2), 'ManualModAction');
    await caseRow(2, T(3));
    await strike(12, T(4)); // the next case's strike, never linked
    await caseRow(3, T(5), [13], 43);
    await strike(13, T(6), 'Scam', 43); // another account

    expect(await voidScamCaseStrikes([1], { voidedBy: 7, reason: 'x' }, client)).toEqual([10]);
    expect(await statuses()).toEqual({
      9: 'Active',
      10: 'Voided',
      11: 'Active',
      12: 'Active',
      13: 'Active',
      14: 'Active',
    });
  });

  it('leaves alone a Scam strike another case names', async () => {
    await caseRow(1, T(0));
    await caseRow(2, T(0), [10]);
    await strike(10, T(1));
    expect(await voidScamCaseStrikes([1], { voidedBy: 7, reason: 'x' }, client)).toEqual([]);
  });

  it('keeps the review flag while other active points still justify it', async () => {
    await caseRow(1, T(0), [10]);
    await strike(10, T(1));
    await strike(11, T(2), 'ManualModAction');
    await voidScamCaseStrikes([1], { voidedBy: 7, reason: 'x' }, client);
    const { rows } = await holder.db.query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM "User" WHERE id = 42`
    );
    expect(rows[0].meta.strikeFlaggedForReview).toBe(true);
  });
});

describe('linkScamStrike on real rows', () => {
  const linkedIds = async () =>
    (
      await holder.db.query<{ triggers: { strikeId?: number }[] }>(
        `SELECT triggers FROM "UserRestriction" WHERE id = 1`
      )
    ).rows[0].triggers.map((t) => t.strikeId);

  beforeEach(async () => {
    await holder.db.query(
      `INSERT INTO "UserRestriction" (id, "userId", type, triggers, "createdAt")
       VALUES (1, 42, 'scam', '[{"dedupeKey":"wf-1"}]', $1)`,
      [T(0)]
    );
    await strike(10, T(1));
  });

  it('links the strike to a Pending case and leaves it Active', async () => {
    expect(await linkScamStrike(1, 0, 'wf-1', 10)).toBe(false);
    expect(await linkedIds()).toEqual([10]);
    expect(await statuses()).toEqual({ 10: 'Active' });
  });

  it('voids the strike when the case was overturned before the link landed', async () => {
    await holder.db.query(`UPDATE "UserRestriction" SET status = 'Overturned' WHERE id = 1`);
    expect(await linkScamStrike(1, 0, 'wf-1', 10)).toBe(true);
    expect(await linkedIds()).toEqual([10]);
    expect(await statuses()).toEqual({ 10: 'Voided' });
  });

  it('keeps the strike on a case already upheld', async () => {
    await holder.db.query(`UPDATE "UserRestriction" SET status = 'Upheld' WHERE id = 1`);
    expect(await linkScamStrike(1, 0, 'wf-1', 10)).toBe(false);
    expect(await statuses()).toEqual({ 10: 'Active' });
  });
});
