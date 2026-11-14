import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  emptyAuthorFeeEarnings,
  getAuthorFeeEarningsForOwner,
} from '~/server/services/blocks/author-fee-earnings.service';

/**
 * The owner's author-fee earnings read, run as the real Prisma queries against Postgres, so the
 * owner scope, the per-app filter and the status buckets are what the database returns rather than
 * what a mock was told to return.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SCHEMA = `
  CREATE TABLE block_author_fee_accrual (
    id text PRIMARY KEY,
    workflow_id text NOT NULL UNIQUE,
    app_id text NOT NULL,
    app_block_id text NOT NULL,
    app_owner_user_id int NOT NULL,
    viewer_user_id int NOT NULL,
    buzz_type text NOT NULL,
    fee_buzz int NOT NULL CHECK (fee_buzz > 0),
    base_generation_buzz int NOT NULL DEFAULT 0,
    flat_leg_buzz int NOT NULL DEFAULT 0,
    pct_leg_buzz int NOT NULL DEFAULT 0,
    governing_leg text NOT NULL DEFAULT 'flat',
    generation_type text,
    status text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'settled')),
    settlement_key text,
    accrued_at timestamptz(6) NOT NULL DEFAULT now(),
    settled_at timestamptz(6)
  );
  CREATE INDEX block_author_fee_accrual_owner_idx
    ON block_author_fee_accrual (app_owner_user_id, accrued_at);
`;

const OWNER = 501;
const OTHER_OWNER = 502;
const VIEWER = 777;
const APP_A = 'apb_alpha';
const APP_B = 'apb_bravo';
/** The clock every no-range read runs at, so the default window does not drift with the calendar. */
const NOW = new Date('2026-11-12T00:00:00Z');

type Row = {
  id: string;
  appBlockId: string;
  owner: number;
  fee: number;
  status: 'accrued' | 'settled';
  buzzType?: string;
  accruedAt: string;
};

