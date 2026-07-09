// Typed query-string params for the buzz service reads. Callers pass these structured objects;
// the client serializes them (account types → buzz-API values, `Date`s → the format each endpoint
// expects, arrays → repeated keys, nullish/empty dropped). Account-type fields take the app's
// *friendly* types (see ./account-types).
import type { BuzzAccountType } from './account-types';

export type TransactionsWindow = 'hour' | 'day' | 'week' | 'month';
export type AccountSummaryWindow = TransactionsWindow | 'year';

/** `getAccountTransactions` — the account (id/type) is a path param; these filter the result set. */
export type GetAccountTransactionsQuery = {
  type?: number;
  cursor?: Date;
  start?: Date | null;
  end?: Date | null;
  limit?: number;
  descending?: boolean;
};

/** `getUserTransactionsReport` — `start`/`end` are serialized date-only (YYYY-MM-DD). */
export type GetTransactionsReportQuery = {
  accountType?: BuzzAccountType;
  window?: TransactionsWindow;
  start?: Date;
  end?: Date;
};

export type GetAccountBalancesQuery = {
  accountId: number[];
  accountType: BuzzAccountType[];
};

/** `getAccountSummary` — `start`/`end` are serialized date-only (YYYY-MM-DD). */
export type GetAccountSummaryQuery = {
  accountId: number[];
  start?: Date;
  end?: Date;
  window?: AccountSummaryWindow;
  descending?: boolean;
};

export type GetContributorsQuery = {
  accountId: number[];
  start?: Date;
  end?: Date;
  limit?: number;
  all?: boolean;
};

/** `getCounterparties` — the account (id/type) is a path param; these identify the counterparty. */
export type GetCounterpartiesQuery = {
  accountId: number;
  accountType?: BuzzAccountType;
};

export type PreviewMultiTransactionQuery = {
  fromAccountId: number;
  amount: number;
  fromAccountTypes: BuzzAccountType[];
};

export type ListMultiTransactionsQuery = {
  externalTransactionIdPrefix: string;
};
