import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Support sees a deposit NOWPayments never confirmed only as a labelled claim, and does not see
 * one still waiting for confirmation at all: its owner is whoever the claim named.
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: { getPaymentStatus: vi.fn(async () => null) },
}));

const { investigateCryptoPayments } = await import(
  '~/server/freshdesk-agent/freshdesk-investigation-tools'
);

const row = (paymentId: number, status: string, over: Record<string, unknown> = {}) => ({
  paymentId: BigInt(paymentId),
  status,
  payCurrency: 'btc',
  payAmount: null,
  outcomeAmount: null,
  buzzCredited: null,
  bonusBuzz: null,
  multiplier: null,
  depositFee: null,
  serviceFee: null,
  feeCurrency: null,
  paidFiat: null,
  chain: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

// Answers the deposit query as Postgres would, honouring its status filter.
const stored = [
  row(1, 'finished', { buzzCredited: 9500, depositFee: 0.1, serviceFee: 0.2, paidFiat: 10 }),
  row(2, 'unverified_exhausted', { payAmount: 500 }),
  row(3, 'unverified', { payAmount: 700 }),
];

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockReset().mockImplementation(async (query: Prisma.Sql) => {
    if (!query.sql.includes('"CryptoDeposit"')) return [];
    return query.sql.includes(`status <> 'unverified'`)
      ? stored.filter((d) => d.status !== 'unverified')
      : stored;
  });
});

describe('investigateCryptoPayments: deposits NOWPayments has not confirmed', () => {
  it('labels a deposit NOWPayments never confirmed as a claim not to credit', async () => {
    const report = await investigateCryptoPayments(99);

    expect(report).toContain(
      'Payment #2 [unverified_exhausted] - claimed, not confirmed by NOWPayments: do not credit by hand, escalate'
    );
    expect(report).toContain('Claimed amount: 500');
    const exhausted = report.slice(
      report.indexOf('Payment #2'),
      report.indexOf('Created:', report.indexOf('Payment #2'))
    );
    expect(exhausted).not.toMatch(/Fee|Fiat|Buzz credited/);
  });

  it('leaves out a deposit still waiting for confirmation', async () => {
    const report = await investigateCryptoPayments(99);

    expect(report).toContain('Payment #1 [finished]');
    expect(report).not.toContain('Payment #3');
  });
});
