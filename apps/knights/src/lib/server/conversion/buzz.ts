import { BUZZ_TRANSACTION_TYPE, BuzzApiError, isSafeToRetry, type BuzzClient } from '@civitai/buzz';
import { BUZZ_WRITE_TIMEOUT_MS } from './config';

/** 408 and 429 say "try later", not "no". */
const TRANSIENT_CLIENT_ERRORS = new Set([408, 429]);

export type BuzzGrant = {
  userId: number;
  amount: number;
  /** Idempotency key: the buzz service pays one transaction per key. */
  externalTransactionId: string;
  description: string;
};

/** Buzz definitively refused the grant (a 4xx other than a duplicate key): it was not paid and a retry would be refused again. */
export class BuzzRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Buzz rejected the grant: ${status}`);
    this.name = 'BuzzRejectedError';
  }
}

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
            type: BUZZ_TRANSACTION_TYPE.Reward,
            description: grant.description,
            externalTransactionId: grant.externalTransactionId,
          },
          // A timeout is not retried: its outcome is unknown, and the caller retries with the same key.
          { timeoutMs: BUZZ_WRITE_TIMEOUT_MS, shouldRetry: isSafeToRetry }
        );
        return { transactionId: result.transactionId };
      } catch (error) {
        if (error instanceof BuzzApiError) {
          // The key was already paid by an earlier try whose answer was lost.
          if (error.status === 409) return { transactionId: null };
          if (
            error.status >= 400 &&
            error.status < 500 &&
            !TRANSIENT_CLIENT_ERRORS.has(error.status)
          ) {
            throw new BuzzRejectedError(error.status);
          }
        }
        throw error;
      }
    },
  };
}
