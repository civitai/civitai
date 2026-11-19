import { describe, expect, it } from 'vitest';
import { refundExternalTransactionId } from '~/server/services/buzz-refund-id';

// The Buzz ledger's own format for a refund's external id: a literal, not derived from the helper.
describe('refundExternalTransactionId', () => {
  it("is the ledger's `refund-<transactionId>`", () => {
    expect(refundExternalTransactionId('0f3c9a2e-tx')).toBe('refund-0f3c9a2e-tx');
  });
});
