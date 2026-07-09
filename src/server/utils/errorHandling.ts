import { Prisma } from '@prisma/client';
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

const prismaErrorToTrpcCode: Record<string, TRPC_ERROR_CODE_KEY> = {
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
 * Loads the source-map content for a built chunk, given its `.next`-relative path
 * (e.g. `static/chunks/abc.js`).
 *
 * Webpack names a chunk's map after the chunk itself (`abc.js` -> `abc.js.map`),
 * but Turbopack (the default bundler in Next 16) gives the map a *different* hash
 * and links it only through the in-file `//# sourceMappingURL=<name>` comment, so
 * the `<chunk>.js.map` sibling does not exist. We therefore read the chunk, follow
 * its `sourceMappingURL` when present, and fall back to the webpack convention so
 * this keeps working on either bundler.
 */
function loadSourceMapContent(relativePath: string): string | null {
  const chunkPath = path.join(process.cwd(), '.next', relativePath);

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
        const mapPath = path.resolve(path.dirname(chunkPath), url);
        if (fs.existsSync(mapPath)) return fs.readFileSync(mapPath, 'utf-8');
      }
    }
  } catch {
    // Chunk not readable; fall through to the convention-based lookup.
  }

  // Fallback: webpack convention `<chunk>.map` next to the chunk.
  try {
    const fallbackPath = `${chunkPath}.map`;
    if (fs.existsSync(fallbackPath)) return fs.readFileSync(fallbackPath, 'utf-8');
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
  try {
    const parsedStack = parseStackTrace(stack);
    const lines = stack.split('\n');

    // Build a map of relative paths to their source map consumers
    const sourceMapConsumers = new Map<string, SourceMapConsumer>();
    const filesToProcess = [...new Set(parsedStack.map((x) => x.file).filter(Boolean))] as string[];

    for (const file of filesToProcess) {
      const relativePath = extractNextPath(file);
      if (!relativePath) continue;

      try {
        const sourceMapContent = loadSourceMapContent(relativePath);
        if (sourceMapContent) {
          const smc = await new SourceMapConsumer(sourceMapContent);
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

    // Clean up source map consumers
    for (const smc of sourceMapConsumers.values()) {
      smc.destroy();
    }

    return lines.join('\n');
  } catch {
    // If source map parsing fails, return the original stack
    return stack;
  }
}
