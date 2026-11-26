import { Prisma } from '@prisma/client';
// `pg` re-exports pg-protocol's DatabaseError; import it from `pg` because that
// is the direct dependency — `pg-protocol` is transitive and is NOT hoisted under
// this repo's pnpm layout, so importing it directly fails to resolve.
import { DatabaseError } from 'pg';
import { TRPCError } from '@trpc/server';
import { dbUnavailableCause } from '@civitai/db/db-errors';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { isProd } from '~/env/other';
import { clickhouseFailSoftCounter } from '~/server/prom/client';
import { logToAxiom } from '../logging/client';
import type { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

/**
 * True when an error is a CLIENT-side request abort — the browser closed the tab,
 * scrolled the infinite feed past the in-flight page, or navigated away, cancelling
 * the request's AbortSignal mid-fetch. These surface as a bare `AbortError`
 * (DOMException) that, untreated, bubbles to a 500 even though the server did
 * nothing wrong and there is no client left to receive a response.
 *
 * Walks the `.cause` chain because tRPC wraps the thrown error as
 * `TRPCError{ cause }` and the Meili layer may wrap once more. A server-side
 * `AbortSignal.timeout()` deadline is not matched: its name is `TimeoutError` and
 * its message carries a " due to timeout" suffix, so the exact checks below miss it.
 */
export function isClientAbortError(e: unknown): boolean {
  let cur = e as { name?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const isAbort =
      cur.name === 'AbortError' ||
      cur.message === 'This operation was aborted' ||
      cur.message === 'The operation was aborted';
    if (isAbort) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * True when an error is a Prisma unique-constraint violation (P2002).
 *
 * Engagement "toggle" procedures follow a read-then-create pattern (findUnique →
 * create-if-absent). Two concurrent calls can both observe "absent" and both
 * create, so the loser hits the row's unique constraint (P2002). Because the row
 * now exists, the toggle is idempotent: a P2002 there means "already toggled on",
 * so the caller should treat it as success rather than bubble a 500. Use only at
 * sites where P2002 unambiguously means "the exact row we wanted already exists".
 */
export function isPrismaUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * True when an error is a Prisma foreign-key violation (P2003).
 *
 * Usually means the referenced row was deleted between the client reading it and
 * the write landing — i.e. "the thing you're acting on no longer exists" rather
 * than a server fault. Callers should translate it to a 404, not a 500.
 */
export function isPrismaForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** True when an `update`/`delete` matched no row (P2025). */
export function isPrismaRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * Postgres `55P03` (lock_not_available, e.g. a `lock_timeout` expiry). A raw query surfaces it as
 * P2010 with the SQLSTATE in `meta.code`; a model query as an unknown request error with no code,
 * the SQLSTATE only in the engine's message.
 */
export function isPrismaLockTimeout(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return (
      error.code === 'P2010' && (error.meta as { code?: unknown } | undefined)?.code === '55P03'
    );
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('PostgresError { code: "55P03"')
  );
}

/** Is this specific object a database driver's own error? */
function isDriverError(e: unknown): e is Error {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError ||
    e instanceof DatabaseError
  );
}

/**
 * True when `message` is not merely ACCOMPANIED by a driver error but IS that
 * driver error's own text — query/schema prose nobody wrote for a caller to read.
 *
 * 🔴 civitai#3845 investigation 3. `throwDbError` copies `error.message` verbatim
 * into the TRPCError it throws, and `prismaErrorToTrpcCode` maps a large slice of
 * Prisma codes to **4xx** statuses (P2000→400, P2001/P2015/P2018/P2025→404,
 * P2002/P2003/P2004/P2014→409, P1008/P2024→408). `handleEndpointError` passes 4xx
 * bodies through byte-identically on the stated grounds that "4xx is client
 * feedback the caller is meant to read" — TRUE for a zod issue list or a
 * hand-written "not found", FALSE for these, which reach the wire as e.g.
 *
 *   P2000 → 400  "…Invalid `prisma.appListing.create()` invocation… The provided
 *                 value for the column is too long for the column's type.
 *                 Column: app_listings.slug"
 *   P2003 → 409  discloses the foreign-key CONSTRAINT name
 *   P2025 → 404  discloses the model and the method
 *
 * 🔴 **Why message IDENTITY and not "is there a driver in the cause chain".** The
 * chain test has a real false positive that would have destroyed good messages:
 * `throwBadRequestError('That slug is already taken', dbError)` and
 * `throwConflictError`/`throwRateLimitError`/`throwDbCustomError(msg)` all attach
 * the driver error as `cause` while writing a message FOR the caller. Identity
 * separates them by construction — if the text on the wire is byte-identical to
 * the driver's own text, it is the driver's text, whoever forwarded it.
 *
 * The walk covers `cause` (that is where `throwDbError` puts the driver error) and
 * the error itself (some sites reach the helper unwrapped). Depth 4 matches
 * `isClientAbortError`: tRPC wraps once, a service layer may wrap again.
 *
 * `pg` is included deliberately and is the WORST case, not a hypothetical. A real
 * `DatabaseError` carries its fields as ENUMERABLE own properties, so a `23505`
 * unique violation serializes `detail: "Key (email)=(victim@example.com) already
 * exists."` — an actual user row value — alongside `schema`, `table` and
 * `constraint`. Kysely (`~/server/db/kyselyDb`) runs on that `pg` pool, so the
 * class is not Prisma-only.
 *
 * NB this asks "who WROTE the text", not "how severe is it". A driver error mapped
 * to a 4xx is still a legitimate 4xx — `handleEndpointError` keeps the STATUS and
 * replaces only the MESSAGE.
 *
 * 🔴 **A site that re-wraps a caught error's `.message` into a 4xx TRPCError
 * *without* setting `cause` defeats this predicate** — the wire text is the
 * driver's, but nothing in the chain says so. There were 17 such sites (App
 * Blocks + referral routers); all now pass `cause`, and
 * `rest-error-envelope-ledger.test.ts` pins the set at ZERO, failing the moment
 * one reappears. The two bodies differ by that single word, and the difference is
 * demonstrated as a pair in `endpoint-helpers-driver-4xx.test.ts`.
 *
 * 🔴 **Scope of that predicate, so nobody over-reads it:** this function is
 * consulted by `handleEndpointError` and by nothing else, and that helper serves
 * the REST `/api/*` surface. tRPC errors go through `trpc.ts`'s own
 * `errorFormatter`, which neither calls this nor puts `cause` on the wire. So
 * `cause` on a tRPC router site is latent correctness — it makes the site right
 * if its procedure is ever reached through the REST helper (several `/api/v1/*`
 * routes DO call procedures via `publicApiContext2`), not a change to any
 * response body emitted today.
 */
export function isDriverAuthoredMessage(message: string, e: unknown): boolean {
  let cur = e as { cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (isDriverError(cur) && cur.message === message) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * Exported for `rest-error-envelope-ledger.test.ts`, which derives the set of 4xx
 * statuses a driver-authored message can reach from THIS map rather than from a
 * hand-copied list — so adding a mapping here cannot silently outrun
 * `GENERIC_CLIENT_ERROR_BY_STATUS`.
 */
export const prismaErrorToTrpcCode: Record<string, TRPC_ERROR_CODE_KEY> = {
  // Unreachable database / no pooled connection in time: transient, so a retryable 503. Never
  // with the driver's message — a 503 is not masked on the wire, and these name the host.
  P1001: 'SERVICE_UNAVAILABLE',
  P1002: 'SERVICE_UNAVAILABLE',
  P1017: 'SERVICE_UNAVAILABLE',
  P1008: 'TIMEOUT',
  P2000: 'BAD_REQUEST',
  P2001: 'NOT_FOUND',
  P2002: 'CONFLICT',
  P2003: 'CONFLICT',
  P2004: 'CONFLICT',
  P2005: 'BAD_REQUEST',
  P2006: 'BAD_REQUEST',
  P2007: 'BAD_REQUEST',
  P2008: 'INTERNAL_SERVER_ERROR',
  P2009: 'INTERNAL_SERVER_ERROR',
  P2010: 'INTERNAL_SERVER_ERROR',
  P2011: 'BAD_REQUEST',
  P2012: 'BAD_REQUEST',
  P2013: 'BAD_REQUEST',
  P2014: 'CONFLICT',
  P2015: 'NOT_FOUND',
  P2016: 'INTERNAL_SERVER_ERROR',
  P2017: 'INTERNAL_SERVER_ERROR',
  P2018: 'NOT_FOUND',
  P2019: 'BAD_REQUEST',
  P2020: 'BAD_REQUEST',
  P2021: 'INTERNAL_SERVER_ERROR',
  P2022: 'INTERNAL_SERVER_ERROR',
  P2023: 'INTERNAL_SERVER_ERROR',
  P2024: 'SERVICE_UNAVAILABLE',
  P2025: 'NOT_FOUND',
  P2026: 'INTERNAL_SERVER_ERROR',
  P2027: 'INTERNAL_SERVER_ERROR',
  P2028: 'INTERNAL_SERVER_ERROR',
  P2030: 'INTERNAL_SERVER_ERROR',
  P2033: 'INTERNAL_SERVER_ERROR',
  P2034: 'INTERNAL_SERVER_ERROR',
};

/** What a client is told when the database is unreachable: never the driver's text. */
export const DB_UNAVAILABLE_MESSAGE = 'This service is temporarily unavailable. Please try again.';

/**
 * The one Prisma known-error → TRPCError mapping. `message` (a caller's own text) replaces the
 * driver's, except on a 503: that is always the generic message.
 */
function prismaKnownToTrpcError(error: Prisma.PrismaClientKnownRequestError, message?: string) {
  const code = prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR';
  return new TRPCError({
    code,
    message: code === 'SERVICE_UNAVAILABLE' ? DB_UNAVAILABLE_MESSAGE : message ?? error.message,
    cause: error,
  });
}

/**
 * A server-fault TRPCError whose cause is an unreachable database (or no pooled connection in time)
 * as a retryable SERVICE_UNAVAILABLE; `undefined` for anything else. Only INTERNAL_SERVER_ERROR and
 * TIMEOUT are re-mapped: a code a handler chose on purpose (NOT_FOUND, …) is left alone.
 */
export function toDbUnavailableError(error: TRPCError, path?: string): TRPCError | undefined {
  if (error.code !== 'INTERNAL_SERVER_ERROR' && error.code !== 'TIMEOUT') return undefined;
  const dbCause = dbUnavailableCause(error);
  if (!dbCause) return undefined;
  // A 503 skips the central error log (src/pages/api/trpc/[trpc].ts), so the re-map itself is
  // logged: the original error's name and code only — never its message, which names the host.
  console.warn(
    JSON.stringify({
      type: 'warning',
      name: 'db-unavailable-503',
      message: 'Database unavailable: served 503',
      path,
      errorName: dbCause.name,
      errorCode: dbCause.code,
    })
  );
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: DB_UNAVAILABLE_MESSAGE,
    cause: error.cause ?? error,
  });
}

export function throwDbError(error: unknown) {
  // Always log to console
  if (error instanceof TRPCError) {
    throw error;
  } else if (error instanceof Prisma.PrismaClientKnownRequestError)
    throw prismaKnownToTrpcError(error);
  else if (error instanceof Prisma.PrismaClientValidationError)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Database validation error',
      cause: error,
    });

  const e = error as Error;
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: e.message ?? 'An unexpected error ocurred, please try again later',
    cause: error,
  });
}

