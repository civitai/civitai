import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';

/**
 * An in-memory Buzz ledger with the service's external-id semantics (civitai-buzz
 * `src/Civitai.Buzz.Api/Program.cs`): external ids are unique; a single write under an id it
 * already holds answers 200 with the EXISTING transaction id and moves nothing; the batch write
 * lists such a leg in `conflicts`; `GET /transactions/{externalId}` returns the transaction
 * without its id, or 404 (null); a refund is filed under `refund-<transactionId>`.
 *
 * Faults model a write whose outcome the caller cannot see: `lose-response` commits and then
 * fails like a client-side timeout, `fail-before-commit` fails the same way having moved nothing,
 * `hang` waits until `releaseHung()` and then commits and answers. Each queued fault applies to the
 * next write of any kind, a resend included.
 *
 * Balances (`setBalance`, unlimited by default) model where each path checks funds:
 * - `createBuzzTransaction` is the APP's wrapper: it refuses a short balance before sending
 *   anything, even for an id the ledger already holds;
 * - a resend (`resendBuzzTransaction`) has no pre-check: the ledger answers a held id with its
 *   transaction whatever the balance, and a short balance with a null id;
 * - the multi-transaction endpoint checks the TOTAL balance before it looks at ids, a 400 even for
 *   a held prefix (Program.cs, POST /multi-transactions);
 * - the batch drops a short leg from both lists unless its id is held (a conflict).
 */
type Fault = 'lose-response' | 'fail-before-commit' | 'hang';
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
  const balances = new Map<number, number>();
  const faults: Fault[] = [];
  let lookupError: Error | null = null;
  let seq = 0;
  let releaseHung: () => void = () => undefined;

  const balanceOf = (userId: number) => balances.get(userId) ?? Infinity;
  const write = (input: Write) => {
    const existing = held.get(input.externalTransactionId);
    if (existing) return existing.transactionId;
    const transactionId = `ledger-tx-${++seq}`;
    held.set(input.externalTransactionId, { ...input, transactionId });
    if (!input.externalTransactionId.startsWith('refund-'))
      balances.set(input.fromAccountId, balanceOf(input.fromAccountId) - input.amount);
    else balances.set(input.fromAccountId, balanceOf(input.fromAccountId) + input.amount);
    return transactionId;
  };

  const faulted = async <T>(run: () => T): Promise<T> => {
    const fault = faults.shift();
    if (fault === 'fail-before-commit') throw timeoutError();
    if (fault === 'hang') await new Promise<void>((resolve) => (releaseHung = resolve));
    const result = run();
    if (fault === 'lose-response') throw timeoutError();
    return result;
  };

  return {
    /** Every charge the ledger holds (refunds excluded). */
    charges: () => [...held.values()].filter((t) => !t.externalTransactionId.startsWith('refund-')),
    refunds: () => [...held.values()].filter((t) => t.externalTransactionId.startsWith('refund-')),
    queueFault: (fault: Fault) => faults.push(fault),
    /** Drops faults a request did not reach, so they cannot fall on the next request. */
    clearFaults: () => {
      faults.length = 0;
    },
    failLookups: (error: Error | null = new Error('buzz read failed')) => {
      lookupError = error;
    },
    setBalance: (userId: number, balance: number) => balances.set(userId, balance),
    balanceOf,
    /** Lets a `hang` write commit and answer. */
    releaseHung: () => releaseHung(),

    createBuzzTransaction: async (input: Write) => {
      if (balanceOf(input.fromAccountId) < input.amount) throw insufficientFunds();
      const transactionId = await faulted(() => write(input));
      return {
        transactionId,
        remainingBalance: null,
        externalTransactionId: input.externalTransactionId,
      };
    },
    resendBuzzTransaction: async (input: Write) => {
      const transactionId = await faulted(() =>
        held.has(input.externalTransactionId) || balanceOf(input.fromAccountId) >= input.amount
          ? write(input)
          : null
      );
      return {
        transactionId,
        remainingBalance: null,
        externalTransactionId: input.externalTransactionId,
      };
    },
    createBuzzTransactionMany: async (inputs: Write[]) =>
      faulted(() => {
        const transactions: string[] = [];
        const conflicts: string[] = [];
        for (const input of inputs) {
          if (held.has(input.externalTransactionId)) conflicts.push(input.externalTransactionId);
          else if (balanceOf(input.fromAccountId) >= input.amount) transactions.push(write(input));
        }
        return { transactions, conflicts };
      }),
    // One leg per call (one source account), filed under `<prefix>-0`; an occupied id is answered
    // 200 with the leg marked `duplicate`, as POST /multi-transactions does.
    createMultiAccountBuzzTransaction: async (input: {
      externalTransactionIdPrefix: string;
      amount: number;
      fromAccountId: number;
      toAccountId: number;
    }) =>
      faulted(() => {
        if (balanceOf(input.fromAccountId) < input.amount)
          throw new BuzzApiError(
            400,
            'Bad Request',
            'Insufficient balance across all account types'
          );
        const externalTransactionId = `${input.externalTransactionIdPrefix}-0`;
        const duplicate = held.has(externalTransactionId);
        const transactionId = write({ ...input, externalTransactionId });
        return {
          transactionIds: [
            { transactionId, accountType: 'yellow', amount: input.amount, duplicate },
          ],
          transactionCount: 1,
          totalAmount: input.amount,
        };
      }),
    refundMultiAccountTransaction: async ({
      externalTransactionIdPrefix,
    }: {
      externalTransactionIdPrefix: string;
    }) => {
      for (const t of [...held.values()])
        if (t.externalTransactionId.startsWith(externalTransactionIdPrefix))
          write({ ...t, externalTransactionId: `refund-${t.transactionId}` });
      return {};
    },
    getMultiAccountTransactionsByPrefix: async (prefix: string) => {
      if (lookupError) throw lookupError;
      return [...held.values()].filter(
        (t) =>
          t.externalTransactionId.startsWith(prefix) &&
          !t.externalTransactionId.startsWith('refund-')
      );
    },
    getPrefixRefundState: async (prefix: string) => {
      if (lookupError) throw lookupError;
      const legs = [...held.values()].filter(
        (t) =>
          t.externalTransactionId.startsWith(prefix) &&
          !t.externalTransactionId.startsWith('refund-')
      );
      const reversed = legs.filter((t) => held.has(`refund-${t.transactionId}`));
      return { reversed, missing: legs.filter((t) => !reversed.includes(t)) };
    },
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
