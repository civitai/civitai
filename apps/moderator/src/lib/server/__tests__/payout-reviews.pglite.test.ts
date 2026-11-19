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
CREATE TABLE "User" (
  id INTEGER PRIMARY KEY, username TEXT, "bannedAt" TIMESTAMP(3), onboarding INTEGER NOT NULL DEFAULT 0
);
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

const review = (
  userId: number,
  status: string,
  decidedAt: string | null,
  period = '2026-10',
  hold = status !== 'cleared'
) =>
  db.query(
    `INSERT INTO "CreatorProgramPayoutReview" (period, "userId", status, "decidedAt", hold)
     VALUES ($1, $2, $3, $4, $5)`,
    [period, userId, status, decidedAt, hold]
  );

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(
    `INSERT INTO "User" (id, username) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f'), (7, 'g'), (8, 'h')`
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
      payoutCents: 4321,
      bankable: 99000,
      priorPayoutsCents: [1000, 'x', 2000],
      account: { username: 'a', email: 'creator@example.com', tipaltiPayeeId: 'TIPALTI-777' },
      signals: { payoutJump: { value: 9, limit: 3, counterpartyId: 5, wallet: '0xWALLET' } },
      exchanges: [{ userId: 5, received: 1, sent: 1, email: 'payer@example.com' }],
      topPayers: [{ userId: 5, iban: 'GB00BANK' }],
      manual: { ground: 'fraud', reason: 'chargebacks', bankAccount: 'ACCT-BANK-SECRET' },
      payoutAccount: { paypal: 'pp@example.com' },
    };
    await db.query(
      `INSERT INTO "CreatorProgramPayoutReview" (period, "userId", evidence) VALUES ('2026-10', 1, $1)`,
      [JSON.stringify(evidence)]
    );

    const { items } = await listPayoutReviews('holding', { now: NOW });

    expect(items[0].evidence).toEqual({
      signals: [{ name: 'payoutJump', value: 9, limit: 3, counterpartyId: 5 }],
      payoutCents: 4321,
      bankable: 99000,
      priorPayoutsCents: [1000, 2000],
      exchangeCount: 1,
      manual: { ground: 'fraud', reason: 'chargebacks' },
    });
    const served = JSON.stringify(items);
    for (const secret of ['example.com', 'TIPALTI-777', '0xWALLET', 'GB00BANK', 'ACCT-BANK-SECRET'])
      expect(served, secret).not.toContain(secret);
  });
});

describe('what settlement does with each row (resolveHolds in hold.ts)', () => {
  const pick = (items: Awaited<ReturnType<typeof listPayoutReviews>>['items']) =>
    items
      .map((r) => [r.userId, r.period, r.holdsPayout, r.supersededBy, r.decidable])
      .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));

  beforeEach(async () => {
    // 1: an old withhold a later clear superseded. 2: withheld twice.
    // 3: open but not holding. 4: an old held review blocks a newer clear.
    await review(1, 'withheld', '2026-10-05', '2026-09');
    await review(1, 'cleared', '2026-11-18');
    await review(2, 'withheld', '2026-10-05', '2026-09');
    await review(2, 'withheld', '2026-11-05');
    await review(3, 'open', null, '2026-10', false);
    await review(4, 'open', null, '2026-09');
    await review(4, 'cleared', '2026-11-18');
  });

  it('marks only rows settlement holds on, and leaves superseded withholds read-only', async () => {
    const { items } = await listPayoutReviews('holding', { now: NOW });

    expect(pick(items)).toEqual([
      [1, '2026-09', false, '2026-10', false],
      [2, '2026-09', false, '2026-10', false],
      [2, '2026-10', true, null, true],
      [3, '2026-10', false, null, true],
      [4, '2026-09', true, '2026-10', true],
    ]);
  });

  it('lists as unsettled only latest clears that nothing else holds', async () => {
    await review(5, 'cleared', '2026-11-16', '2026-09');
    await review(5, 'cleared', '2026-11-18');

    const { items } = await listPayoutReviews('cleared', { now: NOW });

    expect(pick(items)).toEqual([
      [1, '2026-10', false, null, true],
      [5, '2026-10', false, null, true],
    ]);
  });

  it('lists a creator released by a recent clear of an older review, on their latest review', async () => {
    // The 2026-09 escalation held them at the last settlement; clearing it now releases them.
    await review(6, 'cleared', '2026-11-18', '2026-09');
    await review(6, 'cleared', '2026-11-10');

    const { items } = await listPayoutReviews('cleared', { now: NOW });

    expect(pick(items).filter((r) => r[0] === 6)).toEqual([[6, '2026-10', false, null, true]]);
  });

  it('leaves out banned and program-banned creators, as settlement does', async () => {
    await db.exec(`UPDATE "User" SET "bannedAt" = '2026-11-01' WHERE id = 7`);
    await db.exec(`UPDATE "User" SET onboarding = 32 + 1 WHERE id = 8`);
    await db.exec(`UPDATE "User" SET onboarding = 1 WHERE id = 1`);
    await review(7, 'cleared', '2026-11-18');
    await review(8, 'cleared', '2026-11-18');

    const { items } = await listPayoutReviews('cleared', { now: NOW });

    expect(items.map((r) => r.userId).sort()).toEqual([1]);
  });
});

describe('the page limit', () => {
  it('cuts the holding list at the limit and says more match', async () => {
    await review(1, 'open', null);
    await review(2, 'escalated', '2026-11-03');
    await review(3, 'withheld', '2026-11-04');

    const cut = await listPayoutReviews('holding', { now: NOW, limit: 2 });
    const whole = await listPayoutReviews('holding', { now: NOW, limit: 3 });

    expect([cut.items.length, cut.hasMore]).toEqual([2, true]);
    expect([whole.items.length, whole.hasMore]).toEqual([3, false]);
  });

  it('fills the cleared list from payable creators only, however many are filtered out', async () => {
    // 7 is banned and 8 held by an older review: neither may use up a slot.
    await db.exec(`UPDATE "User" SET "bannedAt" = '2026-11-01' WHERE id = 7`);
    await review(7, 'cleared', '2026-11-19T10:00:00');
    await review(8, 'open', null, '2026-09');
    await review(8, 'cleared', '2026-11-19T11:00:00');
    await review(1, 'cleared', '2026-11-18');
    await review(4, 'cleared', '2026-11-17');

    const fits = await listPayoutReviews('cleared', { now: NOW, limit: 2 });
    await review(5, 'cleared', '2026-11-16');
    const cut = await listPayoutReviews('cleared', { now: NOW, limit: 2 });

    expect([fits.items.map((r) => r.userId), fits.hasMore]).toEqual([[1, 4], false]);
    expect([cut.items.map((r) => r.userId), cut.hasMore]).toEqual([[1, 4], true]);
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
