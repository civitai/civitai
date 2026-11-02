import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  dbWrite: {},
}));

const { countOpenUnpaidAwards, getUnpaidAwards } = await import('../bounty-unpaid-award.service');

// The columns the queries read.
const SCHEMA = `
CREATE TABLE "User" (id INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE "Bounty" (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, "userId" INTEGER, meta JSONB,
  "payoutWinnerUserId" INTEGER
);
CREATE TABLE "BountyBenefactor" (
  "userId" INTEGER NOT NULL, "bountyId" INTEGER NOT NULL, "unitAmount" INTEGER NOT NULL,
  "buzzTransactionId" TEXT[] NOT NULL DEFAULT '{}', PRIMARY KEY ("bountyId", "userId")
);
CREATE TABLE "BountyUnpaidAward" (
  "bountyId" INTEGER NOT NULL, "userId" INTEGER NOT NULL, "unitAmount" INTEGER NOT NULL,
  "buzzTransactionIds" TEXT[] NOT NULL DEFAULT '{}', "winnerUserId" INTEGER, "ownerId" INTEGER,
  "recordedById" INTEGER, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT now(), ruling TEXT,
  "ledgerReference" TEXT, "resolvedById" INTEGER, "resolvedAt" TIMESTAMP(3),
  PRIMARY KEY ("bountyId", "userId")
);
CREATE TABLE "ModActivity" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL,
  "entityType" TEXT, "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

let db: PGlite;

const award = (bountyId: number, userId: number, extra = '') =>
  db.exec(`INSERT INTO "BountyUnpaidAward" ("bountyId", "userId", "unitAmount", "winnerUserId",
             "ownerId", "recordedById", "recordedAt", ruling, "ledgerReference", "resolvedById",
             "resolvedAt")
           VALUES ${
             extra || `(${bountyId}, ${userId}, 500, 3, 2, 1, '2026-10-30', NULL, NULL, NULL, NULL)`
           }`);

const legacyActivity = (bountyId: number, userId: number, at = '2026-10-29') =>
  db.exec(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
           VALUES (${userId}, 'bountyAwardUnpaid', 'bounty', ${bountyId}, '${at}')`);

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (1, 'mod'), (2, 'owner'), (3, 'winner'), (5, 'supporter');
    INSERT INTO "Bounty" (id, name, "userId", "payoutWinnerUserId") VALUES (10, 'A LoRA', 2, 3);
    INSERT INTO "Bounty" (id, name, "userId", meta) VALUES (11, 'Kept', NULL, '{"userIdBeforeRemoval": 2}');
    INSERT INTO "BountyBenefactor" ("bountyId", "userId", "unitAmount", "buzzTransactionId")
      VALUES (10, 5, 700, '{tx-a,tx-b}'), (11, 5, 300, '{}');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('open unpaid awards', () => {
  it('lists open records only, with names, and a record whose bounty is gone', async () => {
    await award(10, 5);
    await award(0, 0, `(99, 5, 200, NULL, 2, 1, '2026-10-31', NULL, NULL, NULL, NULL)`);
    await award(0, 0, `(10, 3, 100, 3, 2, 1, '2026-10-31', 'paid_winner', 'tx', 1, now())`);

    const { items } = await getUnpaidAwards({ resolved: false, limit: 10 });
    expect(items).toMatchObject([
      {
        bountyId: 10,
        userId: 5,
        bountyName: 'A LoRA',
        supporter: 'supporter',
        winner: 'winner',
        owner: 'owner',
        recordedBy: 'mod',
        legacy: false,
      },
      { bountyId: 99, userId: 5, bountyName: null, winnerUserId: null, legacy: false },
    ]);
    expect(await countOpenUnpaidAwards()).toBe(2);
  });

  it('lists an activity-log-only record once, from its bounty and supporter rows', async () => {
    await legacyActivity(11, 5, '2026-10-29');
    await legacyActivity(11, 5, '2026-10-30');

    const { items } = await getUnpaidAwards({ resolved: false, limit: 10 });
    expect(items).toEqual([
      expect.objectContaining({
        bountyId: 11,
        userId: 5,
        unitAmount: 300,
        buzzTransactionIds: [],
        winnerUserId: null,
        ownerId: 2,
        owner: 'owner',
        legacy: true,
      }),
    ]);
    expect(await countOpenUnpaidAwards()).toBe(1);
  });

  it('leaves out an activity-log record that already has its row, open or resolved', async () => {
    await legacyActivity(10, 5);
    await award(
      0,
      0,
      `(10, 5, 700, 3, 2, NULL, '2026-10-29', 'refunded_supporter', 'r', 1, now())`
    );

    expect((await getUnpaidAwards({ resolved: false, limit: 10 })).items).toEqual([]);
    expect(await countOpenUnpaidAwards()).toBe(0);
  });

  it('leaves out an activity-log record whose supporter row is gone, as the resolve would', async () => {
    await legacyActivity(10, 9);
    expect(await countOpenUnpaidAwards()).toBe(0);
  });

  it('reports more when the list is cut at the limit, oldest first', async () => {
    await award(10, 5);
    await legacyActivity(11, 5, '2026-10-01');
    const page = await getUnpaidAwards({ resolved: false, limit: 1 });
    expect(page.items.map((r) => r.bountyId)).toEqual([11]);
    expect(page.hasMore).toBe(true);
  });
});

describe('resolved unpaid awards', () => {
  it('lists the last 30 days of rulings, newest first, with who ruled', async () => {
    await award(
      0,
      0,
      `(10, 5, 700, 3, 2, 1, '2026-10-01', 'paid_winner', 'ledger 1', 1, now() - interval '1 day')`
    );
    await award(
      0,
      0,
      `(11, 5, 300, NULL, 2, 1, '2026-10-01', 'refunded_supporter', 'ledger 2', 1, now())`
    );
    await award(
      0,
      0,
      `(12, 5, 300, NULL, 2, 1, '2026-08-01', 'no_charge_found', 'old', 1, now() - interval '31 days')`
    );
    await award(13, 5);

    const { items } = await getUnpaidAwards({ resolved: true, limit: 10 });
    expect(items).toMatchObject([
      {
        bountyId: 11,
        ruling: 'refunded_supporter',
        ledgerReference: 'ledger 2',
        resolvedBy: 'mod',
      },
      { bountyId: 10, ruling: 'paid_winner', ledgerReference: 'ledger 1', resolvedBy: 'mod' },
    ]);
  });
});