// Every fee is a distinct power of two, so any sum names exactly which rows went into it.
const ROWS: Row[] = [
  {
    id: 'a1',
    appBlockId: APP_A,
    owner: OWNER,
    fee: 1,
    status: 'accrued',
    accruedAt: '2026-11-01T01:00:00Z',
  },
  {
    id: 'a2',
    appBlockId: APP_A,
    owner: OWNER,
    fee: 2,
    status: 'settled',
    accruedAt: '2026-11-02T01:00:00Z',
  },
  {
    id: 'a3',
    appBlockId: APP_A,
    owner: OWNER,
    fee: 4,
    status: 'settled',
    buzzType: 'blue',
    accruedAt: '2026-11-03T01:00:00Z',
  },
  {
    id: 'b1',
    appBlockId: APP_B,
    owner: OWNER,
    fee: 8,
    status: 'accrued',
    accruedAt: '2026-11-04T01:00:00Z',
  },
  {
    id: 'b2',
    appBlockId: APP_B,
    owner: OWNER,
    fee: 16,
    status: 'settled',
    accruedAt: '2026-11-05T01:00:00Z',
  },
  // Older than the 90-day default window: a settled fee, and a fee still pending (settlement can
  // leave a row `accrued` indefinitely, e.g. while the author-fee flag is off).
  {
    id: 'o1',
    appBlockId: APP_A,
    owner: OWNER,
    fee: 128,
    status: 'settled',
    accruedAt: '2026-07-01T01:00:00Z',
  },
  {
    id: 'o2',
    appBlockId: APP_A,
    owner: OWNER,
    fee: 256,
    status: 'accrued',
    accruedAt: '2026-06-01T01:00:00Z',
  },
  // Another owner's rows, on one of OWNER's app ids too (an app that changed hands).
  {
    id: 'x1',
    appBlockId: APP_A,
    owner: OTHER_OWNER,
    fee: 32,
    status: 'accrued',
    accruedAt: '2026-11-06T01:00:00Z',
  },
  {
    id: 'x2',
    appBlockId: 'apb_xray',
    owner: OTHER_OWNER,
    fee: 64,
    status: 'settled',
    accruedAt: '2026-11-07T01:00:00Z',
  },
];

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  for (const r of ROWS) {
    await harness.pg.query(
      `INSERT INTO block_author_fee_accrual
         (id, workflow_id, app_id, app_block_id, app_owner_user_id, viewer_user_id, buzz_type,
          fee_buzz, status, settlement_key, accrued_at, settled_at)
       VALUES ($1, $2, 'app_1', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        r.id,
        `wf_${r.id}`,
        r.appBlockId,
        r.owner,
        VIEWER,
        r.buzzType ?? 'yellow',
        r.fee,
        r.status,
        r.status === 'settled' ? `key_${r.id}` : null,
        r.accruedAt,
        r.status === 'settled' ? r.accruedAt : null,
      ]
    );
  }
});
afterAll(() => harness.stop());
beforeEach(() => {
  const real = harness.prisma.blockAuthorFeeAccrual;
  dbMock.dbRead.blockAuthorFeeAccrual.groupBy.mockImplementation((args: never) =>
    real.groupBy(args)
  );
  dbMock.dbRead.blockAuthorFeeAccrual.findMany.mockImplementation((args: never) =>
    real.findMany(args)
  );
});

describe('getAuthorFeeEarningsForOwner', () => {
  it('totals the caller’s rows by status and never includes another owner’s', async () => {
    const result = await getAuthorFeeEarningsForOwner({ ownerUserId: OWNER, now: NOW });

    expect(result.accrued).toEqual({
      count: 3,
      feeBuzz: 1 + 8 + 256,
      byBuzzType: { yellow: 265 },
    });
    expect(result.settled).toEqual({
      count: 3,
      feeBuzz: 2 + 4 + 16,
      byBuzzType: { yellow: 18, blue: 4 },
    });
    expect(result.recent.map((r) => r.id)).toEqual(['b2', 'b1', 'a3', 'a2', 'a1']);
  });

  it('breaks the portfolio down per app, highest total first', async () => {
    const { byApp } = await getAuthorFeeEarningsForOwner({ ownerUserId: OWNER, now: NOW });

    expect(byApp.map((a) => [a.appBlockId, a.accrued.feeBuzz, a.settled.feeBuzz])).toEqual([
      [APP_A, 1 + 256, 6],
      [APP_B, 8, 16],
    ]);
  });

  it('narrows every figure to one app with appBlockId', async () => {
    const result = await getAuthorFeeEarningsForOwner({
      ownerUserId: OWNER,
      appBlockId: APP_A,
      now: NOW,
    });

    expect(result.accrued.feeBuzz).toBe(1 + 256);
    expect(result.settled.feeBuzz).toBe(6);
    expect(result.byApp.map((a) => a.appBlockId)).toEqual([APP_A]);
    expect(result.recent.map((r) => r.id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('gives zeros, not the current holder’s earnings, for an app the caller does not own', async () => {
    const result = await getAuthorFeeEarningsForOwner({
      ownerUserId: OWNER,
      appBlockId: 'apb_xray',
      now: NOW,
    });

    expect(result).toEqual({ ...emptyAuthorFeeEarnings(), paidWindowDays: 90 });
  });

  it('reads the other owner’s rows for that owner (control: the scope is the argument)', async () => {
    const result = await getAuthorFeeEarningsForOwner({ ownerUserId: OTHER_OWNER, now: NOW });

    expect(result.accrued.feeBuzz).toBe(32);
    expect(result.settled.feeBuzz).toBe(64);
  });

  it('applies from/to to the accrual time and caps the recent list', async () => {
    const result = await getAuthorFeeEarningsForOwner({
      ownerUserId: OWNER,
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-04T23:59:59Z'),
      recentLimit: 2,
    });

    expect(result.accrued.feeBuzz).toBe(8);
    expect(result.settled.feeBuzz).toBe(2 + 4);
    expect(result.recent.map((r) => r.id)).toEqual(['b1', 'a3']);
  });
});

describe('getAuthorFeeEarningsForOwner — the default window', () => {
  it('with no range, settled fees older than 90 days are excluded', async () => {
    const result = await getAuthorFeeEarningsForOwner({ ownerUserId: OWNER, now: NOW });

    expect(result.paidWindowDays).toBe(90);
    expect(result.settled.feeBuzz).toBe(2 + 4 + 16);
    expect(result.recent.map((r) => r.id)).not.toContain('o1');
  });

  it('an explicit from older than the window still includes them', async () => {
    const result = await getAuthorFeeEarningsForOwner({
      ownerUserId: OWNER,
      from: new Date('2026-05-01T00:00:00Z'),
      now: NOW,
    });

    expect(result.paidWindowDays).toBeNull();
    expect(result.settled.feeBuzz).toBe(2 + 4 + 16 + 128);
    expect(result.recent.map((r) => r.id)).toContain('o1');
  });

  it('pending fees are never windowed: a 160-day-old accrued fee still counts', async () => {
    const result = await getAuthorFeeEarningsForOwner({
      ownerUserId: OWNER,
      appBlockId: APP_A,
      now: NOW,
    });

    expect(result.paidWindowDays).toBe(90);
    expect(result.accrued).toEqual({ count: 2, feeBuzz: 1 + 256, byBuzzType: { yellow: 257 } });
  });
});