export function throwInternalServerError(error: unknown) {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (error as any).message ?? 'An unexpected error ocurred, please try again later',
    cause: error,
  });
}

export const handleTRPCError = (error: Error): TRPCError => {
  const isTrpcError = error instanceof TRPCError;
  if (!isTrpcError) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) throw prismaKnownToTrpcError(error);
    else if (error instanceof Prisma.PrismaClientValidationError)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Database validation error',
        cause: error,
      });
    else
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message ?? 'An unexpected error ocurred, please try again later',
        cause: error,
      });
  } else {
    throw error;
  }
};

export const BANNED_ACCOUNT_MESSAGE =
  'You cannot perform this action because your account has been banned';

export function throwAuthorizationError(message: string | null = null) {
  message ??= 'You are not authorized to perform this action';
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message,
  });
}

export function throwBadRequestError(
  message: string | null = null,
  error?: unknown,
  overwriteMessage = true
) {
  message = overwriteMessage ? message ?? 'Your request is invalid' : message;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: message ?? undefined,
    cause: error,
  });
}

export function throwNotFoundError(message: string | null = null) {
  message ??= 'Could not find entity';
  throw new TRPCError({
    code: 'NOT_FOUND',
    message,
  });
}

export function throwDbCustomError(message?: string) {
  return (error: PrismaClientKnownRequestError) => {
    throw prismaKnownToTrpcError(error as Prisma.PrismaClientKnownRequestError, message);
  };
}

