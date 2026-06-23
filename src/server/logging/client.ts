import { Client } from '@axiomhq/axiom-node';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { isProd } from '~/env/other';
import { env } from '~/env/server';

const shouldConnect = !env.IS_BUILD && env.AXIOM_TOKEN && env.AXIOM_ORG_ID;
const axiom = shouldConnect
  ? new Client({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID,
    })
  : null;

/**
 * Extract only safe primitive fields from an error for logging.
 *
 * Logging raw error objects (especially from axios or AWS SDK) blows up the
 * Axiom schema because each unique key in `.config`, `.headers`, `.cause`,
 * `.$metadata`, `.config.data._readableState`, etc. becomes a separate field.
 * Always pass errors through this helper before logging them.
 */
export function safeError(e: unknown): MixedObject | undefined {
  if (e == null) return undefined;
  if (e instanceof Error) {
    const anyErr = e as { code?: unknown; cause?: unknown };
    const cause = anyErr.cause;
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      code: anyErr.code,
      causeMessage:
        cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined,
    };
  }
  return { message: String(e) };
}

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

export async function logToAxiom(data: MixedObject, datastream?: string) {
  const sendData = { pod: env.PODNAME, ...data };
  if (isProd) {
    datastream ??= env.AXIOM_DATASTREAM;

    // Write stderr BEFORE the Axiom-null/datastream guards (and before awaiting
    // Axiom) — Loki ingest depends on this stderr line, so it must fire even when
    // no Axiom client is configured (preview envs use a placeholder token → axiom
    // is null) or when Axiom is degraded (ingestEvents rejects and the rest of this
    // function never runs). Without this ordering, preview tRPC 500s never reach
    // Loki, and the Grafana alerts that consume `{ "name": "sysredis-fail-open",
    // ... }` go silent during the exact multi-service incident class they exist to
    // handle (sysRedis + Axiom both down). `_axiom: datastream` may be undefined in
    // previews (no AXIOM_DATASTREAM) — JSON.stringify drops it; the line still
    // carries message/stack/code/path.
    //
    // ALWAYS-ON (Phase 1 of the Axiom→Loki migration): this structured line is the
    // durable, queryable sink — stdout/stderr → Alloy → Loki, queried by name via
    // `{namespace="civitai-dp-prod"} | json | name="…"`. It used to be gated behind
    // `LOG_ERRORS_TO_STDOUT==='true'` (a blunt, temporary per-deployment flag flipped
    // on dp-prod-api to read diagnostics); the gate is removed so every event lands
    // in Loki by default while Axiom dual-write below continues during the transition.
    // Volume/noise control belongs in the Alloy `civitai_logs` pipeline (sample/drop
    // stages + line-size cap), not an app-side gate.
    //
    // SERIALIZATION GUARD: this write is now UNCONDITIONAL and `logToAxiom` is called
    // (often `await`ed) on hot paths — the central tRPC 500 handler, payment webhooks,
    // upload endpoints — with arbitrary `data`/`error` objects. `JSON.stringify` THROWS
    // on BigInt values and circular references, so an unguarded stringify here could
    // propagate into a request path that previously never hit this line. Contain it: a
    // serialization failure must NEVER break the caller. On failure emit a minimal,
    // stringify-safe fallback so the event isn't silently lost; the fallback is itself
    // wrapped so it can't throw either.
    try {
      console.error(JSON.stringify({ _axiom: datastream, ...sendData }));
    } catch (err) {
      try {
        console.error(
          JSON.stringify({
            _axiom: datastream,
            name: (sendData as MixedObject)?.name,
            _stringifyError: String(err),
          })
        );
      } catch {
        console.error('logToAxiom: failed to serialize event', (sendData as MixedObject)?.name);
      }
    }

    if (!axiom) return;
    if (!datastream) return;
    await axiom.ingestEvents(datastream, sendData);
  } else {
    console.log('logToAxiom', sendData);
  }
}
