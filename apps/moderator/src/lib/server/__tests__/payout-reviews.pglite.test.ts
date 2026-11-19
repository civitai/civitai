import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  dbRead: {},
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { lastSettlementAt, listPayoutReviews } = await import('../payout-reviews');

const SCHEMA = `
CREATE TABLE "User" (id INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE "CreatorProgramPayoutReview" (
  id SERIAL PRIMARY KEY, period TEXT NOT NULL, "userId" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', hold BOOLEAN NOT NULL DEFAULT TRUE,
  signals TEXT[] NOT NULL DEFAULT '{}', "payoutCents" INTEGER NOT NULL DEFAULT 0,
  evidence JSONB NOT NULL DEFAULT '{}', "firstFlaggedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(), evaluations INTEGER NOT NULL DEFAULT 1,
  "decidedAt" TIMESTAMP(3), "decidedBy" TEXT, "decisionNote" TEXT, "askRef" TEXT,
  version INTEGER NOT NULL DEFAULT 1, decisions JSONB NOT NULL DEFAULT '[]'
);
`;

const NOW = new Date('2026-11-19T12:00:00Z');
let db: PGlite;

const review = (userId: number, status: string, decidedAt: string | null, period = '2026-10') =>
  db.query(
    `INSERT INTO "CreatorProgramPayoutReview" (period, "userId", status, "decidedAt")
     VALUES ($1, $2, $3, $4)`,
    [period, userId, status, decidedAt]
  );

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(
    `INSERT INTO "User" (id, username) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')`
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});
afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('listPayoutReviews', () => {
  it('lists only reviews still holding a payout by default', async () => {
    await review(1, 'open', null);
    await review(2, 'escalated', '2026-11-03');
    await review(3, 'withheld', '2026-11-04');
    await review(4, 'cleared', '2026-11-18');

    const { items } = await listPayoutReviews('holding', { now: NOW });

    expect(items.map((r) => [r.userId, r.status]).sort()).toEqual([
      [1, 'open'],
      [2, 'escalated'],
      [3, 'withheld'],
    ]);
    expect(items.find((r) => r.userId === 1)?.username).toBe('a');
  });

  it('lists as unsettled only reviews cleared after the most recent 15th, whatever their period', async () => {
    await review(1, 'cleared', '2026-11-10'); // paid on Nov 15
    await review(2, 'cleared', '2026-11-18');
    await review(3, 'cleared', '2026-11-16', '2026-09');
    await review(4, 'open', null);
    await review(5, 'cleared', '2026-11-15T00:00:00');

    const { items } = await listPayoutReviews('cleared', { now: NOW });

    expect(items.map((r) => r.userId).sort()).toEqual([2, 3]);
  });

  it('never carries payout-account identifiers or unlisted evidence to the page', async () => {
    const evidence = {
      payoutCents: 12345,
      bankable: 99000,
      priorPayoutsCents: [1000, 'x', 2000],
      account: { username: 'a', email: 'creator@example.com', tipaltiPayeeId: 'TIPALTI-777' },
      signals: { payoutJump: { value: 9, limit: 3, counterpartyId: 5, wallet: '0xWALLET' } },
      exchanges: [{ userId: 5, received: 1, sent: 1, email: 'payer@example.com' }],
      topPayers: [{ userId: 5, iban: 'GB00BANK' }],
      manual: { ground: 'fraud', reason: 'chargebacks', bankAccount: '12345678' },
      payoutAccount: { paypal: 'pp@example.com' },
    };
    await db.query(
      `INSERT INTO "CreatorProgramPayoutReview" (period, "userId", evidence) VALUES ('2026-10', 1, $1)`,
      [JSON.stringify(evidence)]
    );

    const { items } = await listPayoutReviews('holding', { now: NOW });

    expect(items[0].evidence).toEqual({
      signals: [{ name: 'payoutJump', value: 9, limit: 3, counterpartyId: 5 }],
      payoutCents: 12345,
      bankable: 99000,
      priorPayoutsCents: [1000, 2000],
      exchangeCount: 1,
      manual: { ground: 'fraud', reason: 'chargebacks' },
    });
    const served = JSON.stringify(items);
    for (const secret of ['example.com', 'TIPALTI-777', '0xWALLET', 'GB00BANK', '12345678'])
      expect(served, secret).not.toContain(secret);
  });
});

describe('lastSettlementAt', () => {
  it.each([
    ['2026-11-19T12:00:00Z', '2026-11-15T00:00:00.000Z'],
    ['2026-11-15T00:00:00Z', '2026-11-15T00:00:00.000Z'],
    ['2026-11-14T23:59:59Z', '2026-10-15T00:00:00.000Z'],
    ['2026-01-03T00:00:00Z', '2025-12-15T00:00:00.000Z'],
  ])('at %s is %s', (now, expected) => {
    expect(lastSettlementAt(new Date(now)).toISOString()).toBe(expected);
  });
});
