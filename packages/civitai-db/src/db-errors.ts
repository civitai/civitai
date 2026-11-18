// Database-unavailable classification for the app's error mapping, which answers these failures with a
// retryable 503 instead of a 500. It must recognise ONLY database-originated errors: a 503 skips the
// central error log, so re-coding another dependency's outage (Redis, ClickHouse, S3, an external
// fetch) would make it silent.
//
// What counts as database-originated:
//   - a Prisma error code (P1001/P1002/P1017; P2024 for a pool acquire timeout),
//   - a pg server error of the connection-exception class (SQLSTATE 08xxx) or a shutdown / too many
//     connections (57P01-57P03, 53300), recognised by pg's `severity` field,
//   - pg / pg-pool's own messages for a connection that never came up, died, or was not handed out,
//   - a raw socket error (ECONNREFUSED, …) only when `createPool` marked it as raised while acquiring
//     a database connection (`markDbConnectError`). Unmarked, the same code could be any dependency's.
//
// Duck-typed on purpose: no import of Prisma's runtime or of `pg`, so any package can use it.

// Socket-level failures to reach a host: refused, reset, timed out, unroutable, unresolvable.
const SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

// Prisma: P1001 can't reach the server, P1002 reached it but timed out, P1017 server closed the
// connection.
const PRISMA_UNREACHABLE_CODES = new Set(['P1001', 'P1002', 'P1017']);

// pg server errors that mean "this connection / this server is not usable right now".
const PG_UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

// pg-pool / pg messages for a connection that never came up or died under the client.
const PG_UNREACHABLE_MESSAGES = [
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
];

// Waiting for a pooled connection: Prisma P2024, pg-pool's queue timeout. The database may be
// healthy and the pool merely saturated, but the request still cannot be served now.
const PRISMA_ACQUIRE_TIMEOUT_CODES = new Set(['P2024']);
const PG_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

const DB_CONNECT_ERROR = Symbol.for('civitai.db.connectError');

/** Mark an error raised while acquiring a database connection (see `createPool`). */
export function markDbConnectError<E>(e: E): E {
  if (e && typeof e === 'object') {
    try {
      Object.defineProperty(e, DB_CONNECT_ERROR, { value: true, enumerable: false });
    } catch {
      // A frozen error stays unmarked: it then reads as "not database-originated" (a 500).
    }
  }
  return e;
}

type Errorish = {
  code?: unknown;
  errorCode?: unknown;
  severity?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
  [DB_CONNECT_ERROR]?: boolean;
};

// Depth 4 matches `isClientAbortError` in the app: tRPC wraps once, a service layer may wrap again.
function findInChain(e: unknown, test: (cur: Errorish) => boolean): Errorish | undefined {
  let cur = e as Errorish | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (test(cur)) return cur;
    cur = cur.cause as Errorish | undefined;
  }
  return undefined;
}

// Prisma's known-request errors carry `code`; its initialization errors carry `errorCode`.
const codeOf = (cur: Errorish) =>
  typeof cur.code === 'string' ? cur.code : typeof cur.errorCode === 'string' ? cur.errorCode : '';

function isConnectionLink(cur: Errorish): boolean {
  const code = codeOf(cur);
  if (PRISMA_UNREACHABLE_CODES.has(code)) return true;
  if (
    typeof cur.severity === 'string' &&
    (code.startsWith('08') || PG_UNAVAILABLE_SQLSTATES.has(code))
  )
    return true;
  if (SOCKET_CODES.has(code) && cur[DB_CONNECT_ERROR] === true) return true;
  const message = typeof cur.message === 'string' ? cur.message : '';
  return PG_UNREACHABLE_MESSAGES.some((m) => message.startsWith(m));
}

function isAcquireTimeoutLink(cur: Errorish): boolean {
  return (
    PRISMA_ACQUIRE_TIMEOUT_CODES.has(codeOf(cur)) || cur.message === PG_ACQUIRE_TIMEOUT_MESSAGE
  );
}

/** The database could not be reached at all (connect refused / timed out / connection dropped). */
export function isDbConnectionError(e: unknown): boolean {
  return !!findInChain(e, isConnectionLink);
}

/** Waiting for a pooled connection timed out. */
export function isDbAcquireTimeout(e: unknown): boolean {
  return !!findInChain(e, isAcquireTimeoutLink);
}

/** Unreachable OR no pooled connection in time: a transient condition a client should retry. */
export function isDbUnavailableError(e: unknown): boolean {
  return !!dbUnavailableCause(e);
}

/**
 * The link in the cause chain that makes `e` a database-unavailable error, as `{ name, code }` only —
 * never its message, which can carry a host or a connection string. `undefined` when it is not one.
 */
export function dbUnavailableCause(e: unknown): { name: string; code: string } | undefined {
  const link = findInChain(e, (cur) => isConnectionLink(cur) || isAcquireTimeoutLink(cur));
  if (!link) return undefined;
  return { name: typeof link.name === 'string' ? link.name : 'Error', code: codeOf(link) };
}
