import { TRPCError } from '@trpc/server';

/**
 * An in-memory Buzz ledger with the service's external-id semantics (civitai-buzz
 * `src/Civitai.Buzz.Api/Program.cs`): external ids are unique; a single write under an id it
 * already holds answers 200 with the EXISTING transaction id and moves nothing; the batch write
 * lists such a leg in `conflicts`; `GET /transactions/{externalId}` returns the transaction
 * without its id, or 404 (null); a refund is filed under `refund-<transactionId>`.
 *
 * Faults model a write whose outcome the caller cannot see: `lose-response` commits and then
 * fails like a client-side timeout, `fail-before-commit` fails the same way having moved nothing.
 */
type Fault = 'lose-response' | 'fail-before-commit';
type Write = {
  externalTransactionId: string;
  amount: number;
  fromAccountId: number;
  toAccountId?: number;
};

export const timeoutError = () =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError');

export const insufficientFunds = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: "you don't have enough funds" });

export function createFakeBuzzLedger() {
  const held = new Map<string, { transactionId: string } & Write>();
  const faults: Fault[] = [];
  let lookupError: Error | null = null;
  let seq = 0;

  const write = (input: Write) => {
    const existing = held.get(input.externalTransactionId);
    if (existing) return existing.transactionId;
    const transactionId = `ledger-tx-${++seq}`;
    held.set(input.externalTransactionId, { ...input, transactionId });
    return transactionId;
  };

  const faulted = <T>(run: () => T): T => {
    const fault = faults.shift();
    if (fault === 'fail-before-commit') throw timeoutError();
    const result = run();
    if (fault === 'lose-response') throw timeoutError();
    return result;
  };

  return {
    /** Every charge the ledger holds (refunds excluded). */
    charges: () => [...held.values()].filter((t) => !t.externalTransactionId.startsWith('refund-')),
    refunds: () => [...held.values()].filter((t) => t.externalTransactionId.startsWith('refund-')),
    queueFault: (fault: Fault) => faults.push(fault),
    failLookups: (error: Error | null = new Error('buzz read failed')) => {
      lookupError = error;
    },

    createBuzzTransaction: async (input: Write) => {
      const transactionId = faulted(() => write(input));
      return {
        transactionId,
        remainingBalance: null,
        externalTransactionId: input.externalTransactionId,
      };
    },
    recoverBuzzTransactionId: async (input: Write) => ({
      transactionId: write(input),
      remainingBalance: null,
      externalTransactionId: input.externalTransactionId,
    }),
    createBuzzTransactionMany: async (inputs: Write[]) =>
      faulted(() => {
        const transactions: string[] = [];
        const conflicts: string[] = [];
        for (const input of inputs) {
          if (held.has(input.externalTransactionId)) conflicts.push(input.externalTransactionId);
          else transactions.push(write(input));
        }
        return { transactions, conflicts };
      }),
    getTransactionByExternalId: async (externalId: string) => {
      if (lookupError) throw lookupError;
      const t = held.get(externalId);
      return t
        ? { amount: t.amount, fromAccountId: t.fromAccountId, toAccountId: t.toAccountId }
        : null;
    },
    refundTransaction: async (transactionId: string) => {
      const original = [...held.values()].find((t) => t.transactionId === transactionId);
      if (!original) throw new Error(`no transaction ${transactionId}`);
      write({ ...original, externalTransactionId: `refund-${transactionId}` });
      return { transactionId: `refund-of-${transactionId}` };
    },
  };
}
