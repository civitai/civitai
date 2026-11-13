// Compile-time contract, checked by `pnpm run typecheck` (this is not a test file, so the main
// typecheck covers it). It holds no runtime code and nothing imports it.
//
// A buzz write without an external id cannot be looked up after a lost response, so there is no
// safe way to tell "it landed" from "it did not". The type makes that a compile error rather than
// a convention: these lines fail to build if `externalTransactionId` ever becomes optional again.
import type { BuzzClient, BuzzTransactionInput } from './client';

type Assert<T extends true> = T;
type RequiresExternalId<T> = { fromAccountId: number; amount: number } extends T ? false : true;

export type ContractCreateTransactionNeedsExternalId = Assert<
  RequiresExternalId<Parameters<BuzzClient['createTransaction']>[0]>
>;
export type ContractCreateTransactionsNeedsExternalId = Assert<
  RequiresExternalId<Parameters<BuzzClient['createTransactions']>[0][number]>
>;
export type ContractInputNeedsExternalId = Assert<RequiresExternalId<BuzzTransactionInput>>;