export function throwRateLimitError(message: string | null = null, error?: unknown) {
  message ??= `Slow down! You've made too many requests. Please take a breather`;
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message,
    cause: error,
  });
}

export function throwInsufficientFundsError(message: string | null = null, error?: unknown) {
  message ??= `Hey buddy, seems like you don't have enough funds to perform this action.`;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message,
    cause: error,
  });
}

export function throwConflictError(message: string | null = null, error?: unknown) {
  message ??= 'There was a conflict with your request';
  throw new TRPCError({
    code: 'CONFLICT',
    message,
    cause: error,
  });
}

/**
 * Surface a transient dependency outage as TRPCError SERVICE_UNAVAILABLE (HTTP 503,
 * retry-able) instead of a raw INTERNAL_SERVER_ERROR (500). 503 tells a polling
 * client "temporarily unavailable, back off and retry" and keeps a dependency's
 * own 5xx / network blip from counting against this app's 500 SLO.
 *
 * Always pass the original error as `cause` so it stays diagnosable in logs.
 */
export function throwServiceUnavailableError(message: string | null = null, error?: unknown) {
  message ??= 'This service is temporarily unavailable. Please try again.';
  throw new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message,
    cause: error,
  });
}

/**
 * True when an error is a status-less NETWORK failure reaching an upstream HTTP
 * dependency — the TCP/DNS/TLS layer failed before any HTTP response came back, so
 * there is no HTTP status to key off. The Node/undici fetch surfaces these as a
 * bare `TypeError: fetch failed` whose `.cause` carries the real syscall
 * (`ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/`ECONNRESET`/`EAI_AGAIN`), or as an
 * `AbortError`/timeout.
 *
 * This is intentionally NARROW: it matches ONLY recognized network signatures, so a
 * genuine `TypeError` thrown by OUR OWN code (a real bug — e.g. reading a property
 * of undefined) does NOT match and is left to surface as a 500. We never blanket-
 * convert "any thrown error" to a network failure.
 */
