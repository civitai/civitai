// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { isProd } from '~/env/other';
import { createContext } from '~/server/createContext';
import { logToAxiom, buildCentralErrorLog, wasServerFaultLogged } from '~/server/logging/client';
import {
  recordTrpcError,
  recordUnloggedTrpcClientError,
  shouldSkipExpectedNotFoundLog,
} from '~/server/prom/http-errors';
import {
  instrumentTrpcBatchRequest,
  shouldSkipBatchCapLog,
} from '~/server/prom/trpc-batch.metrics';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { appRouter } from '~/server/routers';
import { runWithSerializeCtx, serializeCtxFromRequest } from '~/server/logging/trpc-serialize-log';
import { getTrpcMaxBatchSize } from '~/server/trpc/batch-cap';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { buildTrpcCacheHeaders } from '~/server/trpc/edge-cache-headers';
import { isWebClient } from '~/server/utils/client-version-saturation';
import {
  clientNeedsUpdate,
  peekFreshClientConfig,
  peekSiteAlertsVersion,
} from '~/server/utils/client-config';
import { SITE_ALERTS_VERSION_HEADER } from '~/shared/constants/site-alert.constants';
import { PRIVATE_CACHE_CONTROL } from '~/server/middleware/middleware-utils';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import {
  pinResponseWriteToSuperjson,
  responseWritesDevalue,
  runWithResponseWriteFormat,
} from '~/server/trpc/response-write-format';
import { redactBlockTokens } from '~/server/logging/redact-block-token';
import { measureJsonLength } from '~/server/schema/blocks/json-length';
import { recordBlockTokenGetRequest } from '~/server/prom/block-token-transport.metrics';
import { setTrpcProcedureRegistry } from '~/server/prom/trpc-fast-superjson.metrics';

/**
 * The longest input an error log line carries: in JSON characters, and in values (so the measure
 * that checks it stays cheap next to the log line). A longer input is logged as a marker.
 */
const LOGGED_INPUT_MAX_CHARS = 256 * 1024;
const LOGGED_INPUT_MAX_VALUES = 16 * 1024;
const LOGGED_INPUT_OVER_LIMIT = `[input over ${LOGGED_INPUT_MAX_CHARS} characters or ${LOGGED_INPUT_MAX_VALUES} values, not logged]`;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '17mb',
    },
  },
};

// Bounds the `path` label of the fast-superjson write counter to procedures that exist.
setTrpcProcedureRegistry(appRouter);

