import { BuzzApiError, isSafeToRetry, type BuzzClient } from '@civitai/buzz';

/** The Buzz transaction type "Reward"; the buzz service takes the numeric value. */
const REWARD_TRANSACTION_TYPE = 5;
const WRITE_TIMEOUT_MS = 15_000;

export type BuzzGrant = {
  userId: number;
  amount: number;
  /** Idempotency key: the buzz service pays one transaction per key. */
  externalTransactionId: string;
  description: string;
};

/** What conversion needs from Buzz; the real client is wired in `runtime.ts`, tests pass a fake. */
export type BuzzPort = {
  /** `transactionId` is null when the key was already paid and the service did not say which transaction. */
  grantYellow(grant: BuzzGrant): Promise<{ transactionId: string | null }>;
};

export function buzzPort(client: Pick<BuzzClient, 'createTransaction'>): BuzzPort {
  return {
    async grantYellow(grant) {
      try {
        const result = await client.createTransaction(
          {
            fromAccountId: 0,
            fromAccountType: 'yellow',
            toAccountId: grant.userId,
            toAccountType: 'yellow',
            amount: grant.amount,
            type: REWARD_TRANSACTION_TYPE,
            description: grant.description,
            externalTransactionId: grant.externalTransactionId,
          },
          // A timeout is not retried: its outcome is unknown, and the caller retries with the same key.
          { timeoutMs: WRITE_TIMEOUT_MS, shouldRetry: isSafeToRetry }
        );
        return { transactionId: result.transactionId };
      } catch (error) {
        // The key was already paid by an earlier try whose answer was lost.
        if (error instanceof BuzzApiError && error.status === 409) return { transactionId: null };
        throw error;
      }
    },
  };
}
