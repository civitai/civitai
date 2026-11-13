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
  /**
   * The response body of a 4xx: parsed JSON, or the raw text when it is not JSON, or undefined
   * when there was none or it could not be read. A 409 on a refund, for one, carries the refunds
   * that already exist, which is the only way a caller can tell which legs are still owed.
   * Never read for a 5xx. Not part of the message, so existing callers see no change.
   *
   * NON-ENUMERABLE on purpose: errors are logged and returned with `JSON.stringify`, which
   * would otherwise copy the service's ledger data into every such log line and response.
   */
  declare body: unknown;
  constructor(status: number, statusText: string, body?: unknown) {
    super(`[@civitai/buzz] request failed: ${status} ${statusText}`);
    this.name = 'BuzzApiError';
    this.status = status;
    this.statusText = statusText;
    Object.defineProperty(this, 'body', { value: body, enumerable: false });
  }
}

/** Never throws: a body that cannot be read is reported as absent, not as a new error. */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

export type BuzzLogFn = (message: string, ...args: unknown[]) => void;

/** Default bound on a read (GET). A per-call `timeoutMs` overrides it. */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;
/** Default bound on a single-transaction write. A per-call `timeoutMs` overrides it. */
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
/** Default bound on the batch write, which carries up to hundreds of transactions in one body. */
export const DEFAULT_BATCH_WRITE_TIMEOUT_MS = 60_000;
/** Reads retry once: a second GET is harmless, a fourth against a struggling service is load. */
export const DEFAULT_READ_RETRIES = 1;
/** Writes retry only failures `isSafeToRetry` accepts, so a budget of 3 costs milliseconds. */
export const DEFAULT_WRITE_RETRIES = 3;

/**
 * Off-switch for the default deadlines above (not for the write retry rule, which is a correctness
 * fix, not a tuning knob). `BUZZ_CLIENT_UNBOUNDED=true` restores the old unbounded waits for every
 * call that does not pass its own `timeoutMs`. Read per request, so it needs no client rebuild.
 */
function defaultDeadlinesDisabled() {
  return process.env.BUZZ_CLIENT_UNBOUNDED === 'true';
}

export type CreateBuzzClientOptions = Partial<BuzzConfig> & {
  /** Default request timeout for single-transaction writes (default `DEFAULT_WRITE_TIMEOUT_MS`). */
  transactionTimeoutMs?: number;
  /** Default request timeout for reads (default `DEFAULT_READ_TIMEOUT_MS`). */
  readTimeoutMs?: number;
  /**
   * Retry budget for every call, reads and writes alike. Absent, reads get
   * `DEFAULT_READ_RETRIES` and writes `DEFAULT_WRITE_RETRIES`. Which failures are retried is not
   * changed by this: a write is only ever retried when `isSafeToRetry` says it never left.
   */
  retries?: number;
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: BuzzLogFn;
  /** Map a BuzzApiError to the consumer's own error before it's thrown (e.g. tRPC/HTTP).
   *  Return (or throw) the error to raise; applied once, after retries are exhausted. */
  mapError?: (error: BuzzApiError) => unknown;
};

export type BuzzAccountResponse = { id: number; balance: number; lifetimeBalance: number };

/**
 * A transaction payload in the app's *friendly* account types; the client maps it to the API.
 *
 * `externalTransactionId` is REQUIRED. It is the only handle on a write whose response was lost:
 * with it a caller can look the transaction up (`getTransactionByExternalId`) and can resend under
 * the same id rather than a new one. Derive it from the business event (the payment intent, the
 * form submission, the job item), never mint it per attempt, or a retry is a second transaction.
 * The client refuses a blank one before anything is sent.
 */
