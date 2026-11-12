// Database-unavailable classification, shared by the replica fallback (which must act ONLY on a failure
// to reach the database, never on a query that reached it and failed) and by the app's error mapping
// (which answers those failures with a retryable 503 instead of a 500). One predicate, so the two can
// never disagree about what "the database is unreachable" means.
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

// pg-pool / pg messages for a connection that never came up or died under the client.
const PG_UNREACHABLE_MESSAGES = [
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
];

// Waiting for a pooled connection: Prisma P2024, pg-pool's queue timeout. The database may be
// healthy and the pool merely saturated, so these are "unavailable" (503) but NOT evidence the
// server is unreachable — the replica fallback does not act on them on their own.
const PRISMA_ACQUIRE_TIMEOUT_CODES = new Set(['P2024']);
const PG_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

type Errorish = { code?: unknown; errorCode?: unknown; message?: unknown; cause?: unknown };

// Depth 4 matches `isClientAbortError` in the app: tRPC wraps once, a service layer may wrap again.
function someInChain(e: unknown, test: (cur: Errorish) => boolean): boolean {
  let cur = e as Errorish | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (test(cur)) return true;
    cur = cur.cause as Errorish | undefined;
  }
  return false;
}

// Prisma's known-request errors carry `code`; its initialization errors carry `errorCode`.
const prismaCode = (cur: Errorish) =>
  typeof cur.code === 'string' ? cur.code : typeof cur.errorCode === 'string' ? cur.errorCode : '';

/** The database could not be reached at all (connect refused / timed out / connection dropped). */
export function isDbConnectionError(e: unknown): boolean {
  return someInChain(e, (cur) => {
    const code = prismaCode(cur);
    if (SOCKET_CODES.has(code) || PRISMA_UNREACHABLE_CODES.has(code)) return true;
    const message = typeof cur.message === 'string' ? cur.message : '';
    return PG_UNREACHABLE_MESSAGES.some((m) => message.startsWith(m));
  });
}

/** Waiting for a pooled connection timed out. */
export function isDbAcquireTimeout(e: unknown): boolean {
  return someInChain(e, (cur) => {
    if (PRISMA_ACQUIRE_TIMEOUT_CODES.has(prismaCode(cur))) return true;
    return cur.message === PG_ACQUIRE_TIMEOUT_MESSAGE;
  });
}

/** Unreachable OR no pooled connection in time: a transient condition a client should retry. */
export function isDbUnavailableError(e: unknown): boolean {
  return isDbConnectionError(e) || isDbAcquireTimeout(e);
}
