// Database-unavailable classification for the app's error mapping, which answers these failures with a
// retryable 503 instead of a 500. It must recognise ONLY database-originated errors: a 503 skips the
// central error log, so re-coding another dependency's outage (Redis, ClickHouse, S3, an external
// fetch) would make it silent.
//
// What counts as database-originated:
//   - a Prisma error code (P1001/P1002/P1017; P2024 for a pool acquire timeout),
//   - a pg server error of the connection-exception class (SQLSTATE 08xxx) or a shutdown / too many
//     connections (57P01-57P03, 53300), recognised by pg's `severity` field. 08P01 counts only with
//     one of the pooler's own outage or saturation messages (POOLER_TRANSIENT_08P01_MESSAGE),
//   - a Prisma PrismaClientUnknownRequestError (no code) whose message carries one of those pooler
//     messages or a server shutdown/startup message,
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
const PG_UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03']);

/**
 * PgBouncer's 08P01 messages for a server it cannot use right now, e.g. while the primary switches
 * over. The code alone is not enough: Postgres also raises 08P01 (protocol_violation) for a malformed
 * message from the client ("bind message supplies 1 parameters, but prepared statement requires 2"),
 * a bug, and PgBouncer uses it for permanent refusals ("unsupported startup parameter").
 */
const POOLER_OUTAGE_08P01_MESSAGE =
  /server login has been failing|server conn crashed\?|pgbouncer cannot connect to server/i;
// The same code when the pooler is full rather than the server unreachable: unavailable (503), but
// grouped with the pool-wait timeouts below, which are not retried.
const POOLER_SATURATION_08P01_MESSAGE = /no more connections allowed|query_wait_timeout/i;
/** Every PgBouncer 08P01 message for a server it cannot use right now: outage or saturation. */
export const POOLER_TRANSIENT_08P01_MESSAGE = new RegExp(
  `${POOLER_OUTAGE_08P01_MESSAGE.source}|${POOLER_SATURATION_08P01_MESSAGE.source}`,
  'i'
);

// Prisma reports some server and pooler failures as a PrismaClientUnknownRequestError with no code:
// "Error in connector: Error querying the database: FATAL: server login has been failing, …". The
// error class is Prisma's own, so the message is the database's, not another dependency's.
const PRISMA_UNKNOWN_REQUEST_ERROR = 'PrismaClientUnknownRequestError';
const PRISMA_WRAPPED_OUTAGE_MESSAGE = new RegExp(
  `${POOLER_OUTAGE_08P01_MESSAGE.source}|terminating connection due to administrator command|the database system is (?:starting up|shutting down)`,
  'i'
);

// pg-pool / pg messages for a connection that never came up or died under the client.
const PG_UNREACHABLE_MESSAGES = [
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
];

// Waiting for a pooled connection, or no room for one: Prisma P2024, pg-pool's queue timeout, the
// pooler's saturation messages, Postgres 53300 too_many_connections. The database may be healthy and
// the pool merely saturated, but the request still cannot be served now.
const PRISMA_ACQUIRE_TIMEOUT_CODES = new Set(['P2024']);
const PG_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const PG_TOO_MANY_CONNECTIONS = '53300';
const PRISMA_WRAPPED_SATURATION_MESSAGE = new RegExp(
  `${POOLER_SATURATION_08P01_MESSAGE.source}|sorry, too many clients already`,
  'i'
);

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
  const message = typeof cur.message === 'string' ? cur.message : '';
  if (PRISMA_UNREACHABLE_CODES.has(code)) return true;
  if (typeof cur.severity === 'string') {
    if (code === '08P01') {
      if (POOLER_OUTAGE_08P01_MESSAGE.test(message)) return true;
    } else if (code.startsWith('08') || PG_UNAVAILABLE_SQLSTATES.has(code)) return true;
  }
  if (cur.name === PRISMA_UNKNOWN_REQUEST_ERROR && PRISMA_WRAPPED_OUTAGE_MESSAGE.test(message))
    return true;
  if (SOCKET_CODES.has(code) && cur[DB_CONNECT_ERROR] === true) return true;
  return PG_UNREACHABLE_MESSAGES.some((m) => message.startsWith(m));
}

function isAcquireTimeoutLink(cur: Errorish): boolean {
  const code = codeOf(cur);
  const message = typeof cur.message === 'string' ? cur.message : '';
  if (PRISMA_ACQUIRE_TIMEOUT_CODES.has(code) || message === PG_ACQUIRE_TIMEOUT_MESSAGE) return true;
  if (typeof cur.severity === 'string') {
    if (code === PG_TOO_MANY_CONNECTIONS) return true;
    if (code === '08P01' && POOLER_SATURATION_08P01_MESSAGE.test(message)) return true;
  }
  return (
    cur.name === PRISMA_UNKNOWN_REQUEST_ERROR && PRISMA_WRAPPED_SATURATION_MESSAGE.test(message)
  );
}

/** The database could not be reached at all (connect refused / timed out / connection dropped). */
export function isDbConnectionError(e: unknown): boolean {
  return !!findInChain(e, isConnectionLink);
}

/** No pooled connection in time, or the pool / pooler / server has no room for another one. */
export function isDbAcquireTimeout(e: unknown): boolean {
  return !!findInChain(e, isAcquireTimeoutLink);
}

// During a switchover the pooler can briefly fail its own login to the new primary and pass that on as
// an auth failure, which isDbConnectionError (a connection-loss classifier) does not count.
const PG_INVALID_PASSWORD = '28P01';

// pg's own connect timeout. Each attempt can wait the pool's full connectionTimeoutMillis before this,
// so retrying it would hold the caller far past its own deadline.
const PG_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

/**
 * Whether a single statement that failed with `e` is worth running again after a short wait: the
 * connection was lost or refused (isDbConnectionError), or the pooler failed its own login (a pg
 * 28P01). Not a pg connect timeout, and not a full pool, pooler or server (isDbAcquireTimeout: a
 * pool-wait timeout, the pooler's saturation messages, 53300): retrying only adds load to the pool
 * that is already full.
 *
 * It says nothing about whether running the statement twice is safe; that is the caller's to know.
 */
export function isTransientDbConnectionError(e: unknown): boolean {
  if (
    findInChain(
      e,
      (cur) => typeof cur.message === 'string' && cur.message.startsWith(PG_CONNECT_TIMEOUT_MESSAGE)
    )
  )
    return false;
  if (isDbConnectionError(e)) return true;
  const top = e as Errorish | null | undefined;
  return typeof top?.severity === 'string' && top.code === PG_INVALID_PASSWORD;
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