export type BuzzTransactionInput = {
  fromAccountType?: BuzzAccountType;
  toAccountType?: BuzzAccountType;
  externalTransactionId: string;
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

/**
 * Per-call overrides for a write.
 *
 * `timeoutMs` defaults to the client's write bound. A caller that holds a lock while it waits
 * needs "this request is no longer in flight" to become true at some point; without a timeout
 * there is no such point, and no lock TTL can be sized against it. A write that times out has an
 * UNKNOWN outcome: the server may still commit it. Resolve it by external id, never by resending
 * under a fresh one.
 */
export type BuzzWriteOptions = {
  timeoutMs?: number;
  /** Per-call retry override. `0` disables the client's internal retry entirely. */
  retries?: number;
  /**
   * Which failures are worth retrying. See `isSafeToRetry`.
   *
   * A client-side abort does not cancel the server side, so retrying a
   * *timeout* on a non-idempotent write puts a second request on the wire while
   * the first may still be executing — with the same external id. A retry is
   * right for connection-refused, where you know nothing happened; it is wrong
   * for a timeout, where the outcome is unknown by definition.
   *
   * Disabling retries altogether would throw away the safe half: a rolling
   * restart refuses connections for a few seconds, and absorbing that here costs
   * milliseconds where a caller's own retry loop is usually far coarser.
   *
   * Absent, writes use `isSafeToRetry`. It used to be "retry everything", which re-sent a write
   * the server had already committed whenever the response was a 5xx or never arrived.
   */
  shouldRetry?: (error: unknown) => boolean;
};

/**
 * Per-call overrides for a read. Separate from `BuzzWriteOptions` rather than a widening
 * of it: a GET is idempotent, so the retry rule (`isRetryableRead`) is the client's to decide.
 */
export type BuzzReadOptions = {
  timeoutMs?: number;
  /** Per-call retry override. `0` sends the request once and rethrows. */
  retries?: number;
};

/** Body for `refundTransaction`. */
export type BuzzRefundTransactionInput = {
  description?: string;
  details?: Record<string, unknown> | null;
};

function safePredicate(predicate: (error: unknown) => boolean, error: unknown) {
  try {
    return predicate(error) === true;
  } catch {
    return false;
  }
}

async function withRetries<T>(
  fn: () => Promise<T>,
  retries: number,
  shouldRetry?: (error: unknown) => boolean
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // `request` always passes a predicate (by method); absent here means "retry
    // everything" and is reachable only by a direct call. A predicate that is inconclusive — returns a non-true value, or
    // throws — must NOT retry: for a non-idempotent write, "I don't know" has to
    // mean "don't send it again", and a throwing predicate would otherwise also
    // replace the real failure with its own.
    const retryable = shouldRetry ? safePredicate(shouldRetry, error) : true;
    if (retries > 0 && retryable) return withRetries(fn, retries - 1, shouldRetry);
    throw error;
  }
}

/**
 * Failures where the request provably never reached the server.
 *
 * An **allowlist**, deliberately. The rule is *may the server have run this?* —
 * and a denylist of known-unsafe errors gets that backwards: every 5xx, every
 * hang-up, and anything added later is retried by default. A 504 in particular
 * means the *gateway* gave up, which says nothing about whether the write landed;
 * retrying it sends a second identical write.
 *
 * Node's `fetch` reports a failure to connect as a `TypeError` carrying the
 * syscall code. Those are the only cases where "nothing happened" is knowable.
 */
export const isSafeToRetry = (error: unknown) => {
  const code = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return (
    error instanceof TypeError &&
    (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN')
  );
};

/**
 * Which failed READS are worth one more attempt: anything but a timeout and a 4xx. A timeout means
 * the service is not answering, and a second wait of the same length only doubles the caller's;
 * a 4xx will be refused the same way again.
 */
export const isRetryableRead = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  if (error instanceof BuzzApiError && error.status >= 400 && error.status < 500) return false;
  return true;
};

