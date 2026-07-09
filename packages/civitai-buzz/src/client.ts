// Server-side client for the Civitai buzz service (BUZZ_ENDPOINT). Owns the HTTP transport
// (fetch + retry + status→error) and typed per-endpoint methods. Account-aware methods take
// the app's *friendly* account types and map to the buzz API internally (see ./account-types).
// Domain concerns (balance pre-checks, entity lookups, DB co-writes) stay in the consuming app.
import { loadBuzzEnv, type BuzzConfig } from './env';
import { toApiType, toApiTransaction, type BuzzAccountType } from './account-types';
import type {
  GetAccountTransactionsQuery,
  GetTransactionsReportQuery,
  GetAccountBalancesQuery,
  GetAccountSummaryQuery,
  GetContributorsQuery,
  GetCounterpartiesQuery,
  PreviewMultiTransactionQuery,
  ListMultiTransactionsQuery,
} from './queries';
import type {
  CreateMultiTransactionResponse,
  CreateTransactionResponse,
  CreateTransactionsResponse,
  GetAccountBalancesResponse,
  GetAccountSummaryResponse,
  GetAccountTransactionsResponse,
  GetContributorsResponse,
  GetCounterpartiesResponse,
  GetTransactionsReportResponse,
  ListMultiTransactionsResponse,
  PreviewMultiTransactionResponse,
  RefundMultiTransactionResponse,
  RefundTransactionResponse,
  BuzzTransactionResponse,
} from './responses';

/** Thrown when the buzz service responds with a non-2xx status. The consuming app maps it
 *  to its own error type via `mapError` (below) — the package stays framework-free. */
export class BuzzApiError extends Error {
  status: number;
  statusText: string;
  constructor(status: number, statusText: string) {
    super(`[@civitai/buzz] request failed: ${status} ${statusText}`);
    this.name = 'BuzzApiError';
    this.status = status;
    this.statusText = statusText;
  }
}

export type BuzzLogFn = (message: string, ...args: unknown[]) => void;

export type CreateBuzzClientOptions = Partial<BuzzConfig> & {
  /** Retry attempts on failure (default 3, matching the app's prior behaviour). */
  retries?: number;
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: BuzzLogFn;
  /** Map a BuzzApiError to the consumer's own error before it's thrown (e.g. tRPC/HTTP).
   *  Return (or throw) the error to raise; applied once, after retries are exhausted. */
  mapError?: (error: BuzzApiError) => unknown;
};

export type BuzzAccountResponse = { id: number; balance: number; lifetimeBalance: number };

/** A transaction payload in the app's *friendly* account types; the client maps it to the API. */
export type BuzzTransactionInput = {
  fromAccountType?: BuzzAccountType;
  toAccountType?: BuzzAccountType;
} & Record<string, unknown>;

/** Body for `createMultiTransaction` — friendly account types; the client maps `toAccountType`
 *  to the API on the way out (the `fromAccountTypes` array is sent as-is, matching the service). */
export type BuzzMultiTransactionInput = {
  fromAccountTypes: BuzzAccountType[];
  fromAccountId: number;
  toAccountType?: BuzzAccountType;
  toAccountId: number;
  type?: number;
  amount: number;
  details?: Record<string, unknown> | null;
  externalTransactionIdPrefix: string;
  description?: string | null;
};

/** Body for `refundMultiTransaction`. */
export type BuzzRefundMultiTransactionInput = {
  externalTransactionIdPrefix: string;
  description?: string;
  details?: Record<string, unknown> | null;
};

/** Body for `refundTransaction`. */
export type BuzzRefundTransactionInput = {
  description?: string;
  details?: Record<string, unknown> | null;
};

async function withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) return withRetries(fn, retries - 1);
    throw error;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type QueryPrimitive = string | number | boolean;
type QueryValue = QueryPrimitive | QueryPrimitive[] | null | undefined;

/** Serialize params to a query string: drops `undefined`/`null`/`''`, expands arrays into repeated
 *  keys, and stringifies primitives. Returns `''` when nothing is set (no leading `?`). */
function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null || item === '') continue;
      search.append(key, String(item));
    }
  }
  return search.toString();
}

