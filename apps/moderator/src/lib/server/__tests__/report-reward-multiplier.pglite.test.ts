import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// The tier lookup the moderator falls back to when the shared cache cannot answer, run as real SQL
// against real subscription rows. Its text is pinned to the main app's userMultipliersCache lookup by
// src/server/redis/__tests__/moderator-user-multipliers.parity.test.ts; this pins what it returns.

const { dbHandle, insert } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  insert: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
// A cold cache for everyone, so every tier comes from Postgres.
vi.mock('../redis', () => ({ getRedis: () => ({ packed: { get: async () => null } }) }));

const { rewardReportReporters } = await import('../rewards');

const SCHEMA = `
CREATE TYPE "RewardsEligibility" AS ENUM ('Eligible', 'Ineligible', 'Protected');
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "rewardsEligibility" "RewardsEligibility" NOT NULL DEFAULT 'Eligible'
);
CREATE TABLE "Product" ("id" TEXT PRIMARY KEY, "metadata" JSONB NOT NULL DEFAULT '{}');
CREATE TABLE "CustomerSubscription" (
  "id" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "productId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "RewardsBonusEvent" (
  "id" SERIAL PRIMARY KEY,
  "multiplier" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3)
);
INSERT INTO "Product" ("id", "metadata") VALUES
  ('gold', '{"rewardsMultiplier": 4}'),
  ('silver', '{"rewardsMultiplier": 2.5}'),
  ('placeholder', '{}');
`;

const FUTURE = `now() + interval '10 days'`;
const PAST = `now() - interval '1 day'`;

/** [userId, eligibility, [productId, status, periodEnd SQL][]] */
const MEMBERS: [number, string, [string, string, string][]][] = [
  [1, 'Eligible', [['gold', 'active', FUTURE]]],
  [2, 'Eligible', [['gold', 'canceled', FUTURE]]],
  [3, 'Eligible', [['gold', 'active', PAST]]],
  [4, 'Eligible', [['silver', 'trialing', FUTURE]]],
  [
    5,
    'Eligible',
    [
      ['placeholder', 'active', FUTURE],
      ['gold', 'active', FUTURE],
    ],
  ],
  [6, 'Ineligible', [['gold', 'active', FUTURE]]],
  [7, 'Eligible', []],
];

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  for (const [userId, eligibility, subs] of MEMBERS) {
    await db.query(`INSERT INTO "User" ("id", "rewardsEligibility") VALUES ($1, $2)`, [
      userId,
      eligibility,
    ]);
    for (const [i, [productId, status, periodEnd]] of subs.entries()) {
      await db.query(
        `INSERT INTO "CustomerSubscription" ("id", "userId", "productId", "status", "currentPeriodEnd")
         VALUES ($1, $2, $3, $4, ${periodEnd})`,
        [`sub-${userId}-${i}`, userId, productId, status]
      );
    }
  }
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  insert.mockReset();
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('rewardReportReporters on a cold cache', () => {
  it("pays each reporter their active membership's multiplier, read from Postgres", async () => {
    await rewardReportReporters({ reportId: 1, reporterIds: MEMBERS.map(([id]) => id) });

    expect(insert).toHaveBeenCalledTimes(1);
    const paid = insert.mock.calls[0][0].values.map(
      (row: { toUserId: number; multiplier: number }) => [row.toUserId, row.multiplier]
    );
    expect(paid).toEqual([
      [1, 4], // active gold
      [2, 1], // canceled: not a member
      [3, 1], // period ended: not a member
      [4, 2.5], // trialing silver
      [5, 4], // a placeholder grant does not hide the paid gold beside it
      [6, 0], // ineligible
      [7, 1], // no subscription
    ]);
  });
});
