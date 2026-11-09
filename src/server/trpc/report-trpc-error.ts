import type { TRPCError } from '@trpc/server';
import { isProd } from '~/env/other';
import { buildCentralErrorLog, logToAxiom, wasServerFaultLogged } from '~/server/logging/client';
import { redactBlockTokens } from '~/server/logging/redact-block-token';
import {
  recordTrpcError,
  recordUnloggedTrpcClientError,
  shouldSkipExpectedNotFoundLog,
} from '~/server/prom/http-errors';
import { measureJsonLength } from '~/server/schema/blocks/json-length';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { isClientAbortError } from '~/server/utils/errorHandling';

/**
 * The longest input an error log line carries: in JSON characters, and in values (so the measure
 * that checks it stays cheap next to the log line). A longer input is logged as a marker.
 */
const LOGGED_INPUT_MAX_CHARS = 256 * 1024;
const LOGGED_INPUT_MAX_VALUES = 16 * 1024;
const LOGGED_INPUT_OVER_LIMIT = `[input over ${LOGGED_INPUT_MAX_CHARS} characters or ${LOGGED_INPUT_MAX_VALUES} values, not logged]`;

export type ReportTrpcErrorOptions = {
  error: TRPCError;
  type: string;
  path: string | undefined;
  input: unknown;
  userId: number | undefined;
  userAgent: string | undefined;
  /** Extra fields for the log line, e.g. which half of a combined read failed. */
  detail?: Record<string, unknown>;
};

/**
 * How a failed procedure is counted and logged: the 5xx counter, then the Axiom line (prod) or the
 * console (dev). The tRPC route's `onError` calls this for every thrown procedure error; a
 * procedure that answers a failed PART of its read as data instead of throwing (so the rest of
 * the answer still reaches the client) calls it for that part, so the failure is surfaced
 * exactly as a thrown one would be.
 */