export function isUpstreamNetworkError(e: unknown): boolean {
  const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]);
  // Walk the `.cause` chain (undici nests the syscall error under TypeError.cause).
  let cur = e as { name?: string; message?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (typeof cur.code === 'string' && NETWORK_CODES.has(cur.code)) return true;
    const msg = typeof cur.message === 'string' ? cur.message : '';
    // The canonical undici/fetch network-failure signature.
    if (msg === 'fetch failed' || msg.includes('fetch failed')) return true;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND'))
      return true;
    // A request-timeout / abort with no HTTP status is also a transient reach
    // failure (e.g. an orchestrator request that timed out before a response).
    if (
      cur.name === 'AbortError' ||
      cur.name === 'TimeoutError' ||
      msg === 'The operation was aborted' ||
      msg === 'This operation was aborted'
    )
      return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * Decides whether an orchestrator-client failure represents a genuine UPSTREAM
 * server fault or network failure (→ should be surfaced as a retry-able 503) vs.
 * something we should leave alone.
 *
 * Returns true ONLY for:
 *  - a client error object carrying an HTTP `status >= 500` (upstream 5xx), or
 *  - a status-less network failure (see {@link isUpstreamNetworkError}).
 *
 * Returns false for 4xx (client/validation faults — keep their mapped codes) and
 * for unrecognized errors (a real bug in our code → keep surfacing as 500).
 *
 * `clientError` is the `{ status?, detail? }`-shaped object from the generated
 * client's `{ data, error }` result; `thrown` is an error caught from a rejected
 * client call (network failures arrive this way, with no `status`).
 */
export function isUpstreamServerOrNetworkError(args: {
  clientError?: { status?: unknown } | null;
  thrown?: unknown;
}): boolean {
  const { clientError, thrown } = args;
  const status = clientError?.status;
  if (typeof status === 'number' && status >= 500) return true;
  if (thrown !== undefined && isUpstreamNetworkError(thrown)) return true;
  return false;
}

// Syscall codes for a dropped/refused/reset TCP connection. (Intentionally a
// SUBSET of isUpstreamNetworkError's set — only true transport faults, no
// DNS-resolution-style codes.)
const TRANSPORT_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// ClickHouse server error codes that are TRANSIENT INFRA brownouts (never a query
// or schema fault). 279/210/209 = connection/transport; 202 = momentary capacity
// overload. Strings, because ClickHouseError.code is a string.
const TRANSIENT_CH_CODES = new Set(['279', '210', '209', '202']);

// Lowercased, anchored patterns for the same syscall codes, for the message-only match in
// isClickHouseConnectionError. The boundary class excludes two different kinds of
// character, and each exclusion rejects a case the other does not:
//
// (c) IDENTIFIER characters. A bare `includes` treats these codes as substrings, and
//     ordinary camelCase identifiers embed them — `epipe` inside `sourcePipeline`,
//     `etimedout` inside `responseTimedOut` (this repo already spells `deadlineTimedOut`
//     in `src/pages/api/health.ts`). A `Code: 47` missing-column error naming such a
//     column would otherwise classify as a transport fault and be swallowed. `a-z0-9_`
//     also stops `UND_ERR_SOCKET` matching inside `some_und_err_socket_thing`.
//
// (d) QUOTE characters — `'`, `"` and a backtick. A token flanked by one of these is a
//     SQL string literal or a quoted identifier, not a syscall name in a transport
//     message: ClickHouse renders both that way inside its own exception text (`Cannot
//     parse string 'EPIPE' as UInt64`, `Syntax error: failed at position 9 ('reason =
//     'ETIMEDOUT'')`). Exclusion (c) alone does NOT reject these — a quote is already a
//     non-identifier character, so a whole-word token between quotes matches the same as
//     one between spaces. Node's syscall spellings are space-flanked — `read ECONNRESET`,
//     `write EPIPE`, `connect ETIMEDOUT <addr>` — so none of them loses its match.
const TRANSPORT_SYSCALL_MESSAGE_PATTERNS = [...TRANSPORT_SYSCALL_CODES].map(
  (code) => new RegExp(`(?:^|[^a-z0-9_'"\`])${code.toLowerCase()}(?:$|[^a-z0-9_'"\`])`)
);

// Verbatim prefix and SQL separator that packages/civitai-clickhouse/src/client.ts
// `$query` builds its rethrow from: `ClickHouse query failed: <original>\nQuery: <sql>`.
const CH_QUERY_WRAPPER_PREFIX = 'clickhouse query failed:';
const CH_QUERY_SQL_SEPARATOR = '\nquery:';

/**
 * True ONLY for a TRANSIENT ClickHouse CONNECTION / TRANSPORT failure — the kind
 * that flaps when reaching ClickHouse Cloud (a socket reset / broken pipe / all
 * connection tries failed), NOT a query/schema fault.
 *
 * Why this is deliberately NARROW: the buzz-reward write and the image-feed metric
 * enrichment both touch ClickHouse, and we want a CH *transport* blip to fail SOFT
 * (so it can't 500 a user mutation or a feed page). But a *query/schema* error
 * (`Code: 60` UNKNOWN_TABLE, `Code: 349` NULL→non-Nullable, a syntax error) is a
 * REAL BUG / deploy break — swallowing it would have HIDDEN the missing-table
 * incident. So this predicate is an ALLOWLIST of transient-infra signatures and
 * returns FALSE for everything else, leaving query/schema errors to surface (and
 * alert) as a 500 exactly as today.
 *
 * Matches three shapes, because the same underlying failure can surface differently
 * depending on the call path:
 *  1. A raw socket error thrown before any HTTP response — `.code` is the syscall
 *     (`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`ECONNREFUSED`), or the message is
 *     `socket hang up`. This is how `@clickhouse/client` surfaces a dropped
 *     connection (and how the event-engine-common `MetricService` read throws).
 *  2. A `@clickhouse/client` `ClickHouseError` carrying a numeric `.code` string —
 *     we match the transport-class codes `279` ALL_CONNECTION_TRIES_FAILED, `210`
 *     NETWORK_ERROR (broken pipe while writing to socket), `209` SOCKET_TIMEOUT, AND
 *     the one transient-CAPACITY brownout code `202` TOO_MANY_SIMULTANEOUS_QUERIES
 *     (the 2026-06-18 incident that the inline buzz-reward fail-soft #2646 was built
 *     for — a momentary CH Cloud overload, retryable, NOT a code bug). Query/schema
 *     codes (`60`, `349`, …) are NOT in the set.
 *  3. Our own `$query` wrapper flattens both of the above into a plain
 *     `Error('ClickHouse query failed: <original message>\nQuery: <sql>')`, losing
 *     `.code`, so we also string-match the transient signatures in the message
 *     (`Code: 279`/`210`/`209`/`202`, `socket hang up`, `broken pipe`, `all connection
 *     tries failed`, `too many simultaneous queries`, and — under the four narrowing rules
 *     below — every `TRANSPORT_SYSCALL_CODES` spelling).
 *
 * 🔴 THE MESSAGE THAT SHAPE 3 MATCHES CONTAINS QUERY TEXT, FROM TWO SOURCES. `$query`
 * appends `\nQuery: <sql>`, and ClickHouse re-embeds fragments of the failing query and
 * its string literals inside its own exception text. An unrestricted substring match
 * would let either one decide the classification — the exact inversion of what this
 * predicate is for. Four narrowing rules apply to the syscall-spelling match: (a) drop the
 * `\nQuery:` tail `$query` appended, (b) require our own wrapper prefix, (c) reject a
 * token embedded in an identifier, (d) reject a token flanked by a quote character. Each
 * is documented at the code that applies it, and each has a case only it rejects in
 * `src/server/utils/__tests__/errorHandling.clickhouse-classify.test.ts`.
 *
 * 🔴 WHAT REMAINS UNCOVERED: a syscall token that ClickHouse re-embeds into its exception
 * text WITHOUT quoting it is rejected by none of the four and is still classified
 * transient, so a genuine query/schema fault fails soft instead of surfacing as the 500
 * this predicate exists to preserve. Only reads through `$query` are exposed, because rule
 * (b) requires that wrapper's prefix — a raw `client.insert` or `SimpleClickhouse.query`
 * error carries none, so it stays a 500. Rule (a) cannot see the token (it is before the
 * separator), and rule (d) cannot (it is not quoted). Pinned by two tests in
 * `src/server/utils/__tests__/errorHandling.clickhouse-classify.test.ts`.
 * 🔴 Nor can a rule keyed on ClickHouse's own `DB::Exception:` marker — that is inert
 * here, because `parseError` sets `.message` to the text BETWEEN `Exception: ` and the
 * `(TYPE)` marker, so a well-formed server error reaches `$query` with the marker already
 * stripped. The literal-phrase matches above get (a) only: they run on the truncated
 * message, but carry no prefix, identifier or quote boundary.
 *
 * Walks the `.cause` chain so a wrapped error (tRPC `TRPCError{ cause }`, undici
 * `TypeError{ cause }`) is still classified.
 */
export function isClickHouseConnectionError(e: unknown): boolean {
  let cur = e as { name?: string; message?: string; code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = cur.code;
    if (typeof code === 'string') {
      // Shape 1: raw syscall code. Shape 2: numeric ClickHouseError code (string).
      if (TRANSPORT_SYSCALL_CODES.has(code)) return true;
      if (TRANSIENT_CH_CODES.has(code)) return true;
    }
    // `$query` APPENDS `\nQuery: <sql>` to the message it throws, so the raw string
    // carries the query text as well as the failure. Match only the part BEFORE that
    // separator, so a token that appears ONLY in that appended tail cannot decide the
    // classification: a `Code: 60` UNKNOWN_TABLE thrown for `… WHERE tag = 'ECONNRESET'`
    // would otherwise read as a transport blip and get swallowed.
    //
    // 🔴 This strips the appended tail and nothing else — ClickHouse re-embeds query
    // fragments inside its own exception text, which sits before the separator and
    // survives. See the docblock for what that leaves uncovered.
    const rawMsg = typeof cur.message === 'string' ? cur.message.toLowerCase() : '';
    const sqlAt = rawMsg.indexOf(CH_QUERY_SQL_SEPARATOR);
    const msg = sqlAt === -1 ? rawMsg : rawMsg.slice(0, sqlAt);
    if (msg) {
      // Shape 3: the $query-wrapped string. Transient-infra signatures ONLY — multi-word
      // phrases and `Code: NNN` prefixes that a ClickHouse query/schema error does not
      // emit. Every one contains a space or a colon, so no identifier can embed them and
      // they need no anchoring. Unlike the syscall spellings below they are not scoped to
      // our wrapper prefix, and query text reaches them only where ClickHouse re-embeds
      // it in its own exception text — an accepted limit, not a covered case.
      if (
        msg.includes('socket hang up') ||
        msg.includes('broken pipe') ||
        msg.includes('all connection tries failed') ||
        msg.includes('connection refused') ||
        msg.includes('connection reset') ||
        msg.includes('too many simultaneous queries') ||
        // A `Code: NNN` prefix survives only when parseError's regex fails and it rethrows
        // verbatim; a parsed error arrives as inner text (`All connection tries failed. `,
        // 1.23.1), which the phrases above catch for 279/210/202 but NOT 209 — no phrase
        // here is a socket-timeout signature. Neither half covers the other.
        msg.includes('code: 279') ||
        msg.includes('code: 210') ||
        msg.includes('code: 209') ||
        msg.includes('code: 202')
      ) {
        return true;
      }
      // Reads through $query arrive as a plain Error, so for those the .code branch never
      // fires and the syscall name survives only as text. Restricted to OUR wrapper's
      // message: a raw syscall error from any other dependency still carries `.code`, so
      // nothing is lost — while an unrelated upstream's TEXT (a Redis
      // `connect ECONNREFUSED` in a bare message) must not be reported as a ClickHouse
      // brownout, or the fail-soft counter attributes the wrong dependency's outage here.
      // Scoped to the text route only: an error OBJECT carrying `.code` is matched by
      // shape 1 above regardless of which dependency raised it.
      if (msg.includes(CH_QUERY_WRAPPER_PREFIX)) {
        for (const pattern of TRANSPORT_SYSCALL_MESSAGE_PATTERNS) {
          if (pattern.test(msg)) return true;
        }
      }
    }
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * Run a ClickHouse READ and map a TRANSIENT connection/transport blip to a
 * retryable SERVICE_UNAVAILABLE (HTTP 503) instead of a raw INTERNAL_SERVER_ERROR
 * (500). A transient dependency outage — a `socket hang up`, a dropped/reset socket,
 * a momentary CH-Cloud capacity brownout (Code 279/210/209/202) — is retryable, so a
 * polling client should back off + retry rather than the user-facing query 500ing and
 * counting against this app's 500 SLO. A REAL query/schema fault (non-connection CH
 * error — bad SELECT, UNKNOWN_TABLE, `Code: 62/60/349`) is rethrown UNCHANGED so it
 * still surfaces (and alerts) as a 500. The original error is always preserved as the
 * TRPCError `cause`.
 *
 * This is the reusable form of the inline guard hand-written for the New Order
 * counters (#3064) and #2978/#3049 — wrap ONLY the READ call-sites you want to
 * fail-503 on a CH brownout. It is deliberately NOT applied to the shared
 * `clickhouse.$query` client boundary, which also serves inserts + background/cron
 * reads where a tRPC-typed 503 would be semantically wrong; classification stays a
 * narrow, transient-only allowlist (see {@link isClickHouseConnectionError}).
 *
 * `path` is a Prometheus label on `clickhouseFailSoftCounter`, so it must be a
 * per-call-site constant — anything request-derived multiplies the series.
 *
 * 🔴 THE `logToAxiom` CALL IS NOT REDUNDANT WITH THE COUNTER, AND NOT OPTIONAL. The
 * central tRPC error handler (`src/pages/api/trpc/[trpc].ts`) returns EARLY on
 * `SERVICE_UNAVAILABLE` and skips the Axiom ingest entirely, deliberately — a 503 wave is
 * exactly when per-reject stringify+ingest costs the most. So re-mapping a transient CH
 * read to a 503 converts a logged `ClickHouse query failed: …` line into a SILENT
 * degradation. The counter records THAT it happened and where; only this line carries the
 * message — which, for a `$query` read, is the one that embeds the failing SQL. The same
 * counter+log pairing is at `image.service`'s `image-feed` fail-soft.
 *
 * Fire-and-forget with an explicit no-op rejection handler: telemetry must never change
 * what this function throws, and must never delay it. `logToAxiom` already contains its
 * own failures, so this handler is belt-and-braces — but a bare `.catch()` (no argument)
 * would NOT contain one, since it passes the rejection straight through. (The
 * `image-feed` site spells it `.catch()`; that is the shape to avoid, not to copy.)
 */
export async function runClickHouseRead<T>(
  fn: () => Promise<T>,
  options: { path: string; message?: string }
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isClickHouseConnectionError(e)) {
      clickhouseFailSoftCounter.inc({ path: options.path });
      logToAxiom(
        {
          type: 'warning',
          name: 'clickhouse-failsoft',
          message: 'ClickHouse transport error on an instrumented read — served 503',
          path: options.path,
          error: e instanceof Error ? e.message : String(e),
        },
        'clickhouse'
      );
      throwServiceUnavailableError(
        options.message ?? 'This service is temporarily unavailable. Please try again.',
        e
      );
    }
    throw e;
  }
}

export function handleLogError(e: Error, name?: string, details?: MixedObject) {
  const error = new Error(e.message ?? 'Unexpected error occurred', { cause: e });
  if (isProd)
    logToAxiom(
      {
        type: 'error',
        name: name ?? error.name,
        ...details,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'civitai-prod'
    );
  else console.error(error);
}

export async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export function withRetries<T>(
  fn: () => Promise<T>,
  retries = 3,
  retryTimeout?: number
): Promise<T> {
  return fn().catch((error: Error) => {
    if (retries > 0) {
      if (retryTimeout) {
        return sleep(retryTimeout).then(() => {
          return withRetries(fn, retries - 1, retryTimeout);
        });
      }
      return withRetries(fn, retries - 1);
    } else {
      throw error;
    }
  });
}