const trpcHandler = createNextApiHandler({
  router: appRouter,
  createContext,
  // Let large queries arrive as POST (input in the body instead of the URL) to
  // avoid HTTP 431 on long inputs. The client opts in per-query via tRPC's native
  // `methodOverride: 'POST'` (see `src/utils/trpc.ts`); small queries stay GET so
  // the `responseMeta` Cache-Control headers below can still edge-cache them.
  allowMethodOverride: true,
  // Bound how many procedure calls ONE HTTP request may carry. Batching otherwise decouples
  // request rate from actual work — every request-counting control sees 1 where the server does
  // N — and N is chosen by whoever builds the URL, not by our client bundle. tRPC checks this in
  // `getRequestInfo`, i.e. BEFORE `createContext`, so an over-cap request resolves zero
  // procedures and creates no context.
  //
  // ⚠️ On a GET that means it costs URL parsing and nothing else. On a POST — legitimate here,
  // `allowMethodOverride: true` lets a query carry its input in the body — Next has already
  // parsed the body (up to the 17mb `sizeLimit` above) before this handler runs, and the adapter
  // re-stringifies it before `resolveResponse`; the cap cannot avoid that. What it does avoid is
  // the N-procedure amplification, on both methods.
  //
  // Env-overridable (`TRPC_MAX_BATCH_SIZE`, default = the shared constant), so a correction is a
  // config change rather than a build + canary. The browser's batch link mirrors the compiled-in
  // constant via `maxItems` (see `src/utils/trpc.ts`); tRPC requires the client limit be <= the
  // server's — which is why RAISING this is safe and lowering it below the constant is not. See
  // `getTrpcMaxBatchSize`.
  maxBatchSize: getTrpcMaxBatchSize(),
  responseMeta: ({ ctx, type, errors, info, paths }) => {
    // Single-sourced in `~/server/trpc/edge-cache-headers` so that tests asserting a
    // middleware chain's cache outcome import THAT logic instead of re-declaring it. It also
    // forces `no-store` on block-token queries, keyed on the request's procedure paths.
    const { headers, edgeCached } = buildTrpcCacheHeaders({
      cache: ctx?.cache,
      type,
      errorCount: errors.length,
      paths: info?.calls.map((call) => call.path) ?? paths,
    });
    if (edgeCached) {
      ctx?.res?.removeHeader('Set-Cookie');
      // A cached body is served to the next caller of this URL whatever client it is, so it
      // must be superjson, the format every client reads. See response-write-format.ts.
      pinResponseWriteToSuperjson();
    } else if (responseWritesDevalue() && !headers['Cache-Control']) {
      // A devalue body must never be stored by a shared cache: only a capable web bundle can
      // read it. `applyApiRequestPolicy` (top of the handler) already sets this same private
      // default, but a devalue response must never depend on that ordering, so it is stated
      // here as well for every response written as devalue.
      headers['Cache-Control'] = PRIVATE_CACHE_CONTROL;
    }

    // Set here rather than in a middleware: on a streamed batch the head is written before any
    // procedure finishes. Both read the CLIENT hash value needsUpdate already fetched; no Redis call.
    if (isWebClient(ctx?.req?.headers)) {
      // Never on a response the edge keeps: it would reach current bundles too.
      const client = peekFreshClientConfig();
      if (!edgeCached && client && clientNeedsUpdate(ctx?.req?.headers, client))
        headers['x-update-required'] = 'true';
      const alertsVersion = peekSiteAlertsVersion();
      if (alertsVersion) headers[SITE_ALERTS_VERSION_HEADER] = String(alertsVersion);
    }

    return Object.keys(headers).length > 0 ? { headers } : {};
  },
  onError: async ({ error, type, path, input, ctx, req }) => {
    // Client disconnected mid-procedure (closed tab / scrolled the feed past /
    // navigated away) — the request signal aborted and bubbled an AbortError that
    // tRPC wrapped as INTERNAL_SERVER_ERROR. Not a server fault: skip BOTH the 5xx
    // counter and the Axiom ingest (was ~0.07/s of mislabeled 500s, e.g.
    // image.getInfinite). isClientAbortError walks error.cause for the wrapped abort.
    if (isClientAbortError(error)) return error;

    // Unsampled per-procedure 5xx attribution (no-ops for 4xx-class errors).
    // Source of truth for the tRPC slice of the 5xx SLO; see http-errors.ts.
    recordTrpcError(error, path);

    if (isProd) {
      // Batch-cap rejection (see `maxBatchSize` above). The whole point of the cap is that an
      // over-wide batch resolves no procedures; paying a stack capture +
      // JSON.stringify(input) + an Axiom ingest per reject would put that cost straight back —
      // on the event loop, once per request, during exactly the sustained abuse the cap exists
      // to make cheap. The signal is not lost: `civitai_app_trpc_batch_width` observes every
      // rejected request in its `over_limit="true"` series, with the actual width, which is
      // strictly more useful than a log line whose `input` is always undefined (tRPC rejects
      // before it parses inputs, so there is nothing to log).
      //
      // Narrow by construction — see `shouldSkipBatchCapLog`, which requires BOTH our own
      // per-request over-cap marker AND a BAD_REQUEST code, so it cannot degrade into a blanket
      // BAD_REQUEST skip that would hide real client-fault bugs. An over-cap request produces
      // exactly one onError call (tRPC throws in getRequestInfo, before createContext), so this
      // can only ever suppress the cap rejection itself.
      if (shouldSkipBatchCapLog(req, error)) return error;

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
      // are counted in `civitai_app_trpc_unlogged_client_errors_total{path,code}` instead —
      // `sum by (path)` of their rate over that of `civitai_app_trpc_procedure_duration_seconds_count` is
      // the 404 share (see the counter's comment in http-errors.ts for why both sides aggregate).
      if (shouldSkipExpectedNotFoundLog(path, error)) {
        recordUnloggedTrpcClientError(error, path);
        return error;
      }

      // Auth-class rejections (FORBIDDEN / UNAUTHORIZED) are client-fault 4xx
      // responses — the status code already tells the caller + edge what
      // happened, and at scraper/bot scale these are the dominant noise in
      // Axiom while providing zero diagnostic value. Skip the stack capture +
      // JSON.stringify + ingest to cut event-loop pressure during the storm.
      //
      // Originally surfaced by recommenders.getResourceRecommendations (~5/s
      // cluster-wide of "API key does not have the required scope"), but the
      // gate applies uniformly to every auth-rejection path
      // (isAcceptableOrigin, isAuthed, enforceTokenScope, isFlagProtected).
      // Other tRPC errors (Meili timeouts, DB errors, etc.) keep full
      // observability.
      //
      // TOO_MANY_REQUESTS is the heavy-route bulkhead fast-fail (heavyProcedure).
      // It trips precisely during a pile-up, and per-reject stack-capture +
      // stringify + Axiom ingest would add event-loop pressure during the exact
      // storm the bulkhead exists to relieve. The `civitai_app_heavy_bulkhead_rejects`
      // gauge already carries the signal, so skip the ingest here too.
      //
      // SERVICE_UNAVAILABLE is the transient-upstream mapping (orchestrator 5xx /
      // network blip → 503; see workflows.ts). It is retry-able + self-describing,
      // and the continuously-polled `orchestrator.statusUpdate` turns one upstream
      // blip into a sustained wave of 503 rejects — paying full stack-capture +
      // JSON.stringify(input) + Axiom ingest per reject would add event-loop
      // pressure during the exact outage (the same failure mode TOO_MANY_REQUESTS
      // skips for). The 503 status itself, the preserved `cause`, and the
      // `redis_commands_inflight` cluster gauge already carry the diagnostic
      // signal, so the per-reject ingest is pure event-loop cost — skip it. (This
      // skips ONLY the Axiom ingest: recordTrpcError above still counts the 503 in
      // civitai_app_http_errors_total{status="503"}, and the client still gets a
      // real 503.)
      if (
        error.code === 'FORBIDDEN' ||
        error.code === 'UNAUTHORIZED' ||
        error.code === 'TOO_MANY_REQUESTS' ||
        error.code === 'SERVICE_UNAVAILABLE'
      ) {
        return error;
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
            // `blockToken` (a bearer credential) is replaced, key kept — see redactBlockTokens.
            // Stringify first and redact only when the key appears, so only an input that carries
            // one is serialized twice.
            const raw = JSON.stringify(input);
            axInput = raw?.includes('"blockToken"')
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
            user: ctx?.user?.id,
            browser: req.headers['user-agent'],
            input: axInput,
            errorRef,
            ...buildCentralErrorLog(error),
          },
          'civitai-prod'
        );
      }
    } else {
      const errorRef = getClientSafeError(error)?.errorRef;
      console.error(
        `❌ tRPC failed on ${path ?? 'unknown'}${errorRef ? ` (ref: ${errorRef})` : ''}`
      );
      console.error(error);
    }

    // handleTRPCError(error);

    return error;
  },
});