export async function reportTrpcError({
  error,
  type,
  path,
  input,
  userId,
  userAgent,
  detail,
}: ReportTrpcErrorOptions): Promise<void> {
  // A client disconnect is not a server fault — see the same check in the route's `onError`.
  if (isClientAbortError(error)) return;

  // Unsampled per-procedure 5xx attribution (no-ops for 4xx-class errors).
  // Source of truth for the tRPC slice of the 5xx SLO; see http-errors.ts.
  recordTrpcError(error, path);

  if (isProd) {
    // Uninformative 404s. `image.getGenerationData` answers NOT_FOUND only when the image id
    // does not exist or `image.get` would not show it to this viewer (an image without generation metadata still returns normally). Most of
    // that volume comes from clients calling the procedure directly to enumerate ids, and at
    // that rate its lines were most of this route's Axiom ingest, each paying
    // JSON.stringify(input) + an ingest for a line that says nothing the 404 doesn't.
    //
    // Narrow by construction: `shouldSkipExpectedNotFoundLog` matches only the exact
    // (path, code) pairs in `EXPECTED_NOT_FOUND_LOG_SKIPS`, so every other procedure's
    // NOT_FOUND, and every other code on this procedure, is still logged below.
    //
    // The signal is not lost: `recordTrpcError` above counts only 5xx, so the skipped errors
    // are counted by `recordUnloggedTrpcClientError` instead (see its comment in http-errors.ts).
    if (shouldSkipExpectedNotFoundLog(path, error)) {
      recordUnloggedTrpcClientError(error, path);
      return;
    }

    // Auth-class rejections (FORBIDDEN / UNAUTHORIZED) are client-fault 4xx
    // responses — the status code already tells the caller + edge what
    // happened, and at scraper/bot scale these are the dominant noise in
    // Axiom while providing zero diagnostic value. Skip the stack capture +
    // JSON.stringify + ingest to cut event-loop pressure during the storm.
    //
    // Originally surfaced by recommenders.getResourceRecommendations ("API key
    // does not have the required scope"), but the gate applies uniformly to every
    // auth-rejection path (isAcceptableOrigin, isAuthed, enforceTokenScope,
    // isFlagProtected). Other tRPC errors (Meili timeouts, DB errors, etc.) keep
    // full observability.
    //
    // TOO_MANY_REQUESTS is the heavy-route bulkhead fast-fail (heavyProcedure).
    // It trips precisely during a pile-up, and per-reject stack-capture +
    // stringify + Axiom ingest would add event-loop pressure during the exact
    // storm the bulkhead exists to relieve. The bulkhead's own reject gauge
    // already carries the signal, so skip the ingest here too.
    //
    // SERVICE_UNAVAILABLE is the transient-upstream mapping (orchestrator 5xx /
    // network blip → 503; see workflows.ts). It is retry-able + self-describing,
    // and the continuously-polled `orchestrator.statusUpdate` turns one upstream
    // blip into a sustained wave of 503 rejects — paying full stack-capture +
    // JSON.stringify(input) + Axiom ingest per reject would add event-loop
    // pressure during the exact outage (the same failure mode TOO_MANY_REQUESTS
    // skips for). The 503 status itself and the preserved `cause` already carry
    // the diagnostic signal, so the per-reject ingest is pure event-loop cost —
    // skip it. (This skips ONLY the Axiom ingest: recordTrpcError above still
    // counts the 503, and the client still gets a real 503.)
    if (
      error.code === 'FORBIDDEN' ||
      error.code === 'UNAUTHORIZED' ||
      error.code === 'TOO_MANY_REQUESTS' ||
      error.code === 'SERVICE_UNAVAILABLE'
    ) {
      return;
    }

    let axInput: string | undefined;
    if (!!input) {
      try {
        // Measured before it is serialized, without building the string; an input over the
        // limits is logged as a marker instead. An unserializable one throws below, as before.
        const meter = { visits: 0, chars: 0, scanned: 0, maxVisits: LOGGED_INPUT_MAX_VALUES };
        if (measureJsonLength([input], LOGGED_INPUT_MAX_CHARS, { meter }) === 'over') {
          axInput = LOGGED_INPUT_OVER_LIMIT;
        } else {
          // Bearer fields (`blockToken`, `shareToken`) are replaced, key kept — see redactBlockTokens.
          // Stringify first and redact only when the key appears, so only an input that carries
          // one is serialized twice.
          const raw = JSON.stringify(input);
          axInput =
            raw?.includes('"blockToken"') || raw?.includes('"shareToken"')
              ? JSON.stringify(redactBlockTokens(input))
              : raw;
        }
      } catch {
        axInput = undefined;
      }
    } else {
      axInput = undefined;
    }

    // Everything reaching here is either a genuine server fault
    // (INTERNAL_SERVER_ERROR / TIMEOUT — the invisible raw-500 class) or a
    // remaining client-fault 4xx (BAD_REQUEST / NOT_FOUND / CONFLICT /
    // PRECONDITION_FAILED); FORBIDDEN/UNAUTHORIZED/TOO_MANY_REQUESTS/
    // SERVICE_UNAVAILABLE, and the allowlisted 404s, already returned
    // above. buildCentralErrorLog un-masks
    // the `.cause` chain for server faults and tags severity `type:'error'` (so
    // 500s are queryable as detected_level="error"), while tagging the client-
    // fault 4xx `type:'info'` so they stay out of the error stream. Behavior is
    // unchanged: this only shapes the log line — the client still gets its
    // original response.
    //
    // MERGE ORDER (crux): the tRPC OPERATION type (query/mutation) is preserved
    // under `trpcType`, and buildCentralErrorLog is spread LAST so its severity
    // `type` wins in the final JSON — otherwise the op-type `type` would clobber
    // the severity and the pipeline would read `type:"query"` → detected_level
    // stays "unknown" (still invisible).
    //
    // Skip if the fault was ALREADY logged by a router that logs+re-throws (e.g.
    // orchestrator what-if) so we don't double-emit; recordTrpcError above still
    // counts it either way. A masked error is logged regardless: the user was shown
    // its `errorRef`, and the router's own log line doesn't carry one.
    const errorRef = getClientSafeError(error)?.errorRef;
    if (!wasServerFaultLogged(error) || errorRef) {
      await logToAxiom(
        {
          path,
          trpcType: type,
          user: userId,
          browser: userAgent,
          input: axInput,
          errorRef,
          ...detail,
          ...buildCentralErrorLog(error),
        },
        'civitai-prod'
      );
    }
  } else {
    const errorRef = getClientSafeError(error)?.errorRef;
    console.error(
      `❌ tRPC failed on ${path ?? 'unknown'}${errorRef ? ` (ref: ${errorRef})` : ''}${
        detail ? ` ${JSON.stringify(detail)}` : ''
      }`
    );
    console.error(error);
  }
}
