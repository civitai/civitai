import { describe, expect, it } from 'vitest';
import type { TransactionInfo } from '@civitai/orchestration-client';
import { getRefundSummary } from '~/components/ImageGeneration/refund-summary';

const debit = (amount: number, accountType: TransactionInfo['accountType'] = 'green') =>
  ({ type: 'debit', amount, accountType, id: 'd-uuid' } as TransactionInfo);
const credit = (amount: number, accountType: TransactionInfo['accountType'] = 'green') =>
  ({ type: 'credit', amount, accountType, id: 'c-uuid' } as TransactionInfo);

describe('getRefundSummary', () => {
  it('reports a full refund on a failed workflow (prod shape: debit + credit, uuid ids)', () => {
    const r = getRefundSummary('failed', [debit(108), credit(108)]);
    expect(r).toMatchObject({ state: 'refunded', amount: 108, charged: 108 });
    expect(r?.text).toBe('Refunded 108 Green Buzz');
  });

  it('reports a partial refund', () => {
    const r = getRefundSummary('canceled', [debit(108), credit(54)]);
    expect(r?.state).toBe('partial');
    expect(r?.text).toBe('Refunded 54 of 108 Green Buzz');
  });

  it('claims nothing for a failed workflow with no credit', () => {
    expect(getRefundSummary('failed', [debit(108)])).toBeNull();
    expect(getRefundSummary('expired', [])).toBeNull();
    expect(getRefundSummary('failed', undefined)).toBeNull();
  });

  it('claims nothing for a non-failed workflow even if credits exist', () => {
    expect(getRefundSummary('succeeded', [debit(108), credit(10)])).toBeNull();
    expect(getRefundSummary('processing', [debit(108), credit(108)])).toBeNull();
  });

  it('uses plain Buzz for mixed or yellow accounts', () => {
    expect(getRefundSummary('failed', [debit(10, 'yellow'), credit(10, 'yellow')])?.text).toBe(
      'Refunded 10 Buzz'
    );
    expect(
      getRefundSummary('failed', [debit(10), debit(5, 'blue'), credit(10), credit(5, 'blue')])?.text
    ).toBe('Refunded 15 Buzz');
  });
});
