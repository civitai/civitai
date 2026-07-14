// App shim for @civitai/axiom. The package owns its env schema (incl. PODNAME and
// LOG_ERRORS_TO_STDOUT) plus the logToAxiom/safeError implementations; the app instantiates the
// logger, re-exports the shared names, and keeps the TRPC-aware fault helpers here (they depend on
// @trpc/server, an app concern, not the app-agnostic package).
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { createAxiomLogger, safeError } from '@civitai/axiom/client';
import { env } from '~/env/server';

// The build guard is a Next.js concern, so it lives here in the app shim — not in
// the app-agnostic @civitai/axiom package. Skip the client during `next build`.
const noopLog = async (_data: MixedObject, _datastream?: string) => {};

export const logToAxiom = env.IS_BUILD ? noopLog : createAxiomLogger().logToAxiom;
export { safeError };

/**
 * TRPCError codes that represent a CLIENT fault — i.e. normal user-feedback that
 * a request was rejected (bad input, not allowed, not found, rate-limited, etc.).
 * These are NOT incidents and must never be logged at error severity, or they
 * drown out the real server-side failures on the error board.
 *
 * Everything NOT in this set (notably INTERNAL_SERVER_ERROR, TIMEOUT) — and any
 * non-TRPCError thrown value — is treated as a SERVER fault worth an error log.
 */
const CLIENT_FAULT_TRPC_CODES: ReadonlySet<TRPC_ERROR_CODE_KEY> = new Set([
  'BAD_REQUEST',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'TOO_MANY_REQUESTS',
  'CONFLICT',
  'PRECONDITION_FAILED',
]);

/**
 * Classify a thrown value as a client fault (expected user feedback) or a server
 * fault (a real failure worth an error log). A non-TRPCError is always a server
 * fault — there was no deliberate validation rejection, so the cause is unknown.
 */
export function classifyErrorFault(e: unknown): 'client' | 'server' {
  if (e instanceof TRPCError && CLIENT_FAULT_TRPC_CODES.has(e.code)) return 'client';
  return 'server';
}

/**
 * Build the `error` field for a server-fault log entry, UN-MASKING the underlying
 * cause.
 *
 * `errorHandling.ts` rewrites the user-facing message to a generic
 * "An unexpected error ocurred..." but preserves the original error on `.cause`
 * (see `throwDbError` / `throwInternalServerError` / `handleTRPCError`). Logging
 * only the masked TRPCError therefore hides the actual failure. This walks to the
 * cause so the diagnosable signal (the original message + stack + Prisma code)
 * lands in the log alongside the surfaced TRPCError.
 */
export function buildServerFaultErrorLog(e: unknown): MixedObject {
  if (e instanceof TRPCError) {
    return {
      code: e.code,
      name: e.name,
      message: e.message,
      stack: e.stack,
      // The pre-mask original — carries the real message/stack/Prisma code.
      cause: safeError(e.cause),
    };
  }
  // Non-TRPCError: log the full error directly (already the real failure).
  return safeError(e) ?? { message: String(e) };
}

/**
 * Build the structured log payload for an error caught at a CENTRAL 500-emitting
 * chokepoint (the tRPC `onError` handler, the REST `handleEndpointError`). This is
 * the generalization of the per-router pattern in `orchestrator.router.ts` so that
 * EVERY unexpected 500 becomes self-describing and queryable the normal way
 * (`{namespace="civitai-dp-prod"} | detected_level="error"`), instead of needing a
 * raw `|= "TRPCError"` stdout grep + a Tempo dig to root-cause it.
 *
 *  - SERVER fault (INTERNAL_SERVER_ERROR / TIMEOUT / any non-TRPCError) → carries
 *    the UN-MASKED `.cause` chain (real message + stack + Prisma code) and
 *    severity `type: 'error'`.
 *  - CLIENT fault (BAD_REQUEST / NOT_FOUND / CONFLICT / PRECONDITION_FAILED that
 *    still reach the chokepoint) → the light `safeError` shape + `type: 'info'`,
 *    so normal user-feedback rejections never flood the error stream.
 *
 * SEVERITY FIELD: the Alloy→Loki pipeline (`prometheus-stack/alloy.yaml`,
 * `civitai_logs`) extracts **`type`** as the log level — `level` is NOT read (it
 * doesn't exist in the payload). So `type` is the load-bearing field that makes a
 * line land as `detected_level="error"`; this matches the codebase convention
 * (`orchestrator.router.ts` what-if logs `type:'error'`/`type:'info'`). `level` is
 * emitted too as a harmless belt-and-suspenders duplicate.
 *
 * PII/secrets: the payload only ever contains the primitive error fields that
 * `safeError` extracts (name/message/stack/code + the walked cause) — no request
 * body or tokens are added here. Callers append their own request context.
 */
export function buildCentralErrorLog(
  e: unknown
): MixedObject & { type: 'error' | 'info'; level: 'error' | 'info' } {
  const fault = classifyErrorFault(e);
  const severity = fault === 'server' ? 'error' : 'info';
  const base =
    fault === 'server' ? buildServerFaultErrorLog(e) : safeError(e) ?? { message: String(e) };
  return {
    ...base,
    type: severity, // load-bearing: Alloy extracts `type` → Loki detected_level
    level: severity, // belt-and-suspenders; not read by the pipeline
    // Surface the tRPC code for client-fault entries too (safeError omits it for a
    // TRPCError whose own `.code` field is not the JS `Error.code`); harmless
    // duplicate of the server-fault branch, which already carries it.
    ...(e instanceof TRPCError ? { code: e.code } : null),
  };
}

/**
 * Best-effort dedup for errors that a router/service ALREADY logged as a server
 * fault (via `buildServerFaultErrorLog`) before re-throwing — e.g.
 * `orchestrator.router.ts` what-if. Without this the central chokepoints would log
 * the same fault a SECOND time. Keyed on the thrown object identity (a WeakSet, so
 * GC reclaims entries — no leak). Only reliable when the SAME error reference
 * bubbles to the chokepoint (the common case: a pre-existing TRPCError passes
 * through tRPC unchanged); a raw non-TRPCError that tRPC re-wraps is not matched,
 * which is acceptable (rare + still correctly attributed).
 */
const alreadyLoggedServerFaults = new WeakSet<object>();
export function markServerFaultLogged(e: unknown): void {
  if (e !== null && typeof e === 'object') alreadyLoggedServerFaults.add(e as object);
}
export function wasServerFaultLogged(e: unknown): boolean {
  return e !== null && typeof e === 'object' && alreadyLoggedServerFaults.has(e as object);
}
