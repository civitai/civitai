import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { voidScamCaseStrikes } from '~/server/services/scam-case-ledger';

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
      id integer PRIMARY KEY, "userId" integer, type text, triggers jsonb, "createdAt" timestamptz
    );
    CREATE TABLE "UserStrike" (
      id integer PRIMARY KEY, "userId" integer, reason "StrikeReason", status "StrikeStatus",
      points integer, "createdAt" timestamptz, "expiresAt" timestamptz,
      "voidedAt" timestamptz, "voidedBy" integer, "voidReason" text
    );
    INSERT INTO "User" VALUES (42, '{"strikeFlaggedForReview": true}'), (43, '{}');
  `);
});

const caseRow = (id: number, at: string, strikeIds: number[] = [], userId = 42) =>
  holder.db.query(`INSERT INTO "UserRestriction" VALUES ($1, $2, 'scam', $3::jsonb, $4)`, [
    id,
    userId,
    JSON.stringify(strikeIds.map((strikeId) => ({ dedupeKey: `k${strikeId}`, strikeId }))),
    at,
  ]);
const strike = (id: number, at: string, reason = 'Scam', userId = 42) =>
  holder.db.query(
    `INSERT INTO "UserStrike" (id, "userId", reason, status, points, "createdAt", "expiresAt")
     VALUES ($1, $2, $3, 'Active', 3, $4, '2126-01-01')`,
    [id, userId, reason, at]
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
    await caseRow(1, T(0));
    await strike(10, T(1)); // this case's strike, never linked
    await strike(11, T(2), 'ManualModAction');
    await caseRow(2, T(3));
    await strike(12, T(4)); // the next case's strike, never linked
    await caseRow(3, T(5), [13], 43);
    await strike(13, T(6), 'Scam', 43); // another account

    expect(await voidScamCaseStrikes([1], { voidedBy: 7, reason: 'x' }, client)).toEqual([10]);
    expect(await statuses()).toEqual({ 10: 'Voided', 11: 'Active', 12: 'Active', 13: 'Active' });
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
