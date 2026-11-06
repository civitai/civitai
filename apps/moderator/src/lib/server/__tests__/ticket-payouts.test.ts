import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { payoutsSectionFor } = await import('../tickets/payouts');

const payouts = vi.fn();
const reads = { payouts: (...a: unknown[]) => payouts(...a) } as never;

const payout = (n: number, over: Record<string, unknown> = {}) => ({
  key: `buzz:${n}`,
  kind: 'buzz',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  status: 'Paid',
  requested: 5000,
  transferred: 4500,
  provider: 'Tipalti',
  note: null,
  ...over,
});

beforeEach(() => {
  payouts.mockReset().mockResolvedValue({ items: [payout(1)], truncated: false });
});

describe('payoutsSectionFor', () => {
  it('lists the withdrawal timeline with status, requested, transferred and provider name', async () => {
    payouts.mockResolvedValue({
      items: [
        payout(1),
        payout(2, {
          key: 'cash:2',
          kind: 'cash',
          status: 'Pending',
          requested: 1200,
          transferred: null,
        }),
        payout(3, { createdAt: null }),
      ],
      truncated: false,
    });
    const res = await payoutsSectionFor({ userId: 7 }, reads);
    expect(payouts).toHaveBeenCalledWith(7, 10);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      truncated: false,
      payouts: [
        {
          id: 'buzz:1',
          kind: 'buzz',
          at: '2026-10-01T00:00:00.000Z',
          status: 'Paid',
          requested: 5000,
          transferred: 4500,
          provider: 'Tipalti',
        },
        {
          id: 'cash:2',
          kind: 'cash',
          at: '2026-10-01T00:00:00.000Z',
          status: 'Pending',
          requested: 1200,
          transferred: null,
          provider: 'Tipalti',
        },
        {
          id: 'buzz:3',
          kind: 'buzz',
          at: null,
          status: 'Paid',
          requested: 5000,
          transferred: 4500,
          provider: 'Tipalti',
        },
      ],
    });
  });

  it('never carries bank or account details, a note, or a contact, whatever the row holds', async () => {
    payouts.mockResolvedValue({
      items: [
        payout(1, {
          note: 'IBAN DE89370400440532013000',
          bankAccount: 'BANK-ACCT-123',
          accountNumber: 'ACCT-NO-456',
          routingNumber: 'ROUTE-789',
          providerAccountId: 'tipalti-payee-42',
          payeeId: 'payee-42',
          email: 'owner@example.com',
          address: '1 Secret Street',
          requestedToProvider: 'Tipalti',
        }),
      ],
      truncated: false,
    });
    const json = JSON.stringify(await payoutsSectionFor({ userId: 7 }, reads));
    for (const leak of [
      'IBAN',
      'BANK-ACCT-123',
      'ACCT-NO-456',
      'ROUTE-789',
      'tipalti-payee-42',
      'payee-42',
      'owner@example.com',
      'Secret Street',
    ]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain('Tipalti');
  });

  it('says when the list was cut', async () => {
    payouts.mockResolvedValue({ items: [payout(1)], truncated: true });
    expect(await payoutsSectionFor({ userId: 7 }, reads)).toMatchObject({ truncated: true });
  });
});