function assertExternalId(transaction: { externalTransactionId?: unknown }) {
  const id = transaction.externalTransactionId;
  if (typeof id !== 'string' || id.trim() === '')
    throw new Error('[@civitai/buzz] a transaction needs a non-blank externalTransactionId');
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
  const {
    retries,
    log,
    mapError,
    transactionTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    ...envOverrides
  } = options;

  function endpoint(): string {
    const value = envOverrides.endpoint ?? loadBuzzEnv().endpoint;
    if (!value) throw new Error('[@civitai/buzz] Missing BUZZ_ENDPOINT');
    return value;
  }

  /** Low-level request. Returns parsed JSON; on a non-2xx status throws (mapped via
   *  `mapError` when provided, else `BuzzApiError`). With `opts.allow404`, a 404 resolves to
   *  `null` instead of throwing. Defaults follow the method: a GET/HEAD is a read (read bound,
   *  `isRetryableRead`), anything else a write (write bound, `isSafeToRetry`). */
  async function request<T = unknown>(
    urlPart: string,
    init?: RequestInit,
    opts?: {
      allow404?: boolean;
      timeoutMs?: number;
      retries?: number;
      shouldRetry?: (error: unknown) => boolean;
    }
  ): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const timeoutMs =
      opts?.timeoutMs ??
      (defaultDeadlinesDisabled() ? undefined : isRead ? readTimeoutMs : transactionTimeoutMs);
    const budget =
      opts?.retries ?? retries ?? (isRead ? DEFAULT_READ_RETRIES : DEFAULT_WRITE_RETRIES);
    const shouldRetry = opts?.shouldRetry ?? (isRead ? isRetryableRead : isSafeToRetry);
    try {
      return await withRetries(
        async () => {
          const url = `${endpoint()}${urlPart}`;
          // A fresh signal per attempt: the bound is per request, not shared across retries.
          const response = await fetch(url, {
            ...init,
            ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
          });
          if (!response.ok) {
            if (opts?.allow404 && response.status === 404) return null as T;
            log?.('request failed', {
              url,
              status: response.status,
              statusText: response.statusText,
            });
            const body =
              response.status >= 400 && response.status < 500
                ? await readErrorBody(response)
                : undefined;
            throw new BuzzApiError(response.status, response.statusText, body);
          }
          return (await response.json()) as T;
        },
        budget,
        shouldRetry
      );
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

  function post(urlPart: string, body: unknown, opts?: BuzzWriteOptions) {
    return request(
      urlPart,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) },
      { timeoutMs: opts?.timeoutMs, retries: opts?.retries, shouldRetry: opts?.shouldRetry }
    );
  }

  // ---- Account reads -------------------------------------------------------
  const getAccount = (accountId: number, opts?: BuzzReadOptions) =>
    request<BuzzAccountResponse>(`/account/${accountId}`, undefined, opts);

  const getUserBuzzByAccountType = (
    accountId: number,
    accountType: BuzzAccountType,
    opts?: BuzzReadOptions
  ) =>
    request<BuzzAccountResponse>(
      `/account/${toApiType(accountType)}/${accountId}`,
      undefined,
      opts
    );

  const getUserAccounts = (
    accountId: number,
    accountTypes: BuzzAccountType[],
    opts?: BuzzReadOptions
  ) =>
    request<Record<string, number>>(
      `/user/${accountId}/accounts?${accountTypes
        .map((t) => `accountType=${toApiType(t)}`)
        .join('&')}`,
      undefined,
      opts
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

  /** `opts` is optional: callers that pass nothing get the client's read defaults. */
  const getTransactionByExternalId = (externalId: string, opts?: BuzzReadOptions) =>
    request<BuzzTransactionResponse | null>(`/transactions/${externalId}`, undefined, {
      allow404: true,
      ...opts,
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

  const listMultiTransactions = (query: ListMultiTransactionsQuery, opts?: BuzzReadOptions) =>
    request<ListMultiTransactionsResponse>(
      withQuery('/multi-transactions', {
        externalTransactionIdPrefix: query.externalTransactionIdPrefix,
      }),
      undefined,
      opts
    );

  // ---- Transaction writes --------------------------------------------------
  // `async` so a blank external id rejects (like every other failure) instead of throwing
  // synchronously out of a call a caller wrapped in `.catch`.
  const createTransaction = async (transaction: BuzzTransactionInput, opts?: BuzzWriteOptions) => {
    assertExternalId(transaction);
    return post(
      '/transaction',
      toApiTransaction(transaction),
      opts
    ) as Promise<CreateTransactionResponse>;
  };

  const createTransactions = async (
    transactions: BuzzTransactionInput[],
    opts?: BuzzWriteOptions
  ) => {
    transactions.forEach(assertExternalId);
    return post(
      '/transactions',
      transactions.map((t) => toApiTransaction(t)),
      {
        ...opts,
        timeoutMs:
          opts?.timeoutMs ??
          (defaultDeadlinesDisabled() ? undefined : DEFAULT_BATCH_WRITE_TIMEOUT_MS),
      }
    ) as Promise<CreateTransactionsResponse>;
  };

  const createMultiTransaction = (input: BuzzMultiTransactionInput, opts?: BuzzWriteOptions) =>
    post(
      '/multi-transactions',
      toApiTransaction(input),
      opts
    ) as Promise<CreateMultiTransactionResponse>;

  const refundMultiTransaction = (body: BuzzRefundMultiTransactionInput, opts?: BuzzWriteOptions) =>
    post('/multi-transactions/refund', body, opts) as Promise<RefundMultiTransactionResponse>;

  // Refunds keep the old retry-everything rule, unlike other writes. A missed refund leaves a user
  // charged for something they never got; a duplicate refund attempt is one the service can reject
  // (it answers 409 when a refund for the transaction already exists). So here a retry is the safer
  // side of an unknown outcome, the opposite of a charge.
  const refundTransaction = (transactionId: string, body: BuzzRefundTransactionInput = {}) =>
    post(`/transactions/${transactionId}/refund`, body, {
      shouldRetry: () => true,
    }) as Promise<RefundTransactionResponse>;

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