const withQuery = (path: string, params: Record<string, QueryValue>) => {
  const search = toQueryString(params);
  return search ? `${path}?${search}` : path;
};

const isoDate = (date: Date | null | undefined) => (date ? date.toISOString() : undefined);
/** Date-only (YYYY-MM-DD, UTC) — matches the buzz report/summary endpoints. */
const dateOnly = (date: Date | null | undefined) =>
  date ? date.toISOString().substring(0, 10) : undefined;

export type BuzzClient = ReturnType<typeof createBuzzClient>;

/** Build a buzz-service client. Endpoint defaults to the package env (BUZZ_ENDPOINT),
 *  overridable via options; resolved lazily per-request so a bare import never throws. */
export function createBuzzClient(options: CreateBuzzClientOptions = {}) {
  const { retries = 3, log, mapError, ...envOverrides } = options;

  function endpoint(): string {
    const value = envOverrides.endpoint ?? loadBuzzEnv().endpoint;
    if (!value) throw new Error('[@civitai/buzz] Missing BUZZ_ENDPOINT');
    return value;
  }

  /** Low-level request. Returns parsed JSON; on a non-2xx status throws (mapped via
   *  `mapError` when provided, else `BuzzApiError`). Retries `retries` times first.
   *  With `opts.allow404`, a 404 resolves to `null` instead of throwing. */
  async function request<T = unknown>(
    urlPart: string,
    init?: RequestInit,
    opts?: { allow404?: boolean }
  ): Promise<T> {
    try {
      return await withRetries(async () => {
        const url = `${endpoint()}${urlPart}`;
        const response = await fetch(url, init);
        if (!response.ok) {
          if (opts?.allow404 && response.status === 404) return null as T;
          log?.('request failed', {
            url,
            status: response.status,
            statusText: response.statusText,
          });
          throw new BuzzApiError(response.status, response.statusText);
        }
        return (await response.json()) as T;
      }, retries);
    } catch (error) {
      if (error instanceof BuzzApiError && mapError) throw mapError(error);
      throw error;
    }
  }

  /** Lightweight liveness check against the endpoint root. Never throws — returns
   *  `false` on any error (incl. the `timeoutMs` abort). Bypasses retry/mapError. */
  async function ping(timeoutMs = 1000): Promise<boolean> {
    try {
      const response = await fetch(endpoint(), { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch (error) {
      log?.('ping failed', error);
      return false;
    }
  }

  function post(urlPart: string, body: unknown) {
    return request(urlPart, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  }

  // ---- Account reads -------------------------------------------------------
  const getAccount = (accountId: number) => request<BuzzAccountResponse>(`/account/${accountId}`);

  const getUserBuzzByAccountType = (accountId: number, accountType: BuzzAccountType) =>
    request<BuzzAccountResponse>(`/account/${toApiType(accountType)}/${accountId}`);

  const getUserAccounts = (accountId: number, accountTypes: BuzzAccountType[]) =>
    request<Record<string, number>>(
      `/user/${accountId}/accounts?${accountTypes
        .map((t) => `accountType=${toApiType(t)}`)
        .join('&')}`
    );

  const getAccountTransactions = (
    accountId: number,
    opts: { accountType?: BuzzAccountType; query?: GetAccountTransactionsQuery } = {}
  ) => {
    const q = opts.query ?? {};
    const path = `/account/${
      opts.accountType ? `${toApiType(opts.accountType)}/` : ''
    }${accountId}/transactions`;
    return request<GetAccountTransactionsResponse>(
      withQuery(path, {
        type: q.type,
        cursor: isoDate(q.cursor),
        start: isoDate(q.start),
        end: isoDate(q.end),
        limit: q.limit,
        descending: q.descending,
      })
    );
  };

  const getUserTransactionsReport = (userId: number, query: GetTransactionsReportQuery = {}) =>
    request<GetTransactionsReportResponse>(
      withQuery(`/user/${userId}/transactions/report`, {
        accountType: query.accountType ? toApiType(query.accountType) : undefined,
        window: query.window,
        start: dateOnly(query.start),
        end: dateOnly(query.end),
      })
    );

  const getAccountBalances = (query: GetAccountBalancesQuery) =>
    request<GetAccountBalancesResponse>(
      withQuery('/account-balances', {
        accountId: query.accountId,
        accountType: query.accountType.map((t) => toApiType(t)),
      })
    );

  const getTransactionByExternalId = (externalId: string) =>
    request<BuzzTransactionResponse | null>(`/transactions/${externalId}`, undefined, {
      allow404: true,
    });

  const getAccountSummary = (
    accountType: BuzzAccountType,
    opts: { accountId?: number; query?: GetAccountSummaryQuery } = {}
  ) => {
    const q = opts.query ?? { accountId: [] };
    const path = `/account/${toApiType(accountType)}${
      opts.accountId ? `/${opts.accountId}` : ''
    }/summary`;
    return request<GetAccountSummaryResponse>(
      withQuery(path, {
        descending: q.descending,
        start: dateOnly(q.start),
        end: dateOnly(q.end),
        window: q.window,
        accountId: q.accountId,
      })
    );
  };

  const getContributors = (
    accountType: BuzzAccountType,
    opts: { accountId?: number; query?: GetContributorsQuery } = {}
  ) => {
    const q = opts.query ?? { accountId: [] };
    const path = `/account/${toApiType(accountType)}${
      opts.accountId ? `/${opts.accountId}` : ''
    }/contributors`;
    return request<GetContributorsResponse>(
      withQuery(path, {
        limit: q.limit,
        start: isoDate(q.start),
        end: isoDate(q.end),
        all: q.all,
        accountId: q.accountId,
      })
    );
  };

  // Keeps a response generic on purpose: this endpoint's shape varies by query (a single counterparty
  // vs movements-between-two-accounts), so a caller may assert its own view of the response.
  const getCounterparties = <T = GetCounterpartiesResponse>(
    accountId: number,
    opts: { accountType?: BuzzAccountType; query?: GetCounterpartiesQuery } = {}
  ) => {
    const path = `/account/${
      opts.accountType ? `${toApiType(opts.accountType)}/` : ''
    }${accountId}/counterparties`;
    return request<T>(
      withQuery(path, {
        accountId: opts.query?.accountId,
        accountType: opts.query?.accountType ? toApiType(opts.query.accountType) : undefined,
      })
    );
  };

  const previewMultiTransaction = (query: PreviewMultiTransactionQuery) =>
    request<PreviewMultiTransactionResponse>(
      withQuery('/multi-transactions/preview', {
        fromAccountId: query.fromAccountId,
        amount: query.amount,
        fromAccountTypes: query.fromAccountTypes.map((t) => toApiType(t)),
      })
    );

  const listMultiTransactions = (query: ListMultiTransactionsQuery) =>
    request<ListMultiTransactionsResponse>(
      withQuery('/multi-transactions', {
        externalTransactionIdPrefix: query.externalTransactionIdPrefix,
      })
    );

  // ---- Transaction writes --------------------------------------------------
  const createTransaction = (transaction: BuzzTransactionInput) =>
    post('/transaction', toApiTransaction(transaction)) as Promise<CreateTransactionResponse>;

  const createTransactions = (transactions: BuzzTransactionInput[]) =>
    post(
      '/transactions',
      transactions.map((t) => toApiTransaction(t))
    ) as Promise<CreateTransactionsResponse>;

  const createMultiTransaction = (input: BuzzMultiTransactionInput) =>
    post('/multi-transactions', toApiTransaction(input)) as Promise<CreateMultiTransactionResponse>;

  const refundMultiTransaction = (body: BuzzRefundMultiTransactionInput) =>
    post('/multi-transactions/refund', body) as Promise<RefundMultiTransactionResponse>;

  const refundTransaction = (transactionId: string, body: BuzzRefundTransactionInput = {}) =>
    post(`/transactions/${transactionId}/refund`, body) as Promise<RefundTransactionResponse>;

  return {
    endpoint,
    request,
    ping,
    getTransactionByExternalId,
    getAccount,
    getUserBuzzByAccountType,
    getUserAccounts,
    getAccountTransactions,
    getUserTransactionsReport,
    getAccountBalances,
    getAccountSummary,
    getContributors,
    getCounterparties,
    previewMultiTransaction,
    listMultiTransactions,
    createTransaction,
    createTransactions,
    createMultiTransaction,
    refundMultiTransaction,
    refundTransaction,
  };
}
