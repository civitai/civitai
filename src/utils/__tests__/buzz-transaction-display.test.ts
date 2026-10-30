import { describe, expect, it } from 'vitest';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  GENERATION_TIP_FILTER,
  filterTransactionsByDisplayType,
  getServerTransactionType,
  getTransactionBadgeLabel,
} from '~/utils/buzz-transaction-display';

const tip = {
  type: TransactionType.Compensation,
  externalTransactionId: 'generation-tip-2026-10-13-7-yellow',
};
const compensation = {
  type: TransactionType.Compensation,
  externalTransactionId: 'creator-tip-comp-2026-10-13-7-yellow',
};
const userTip = { type: TransactionType.Tip, externalTransactionId: 'generation-tip-x' };
const rows = [tip, compensation, userTip];

describe('transaction display type', () => {
  it('labels generation tips "Tip" and leaves other compensation alone', () => {
    expect(getTransactionBadgeLabel(tip)).toBe('Tip');
    expect(getTransactionBadgeLabel(compensation)).toBe('Compensation');
    expect(getTransactionBadgeLabel({ type: TransactionType.Compensation })).toBe('Compensation');
  });

  it('only treats Compensation rows as generation tips', () => {
    expect(getTransactionBadgeLabel(userTip)).toBe('Tip');
    expect(filterTransactionsByDisplayType(rows, GENERATION_TIP_FILTER)).toEqual([tip]);
  });

  it('Compensation filter hides tips, tip filter shows only tips, no filter shows all', () => {
    expect(filterTransactionsByDisplayType(rows, 'Compensation')).toEqual([compensation, userTip]);
    expect(filterTransactionsByDisplayType(rows, GENERATION_TIP_FILTER)).toEqual([tip]);
    expect(filterTransactionsByDisplayType(rows, null)).toEqual(rows);
  });

  it('queries the stored Compensation type for the tip filter', () => {
    expect(getServerTransactionType(GENERATION_TIP_FILTER)).toBe(TransactionType.Compensation);
    expect(getServerTransactionType('Refund')).toBe(TransactionType.Refund);
    expect(getServerTransactionType(null)).toBeUndefined();
  });
});