// export API handler
//
// withAxiom is overloaded with `(param: NextConfig): NextConfig` declared first.
// With an untyped arrow, TS can't cleanly resolve the API-handler overload
// (Next 16's stricter route types turn the ambiguity into a hard error). Typing
// the params explicitly forces the `AxiomApiHandler` overload, and the async
// body gives an explicit `Promise<void>` return. The result is still asserted to
// NextApiHandler for the generated route-type validator. Method-override is
// handled natively by `allowMethodOverride: true` above (main), so no manual
// restore step is needed here.
export default withAxiom(async (req: NextApiRequest, res: NextApiResponse) => {
  // Region block (451), default response headers and the verified-crawler request header: the
  // API policy the proxy middlewares apply on `/api/v1`. `/api/trpc` is not in the proxy matcher,
  // so this call is the ONLY place tRPC gets it; `trpc-route-api-policy.test.ts` pins that.
  if (applyApiRequestPolicy(req, res)) return;

  // Observe batch width BEFORE delegating, so the histogram sees widths that tRPC is about to
  // reject — those requests resolve zero procedures and would otherwise leave no trace at all.
  // The same call marks an over-cap request, which is what arms the onError log-skip above.
  // Cheap by construction (a charCodeAt scan of the already-parsed `trpc` segment, no split)
  // and non-throwing: on any internal failure it reports width 1, which cannot mark a request
  // over-cap, so a broken metric degrades to "log normally" rather than "silently suppress".
  instrumentTrpcBatchRequest(req);

  // Count block-token queries still arriving as GET (token in the URL). Old published SDK dev
  // hosts send them that way and must keep working; this is the signal that gates refusing GET
  // later. Non-throwing, and a no-op for anything that is not a GET carrying `blockToken`.
  recordBlockTokenGetRequest(req);

  // Seed the request-scoped procedure-path context so the transformer's serialize
  // step (an awaited descendant of trpcHandler) can name the offending procedure
  // on an oversized/slow serialize. No-op wrapper when the instrument is disabled.
  //
  // The response write format (superjson vs devalue) is decided per request from the
  // client headers — see `~/server/trpc/response-write-format`.
  await runWithResponseWriteFormat(req.headers, () =>
    runWithSerializeCtx(serializeCtxFromRequest(req), () => trpcHandler(req, res))
  );
}) as NextApiHandler;
