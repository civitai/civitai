import { Prisma } from '@prisma/client';
// `pg` re-exports pg-protocol's DatabaseError; import it from `pg` because that
// is the direct dependency — `pg-protocol` is transitive and is NOT hoisted under
// this repo's pnpm layout, so importing it directly fails to resolve.
import { DatabaseError } from 'pg';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { isProd } from '~/env/other';
import { logToAxiom } from '../logging/client';
import type { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { parse as parseStackTrace } from 'stacktrace-parser';
import { SourceMapConsumer } from 'source-map';
import path from 'node:path';
import fs from 'node:fs';

// Local Meili-deadline sentinel — kept in sync with FETCH_DOCUMENTS_TIMEOUT_MESSAGE
// in src/server/meilisearch/client.ts. Duplicated as a literal (not imported) on
// purpose: client.ts already imports `sleep` from this module, so importing the
// constant back would form a circular dependency (the class that produced the
// article.metrics Next-16 TDZ → 500 regression). A server-side timeout is NOT a
// client abort — it surfaces as a 408 elsewhere.
const MEILI_LOCAL_TIMEOUT_MESSAGE = 'meili-fetch-timeout';

/**
 * True when an error is a CLIENT-side request abort — the browser closed the tab,
 * scrolled the infinite feed past the in-flight page, or navigated away, cancelling
 * the request's AbortSignal mid-fetch. These surface as a bare `AbortError`
 * (DOMException) that, untreated, bubbles to a 500 even though the server did
 * nothing wrong and there is no client left to receive a response.
 *
 * Walks the `.cause` chain because tRPC wraps the thrown error as
 * `TRPCError{ cause }` and the Meili layer may wrap once more. Explicitly EXCLUDES
 * our own local Meili deadline, which also manifests as an AbortError but is a
 * server-side timeout (handled as 408), not a client disconnect.
 */
export function isClientAbortError(e: unknown): boolean {
  let cur = e as { name?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const isAbort =
      cur.name === 'AbortError' ||
      cur.message === 'This operation was aborted' ||
      cur.message === 'The operation was aborted';
    if (isAbort) {
      const causeMsg = (cur.cause as { message?: string } | undefined)?.message;
      const isLocalTimeout =
        cur.message === MEILI_LOCAL_TIMEOUT_MESSAGE || causeMsg === MEILI_LOCAL_TIMEOUT_MESSAGE;
      return !isLocalTimeout;
    }
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

/** This object alone (no `cause` walk) carries a Node/undici socket or DNS error code. */
function hasNetworkErrorCode(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

/**
 * Is this specific object a database driver's own error, or a socket/DNS error beneath
 * any client — whose text (`connect ECONNREFUSED <host>:<port>`) names internal hosts?
 */
function isDriverError(e: unknown): e is Error {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError ||
    e instanceof DatabaseError ||
    (e instanceof Error && hasNetworkErrorCode(e))
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
 * `rest-error-envelope-ledger.test.ts` fails when one reappears — but only for the
 * spellings its regex knows, so a novel one can still slip by. The two bodies
 * differ by that single word, and the difference is demonstrated as a pair in
 * `endpoint-helpers-driver-4xx.test.ts`.
 *
 * Two consumers: `handleEndpointError` (REST `/api/*`) and
 * `getClientSafeError` (`server/trpc/client-safe-error.ts`, tRPC's
 * `errorFormatter`), so the same site loses its `cause` on both surfaces at once.
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
  P2024: 'TIMEOUT',
  P2025: 'NOT_FOUND',
  P2026: 'INTERNAL_SERVER_ERROR',
  P2027: 'INTERNAL_SERVER_ERROR',
  P2028: 'INTERNAL_SERVER_ERROR',
  P2030: 'INTERNAL_SERVER_ERROR',
  P2033: 'INTERNAL_SERVER_ERROR',
  P2034: 'INTERNAL_SERVER_ERROR',
};

export function throwDbError(error: unknown) {
  // Always log to console
  if (error instanceof TRPCError) {
    throw error;
  } else if (error instanceof Prisma.PrismaClientKnownRequestError)
    throw new TRPCError({
      code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
      message: error.message,
      cause: error,
    });
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
    if (error instanceof Prisma.PrismaClientKnownRequestError)
      throw new TRPCError({
        code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
        message: error.message,
        cause: error,
      });
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
    throw new TRPCError({
      code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
      message: message ?? error.message,
      cause: error,
    });
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
  // Walk the `.cause` chain (undici nests the syscall error under TypeError.cause).
  let cur = e as { name?: string; message?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (hasNetworkErrorCode(cur)) return true;
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
 *     `Error('ClickHouse query failed: <original message>')`, losing `.code`, so we
 *     also string-match the transient signatures in the message (`Code: 279`/`210`/
 *     `209`/`202`, `socket hang up`, `broken pipe`, `all connection tries failed`,
 *     `too many simultaneous queries`). The message match is still transient-ONLY —
 *     `Code: 60` / `unknown table` never match.
 *
 * Walks the `.cause` chain so a wrapped error (tRPC `TRPCError{ cause }`, undici
 * `TypeError{ cause }`) is still classified.
 */
export function isClickHouseConnectionError(e: unknown): boolean {
  // Syscall codes for a dropped/refused/reset TCP connection. (Intentionally a
  // SUBSET of isUpstreamNetworkError's set — only true transport faults, no
  // DNS-resolution-style codes that wouldn't apply to a pooled CH connection.)
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

  let cur = e as
    | { name?: string; message?: string; code?: unknown; cause?: unknown }
    | undefined;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = cur.code;
    if (typeof code === 'string') {
      // Shape 1: raw syscall code. Shape 2: numeric ClickHouseError code (string).
      if (TRANSPORT_SYSCALL_CODES.has(code)) return true;
      if (TRANSIENT_CH_CODES.has(code)) return true;
    }
    const msg = typeof cur.message === 'string' ? cur.message.toLowerCase() : '';
    if (msg) {
      // Shape 3: the $query-wrapped string. Transient-infra signatures ONLY — these
      // never appear in an UNKNOWN_TABLE / NULL-insert / syntax error message.
      if (
        msg.includes('socket hang up') ||
        msg.includes('broken pipe') ||
        msg.includes('all connection tries failed') ||
        msg.includes('connection refused') ||
        msg.includes('connection reset') ||
        msg.includes('too many simultaneous queries') ||
        // The `Code: NNN` prefix our $query wrapper preserves, transient codes only.
        msg.includes('code: 279') ||
        msg.includes('code: 210') ||
        msg.includes('code: 209') ||
        msg.includes('code: 202')
      ) {
        return true;
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
 */
export async function runClickHouseRead<T>(
  fn: () => Promise<T>,
  message = 'This service is temporarily unavailable. Please try again.'
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isClickHouseConnectionError(e)) throwServiceUnavailableError(message, e);
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
    ).catch();
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

/**
 * How many distinct frame files one `applySourceMaps` call may resolve.
 *
 * 10 is sized from the half that can be established here. On V8 — Node, and Chromium browsers —
 * `Error.stackTraceLimit` defaults to 10, and nothing in `src/` or `next.config.mjs` assigns it,
 * so an Error captured under this app carries at most 10 frames and therefore at most 10 distinct
 * files. `Error.stackTraceLimit` is a V8 extension, and this endpoint takes stacks from every
 * browser: how many frames a non-V8 engine sends is not a claim this file can make, which is why
 * the cap is written as a bound on work rather than as a ceiling nothing reaches.
 *
 * What it bounds is input that is not a stack at all. `stack` arrives at `/api/application-error`
 * as free-form text from an unauthenticated caller, and each additional distinct file that names a
 * build chunk costs a read of the chunk, a read of its map and a `SourceMapConsumer` build — all
 * `await`ed on the pool that serves pages. Without a bound, how many of those one request asks for
 * is set by the request.
 *
 * Frames past the cap are left exactly as they arrived: unresolved, never dropped, never an error,
 * and the report is delivered either way. The cap is spent on frames that can actually be
 * resolved — see the candidate loop in `applySourceMaps` — so a stack topped with foreign frames
 * (an extension, an analytics script, a payment iframe) does not spend it on work that was never
 * going to happen.
 */
const MAX_RESOLVED_FRAME_FILES = 10;

/**
 * How many parsed source maps stay resident between calls.
 *
 * This cache used to be declared inside `applySourceMaps`, so every call paid the full read and
 * parse even for a chunk the previous call had just parsed — and reports cluster hard on a few
 * chunks (framework, main, and whichever page is broken), which is exactly the shape a cache
 * serves. Bounded because each entry is a parsed map held for the life of the process.
 *
 * DERIVED from the cap, not chosen, because the two interact and a cache below the cap is worse
 * than no cache: one call may resolve `MAX_RESOLVED_FRAME_FILES` distinct chunks, so a smaller
 * cache cannot hold even a single call's own working set — the tail of that call evicts its own
 * head, and the next report naming the same chunks re-reads and re-parses every one of them at a
 * 0% hit rate while still paying the memory. Deriving it is what stops a later edit to either
 * number silently re-creating that; `does not re-read any chunk of a repeated full-width stack` in
 * `errorHandling.applySourceMaps.test.ts` is the behavioural half of the same guard.
 */
const MAX_CACHED_SOURCE_MAPS = MAX_RESOLVED_FRAME_FILES;

/**
 * A cached consumer plus the bookkeeping that makes eviction safe.
 *
 * 🔴 THE POINT OF `refs`/`evicted` IS A LEAK, NOT A WRONG ANSWER. Plain LRU — evict, `destroy()`,
 * done — cannot corrupt a result here, because `source-map@0.7.6`'s `destroy()` frees the mappings
 * and zeroes `_mappingsPtr` (`lib/source-map-consumer.js`) and `originalPositionFor` goes through
 * `_getMappingsPtr()`, which RE-PARSES when the pointer is zero. A call holding a destroyed
 * consumer therefore still gets the correct location. What it does NOT get is a second free: that
 * re-parse allocates a fresh copy of the mappings into the process-wide wasm heap — `lib/wasm.js`
 * caches one `WebAssembly.Instance` for the whole process — and by then the consumer has already
 * left the cache, so nothing will ever `destroy()` it again. `WebAssembly.Memory` never shrinks
 * and JS GC cannot reclaim a Rust-side allocation, so every one of those re-parses is permanent.
 *
 * That is not a rare interleaving. `MAX_CACHED_SOURCE_MAPS === MAX_RESOLVED_FRAME_FILES`, so the
 * cache is sized for ONE call's working set; under C concurrent calls it is C times too small and
 * the calls evict each other's live consumers. `applySourceMaps` awaits every
 * `new SourceMapConsumer(...)`, so concurrent requests genuinely interleave inside the build loop.
 *
 * `refs` counts the in-flight calls holding an entry and `evicted` records that it has left the
 * cache; the free happens at whichever of the two comes last. Measured through the real
 * `applySourceMaps` path, the difference is a plateau versus linear growth — see
 * `holding a consumer across its eviction does not grow the wasm heap without bound` in
 * `errorHandling.applySourceMaps.test.ts`, which fails if this bookkeeping is removed.
 */
type CachedSourceMap = { consumer: SourceMapConsumer; refs: number; evicted: boolean };

/** Keyed by resolved absolute chunk path, so two frame spellings of one chunk share an entry. */
const sourceMapCache = new Map<string, CachedSourceMap>();

/** Takes an entry out of service; frees it now if nothing is using it, else on the last release. */
function retireConsumer(entry: CachedSourceMap) {
  entry.evicted = true;
  if (entry.refs <= 0) entry.consumer.destroy();
}

/**
 * Borrows a cached consumer, marking it most-recently-used. The caller must hand the entry back to
 * `releaseConsumer`, which is why `applySourceMaps` collects them and releases in a `finally`.
 *
 * NOT named `use…`: `react-hooks/rules-of-hooks` keys off that prefix and reports any such
 * function called in a loop as a misplaced React hook, which is an eslint error in this repo.
 */
function retainConsumer(key: string): CachedSourceMap | undefined {
  const entry = sourceMapCache.get(key);
  if (!entry) return undefined;
  // A Map iterates in insertion order, so re-inserting moves this entry to the young end and the
  // eviction in `storeConsumer` always takes the least recently used.
  sourceMapCache.delete(key);
  sourceMapCache.set(key, entry);
  entry.refs += 1;
  return entry;
}

/** Caches a freshly built consumer, already borrowed by the caller, and evicts down to the bound. */
function storeConsumer(key: string, consumer: SourceMapConsumer): CachedSourceMap {
  // Two calls can miss on the same key concurrently and both build one. Retire the loser rather
  // than dropping the reference, or its wasm mappings are never freed. No `existing !== consumer`
  // arm: this is the only call site and it is only ever reached with a consumer built two lines
  // earlier, so an entry already under this key can never be the one being stored.
  const existing = sourceMapCache.get(key);
  if (existing) {
    sourceMapCache.delete(key);
    retireConsumer(existing);
  }

  const entry: CachedSourceMap = { consumer, refs: 1, evicted: false };
  sourceMapCache.set(key, entry);

  while (sourceMapCache.size > MAX_CACHED_SOURCE_MAPS) {
    const oldestKey = sourceMapCache.keys().next().value as string;
    const oldest = sourceMapCache.get(oldestKey);
    sourceMapCache.delete(oldestKey);
    if (oldest) retireConsumer(oldest);
  }

  return entry;
}

/** Returns a borrowed consumer; frees it if it was evicted while this call held it. */
function releaseConsumer(entry: CachedSourceMap) {
  entry.refs -= 1;
  if (entry.refs <= 0 && entry.evicted) entry.consumer.destroy();
}

/** The build directory, and the only directory this resolver may read from. */
function nextBuildDir(): string {
  return path.resolve(process.cwd(), '.next');
}

/** True when `target` is a path strictly underneath `dir`. Compares text, resolves nothing. */
function isInsideDir(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Turns a `.next`-relative path taken from a stack frame into an absolute path under the build
 * directory, or `null` if it does not name one.
 *
 * The relative part comes out of the frame's file, which on `/api/application-error` is a string
 * the caller supplies, so it is not trusted to stay inside `.next`. Resolving it first and then
 * requiring the result to be under the build directory is what keeps this naming build artifacts:
 * resolution collapses the path to the file it actually names, and the check is made against that.
 *
 * LEXICAL ONLY — it has to be, because it runs over every distinct frame file to pick which ones
 * the cap is spent on, and that count is set by the caller. It is a filter, not the guard: nothing
 * may be READ on the strength of this result alone. `containedRealPath` below is what the reads
 * are gated on.
 *
 * `null` means the caller skips the frame — an unresolvable frame is normal here (a chunk from an
 * older build, a map that was not emitted), so it is not a reason to fail the report.
 */
function resolveBuildArtifact(relativePath: string): string | null {
  const buildDir = nextBuildDir();
  const resolved = path.resolve(buildDir, relativePath);
  return isInsideDir(buildDir, resolved) ? resolved : null;
}

/**
 * Containment as the filesystem will apply it: on the file that gets opened, not on its spelling.
 *
 * `path.relative` compares strings and `fs.readFileSync` follows symlinks, so a lexically
 * contained path can still name a file anywhere on disk — a symlink under `.next` is enough.
 * Resolving with `realpathSync` before the check is what makes "the only directory this resolver
 * may read from" true of the read rather than of the text. BOTH sides are resolved: the build
 * directory itself can sit behind a symlink, and comparing a resolved target against an unresolved
 * root would then reject every legitimate chunk.
 *
 * Returns the real path, or `null` when the file does not exist or resolves outside the build
 * directory. Both mean the caller skips that frame — a missing chunk is the ordinary case (an
 * older build, a map that was not emitted), so this never throws.
 *
 * `realRoot` is resolved ONCE PER CALL by `realBuildRoot` and threaded in, rather than re-resolved
 * here. This guard runs on every path the resolver is about to open, so re-resolving the root made
 * a fully-cached ten-frame report perform twenty synchronous `realpathSync` calls on the
 * page-serving event loop where it previously performed no IO at all. The guard's behaviour is
 * unchanged: the build directory cannot move mid-call, and a root that does not resolve is still
 * the same "read nothing" outcome, decided once instead of per path.
 */
function containedRealPath(realRoot: string, target: string): string | null {
  try {
    const realTarget = fs.realpathSync(target);
    return isInsideDir(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

/**
 * The build directory as the filesystem resolves it, or `null` when it does not exist — which on
 * this path means the resolver reads nothing, exactly as a per-path `realpathSync` failure did.
 */
function realBuildRoot(): string | null {
  try {
    return fs.realpathSync(nextBuildDir());
  } catch {
    return null;
  }
}

/**
 * Extracts the relative path from a stack trace file path.
 * Handles both /app/.next/... and .../_next/... formats.
 */
function extractNextPath(filePath: string): string | null {
  // Handle /app/.next/server/chunks/123.js format
  const appNextMatch = filePath.match(/\.next\/(.+)$/);
  if (appNextMatch) return appNextMatch[1];

  // Handle /_next/... format (URLs)
  const underscoreNextMatch = filePath.match(/_next\/(.+)$/);
  if (underscoreNextMatch) return underscoreNextMatch[1];

  return null;
}

/**
 * Loads the source-map content for a built chunk, given its absolute path — which the caller must
 * already have put through `containedRealPath`.
 *
 * Webpack names a chunk's map after the chunk itself (`abc.js` -> `abc.js.map`),
 * but Turbopack (the default bundler in Next 16) gives the map a *different* hash
 * and links it only through the in-file `//# sourceMappingURL=<name>` comment, so
 * the `<chunk>.js.map` sibling does not exist. We therefore read the chunk, follow
 * its `sourceMappingURL` when present, and fall back to the webpack convention so
 * this keeps working on either bundler.
 */
function loadSourceMapContent(realRoot: string, chunkPath: string): string | null {
  // Preferred: follow the chunk's own sourceMappingURL (covers Turbopack + webpack).
  try {
    const chunkContent = fs.readFileSync(chunkPath, 'utf-8');
    const match = chunkContent.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/);
    if (match) {
      const url = match[1];
      if (url.startsWith('data:')) {
        const base64 = url.match(/;base64,(.*)$/);
        if (base64) return Buffer.from(base64[1], 'base64').toString('utf-8');
      } else {
        // The URL is read out of a file that a frame selected, so it gets the same containment
        // rule the frame did — it is no more trusted than the path that led here. `null` covers
        // both "escapes the build directory" and "does not exist", so no `existsSync` is needed.
        const mapPath = containedRealPath(realRoot, path.resolve(path.dirname(chunkPath), url));
        if (mapPath) return fs.readFileSync(mapPath, 'utf-8');
      }
    }
  } catch {
    // Chunk not readable; fall through to the convention-based lookup.
  }

  // Fallback: webpack convention `<chunk>.map` next to the chunk. Contained-checked too: the
  // sibling of a legitimate chunk is still a path, and a path can still be a symlink.
  try {
    const fallbackPath = containedRealPath(realRoot, `${chunkPath}.map`);
    if (fallbackPath) return fs.readFileSync(fallbackPath, 'utf-8');
  } catch {
    // Ignore; no map available.
  }

  return null;
}

/**
 * Normalizes a source-map `source` URL to a clean project-relative path so the
 * resolved stack reads the same regardless of bundler. Webpack emits
 * `webpack://_N_E/../src/...`; Turbopack emits `turbopack:///[project]/src/...`.
 */
function normalizeSourcePath(source: string): string {
  return source
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^turbopack:\/\/\/\[project\]\//, '')
    .replace(/^turbopack:\/\//, '')
    .replace(/^\.\.?\//, '');
}

/**
 * Applies source maps to a minified stack trace to get original source locations.
 * Only works in production where source maps are available in the .next directory.
 * @param stack - The minified stack trace string
 * @returns The stack trace with original source locations
 */
export async function applySourceMaps(stack: string): Promise<string> {
  // Every cache entry this call borrowed, released in `finally` so an early return or a throw
  // cannot leave one pinned — a pinned entry is never freed, which is the leak this bookkeeping
  // exists to close.
  const borrowed: CachedSourceMap[] = [];
  try {
    const parsedStack = parseStackTrace(stack);
    const lines = stack.split('\n');

    // Resolved ONCE for the whole call, not per path. See `containedRealPath`.
    const realRoot = realBuildRoot();
    if (!realRoot) return stack;

    // 🔴 SPEND THE CAP ON FRAMES THAT CAN ACTUALLY BE RESOLVED. Slicing the raw distinct-file list
    // would let a frame the resolver is always going to reject — a browser extension, an analytics
    // or payment script, anything not under the build directory — take a cap slot from a real app
    // chunk further down, which then comes back minified. That is not a corner case: the stacks
    // that reach this function are the ones a browser caller of `reportApplicationError` sent as
    // the error's OWN stack, and a browser stack whose top frames belong to injected third-party
    // code is ordinary. (The error-boundary path is not one of those callers — it sends either a
    // React componentStack or `resolveStack: false` — so this is about the ones that are.)
    //
    // Both filters below are pure path work — a regex and `path.resolve`/`path.relative`, no IO —
    // so running them over the distinct files costs nothing worth bounding, and the loop stops as
    // soon as the cap is full. Containment is re-checked against the real path at read time; see
    // `containedRealPath`.
    const resolvableFrames: { file: string; chunkPath: string }[] = [];
    for (const file of [...new Set(parsedStack.map((x) => x.file).filter(Boolean))] as string[]) {
      const relativePath = extractNextPath(file);
      if (!relativePath) continue;

      const chunkPath = resolveBuildArtifact(relativePath);
      if (!chunkPath) continue;

      resolvableFrames.push({ file, chunkPath });
      if (resolvableFrames.length >= MAX_RESOLVED_FRAME_FILES) break;
    }

    // Build a map of relative paths to their source map consumers
    const sourceMapConsumers = new Map<string, SourceMapConsumer>();

    for (const { file, chunkPath: candidatePath } of resolvableFrames) {
      try {
        // The guard the reads are gated on. `resolveBuildArtifact` compared text; this compares
        // the paths the filesystem will actually open.
        const chunkPath = containedRealPath(realRoot, candidatePath);
        if (!chunkPath) continue;

        const cached = retainConsumer(chunkPath);
        if (cached) {
          borrowed.push(cached);
          sourceMapConsumers.set(file, cached.consumer);
          continue;
        }

        const sourceMapContent = loadSourceMapContent(realRoot, chunkPath);
        if (sourceMapContent) {
          const smc = await new SourceMapConsumer(sourceMapContent);
          borrowed.push(storeConsumer(chunkPath, smc));
          sourceMapConsumers.set(file, smc);
        }
      } catch {
        // Skip files where source map can't be read
      }
    }

    // Apply source maps to each stack frame
    for (const frame of parsedStack) {
      const { methodName, lineNumber, column, file } = frame;
      if (!file || lineNumber == null || column == null) continue;

      const smc = sourceMapConsumers.get(file);
      if (!smc) continue;

      const pos = smc.originalPositionFor({ line: lineNumber, column });
      if (pos && pos.line != null && pos.source != null) {
        const name = pos.name || methodName || '<anonymous>';
        const lineIndex = lines.findIndex((x) => x.includes(file) && x.includes(`:${lineNumber}:`));
        if (lineIndex > -1) {
          const displayName = name !== '<unknown>' ? name : '';
          const sourcePath = normalizeSourcePath(pos.source);
          lines[lineIndex] = `    at ${displayName} (${sourcePath}:${pos.line}:${pos.column ?? 0})`;
        }
      }
    }

    // Consumers are NOT destroyed here — they belong to the cache, which frees each one at
    // whichever comes last of its eviction and the last call releasing it. Destroying one here
    // would hand the next call a consumer whose mappings have to be re-parsed, and that re-parse
    // is what allocates wasm memory nothing will ever free.

    return lines.join('\n');
  } catch {
    // If source map parsing fails, return the original stack
    return stack;
  } finally {
    for (const entry of borrowed) releaseConsumer(entry);
  }
}
