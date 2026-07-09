// Wire response types for the buzz service (BUZZ_ENDPOINT) — the shape each endpoint returns
// *before* any consumer-side transformation. Account-type fields are the buzz-API values
// (PascalCase `BuzzApiAccountType`); the consuming app maps/coerces them (e.g. to friendly
// types, `Date`) when it needs a domain view — see the app's buzz zod schemas.
import type { BuzzApiAccountType } from './account-types';

/** A single transaction as returned by the buzz service (`TransactionResponse` record). */
export type BuzzTransactionResponse = {
  date: string;
  type: string;
  fromAccountId: number;
  toAccountId: number;
  fromAccountType: BuzzApiAccountType;
  toAccountType: BuzzApiAccountType;
  amount: number;
  description?: string | null;
  details?: Record<string, unknown> | null;
};

export type GetAccountTransactionsResponse = {
  cursor?: string | null;
  transactions: BuzzTransactionResponse[];
};

export type BuzzTransactionsReportEntry = {
  date: string;
  start: string;
  end: string;
  accounts: { accountType: BuzzApiAccountType; spent: number; gained: number }[];
};

export type GetTransactionsReportResponse = BuzzTransactionsReportEntry[];

export type BuzzAccountBalance = {
  accountId: number;
  accountType: BuzzApiAccountType;
  balance: number;
};

export type GetAccountBalancesResponse = BuzzAccountBalance[];

export type BuzzAccountSummaryRecord = {
  date: string;
  balance: number;
  lifetimeBalance: number;
};

export type GetAccountSummaryResponse = Record<
  string,
  { data: BuzzAccountSummaryRecord[]; cursor: string | null }
>;

export type BuzzContributor = {
  accountType: BuzzApiAccountType;
  accountId: number;
  contributedBalance: number;
};

export type GetContributorsResponse = Record<string, BuzzContributor[]>;

export type GetCounterpartiesResponse = {
  accountType: BuzzApiAccountType;
  accountId: number;
  counterPartyAccountType: BuzzApiAccountType;
  counterPartyAccountId: number;
  inwardsBalance: number;
  outwardsBalance: number;
  totalBalance: number;
};

export type MultiTransactionSummary = {
  transactionId: string;
  externalTransactionId: string;
  accountType: BuzzApiAccountType;
  accountId: number;
  amount: number;
};

export type ListMultiTransactionsResponse = MultiTransactionSummary[];

export type PreviewMultiTransactionResponse = {
  isPossible: boolean;
  totalAvailableBalance: number;
  requestedAmount: number;
  accountCharges: {
    accountType: BuzzApiAccountType;
    availableBalance: number;
    chargeAmount: number;
    remainingBalance: number;
  }[];
  // `remainingAmount` is present on the possible branch; `shortfall` on the
  // insufficient-balance branch — the two are mutually exclusive on the wire.
  remainingAmount?: number;
  shortfall?: number;
  message: string;
};

export type CreateMultiTransactionResponse = {
  transactionIds: {
    transactionId: string;
    accountType: BuzzApiAccountType;
    amount: number;
    duplicate: boolean;
  }[];
  totalAmount: number;
  transactionCount: number;
};

export type RefundMultiTransactionResponse = {
  refundedTransactions: {
    originalTransactionId: string;
    refundTransactionId: string;
    accountType: BuzzApiAccountType;
    amount: number;
    originalExternalTransactionId: string;
  }[];
  totalRefunded: number;
  externalTransactionIdPrefix: string;
};

export type CreateTransactionResponse = {
  transactionId: string | null;
  // fromAccount?.Balance — null when the from-account is not tracked locally (e.g. bank/0).
  remainingBalance: number | null;
};
export type CreateTransactionsResponse = { transactions: string[]; conflicts: string[] };
export type RefundTransactionResponse = { transactionId: string };
