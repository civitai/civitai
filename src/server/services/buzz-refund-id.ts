/**
 * The external id the Buzz ledger files a transaction's refund under. The ledger chooses it, not
 * this app: every read of "is this transaction refunded" looks it up by this id.
 */
export function refundExternalTransactionId(transactionId: string): string {
  return `refund-${transactionId}`;
}
