// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { isProd } from '~/env/other';
import { createContext } from '~/server/createContext';
import { logToAxiom, buildCentralErrorLog } from '~/server/logging/client';
import { recordTrpcError } from '~/server/prom/http-errors';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { appRouter } from '~/server/routers';
import { runWithSerializeCtx, serializeCtxFromRequest } from '~/server/logging/trpc-serialize-log';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '17mb',
    },
  },
};

const trpcHandler = createNextApiHandler({
  router: appRouter,
  createContext,
  // Let large queries arrive as POST (input in the body instead of the URL) to
  // avoid HTTP 431 on long inputs. The client opts in per-query via tRPC's native
  // `methodOverride: 'POST'` (see `src/utils/trpc.ts`); small queries stay GET so
  // the `responseMeta` Cache-Control headers below can still edge-cache them.
  allowMethodOverride: true,
  responseMeta: ({ ctx, type, errors }) => {
    const headers: Record<string, string> = {};
    const willEdgeCache = ctx?.cache && !!ctx?.cache.edgeTTL && ctx?.cache.edgeTTL > 0;
    if (willEdgeCache && type === 'query' && errors.length === 0) {
      ctx.res?.removeHeader('Set-Cookie');
      headers['Cache-Control'] = [
        'public',
        `max-age=${ctx.cache.browserTTL ?? 0}`,
        `s-maxage=${ctx.cache.edgeTTL ?? 0}`,
        `stale-while-revalidate=${ctx.cache.staleWhileRevalidate ?? 0}`,
      ].join(', ');
      if (ctx.cache.tags) headers['Cache-Tag'] = ctx.cache.tags.join(', ');
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
          axInput = JSON.stringify(input);
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
      // SERVICE_UNAVAILABLE already returned above. buildCentralErrorLog un-masks
      // the `.cause` chain for server faults and tags `level:'error'` (so 500s are
      // queryable as detected_level="error"), while tagging the client-fault 4xx
      // `level:'info'` so they stay out of the error stream. Behavior is unchanged:
      // this only shapes the log line — the client still gets its original response.
      await logToAxiom(
        {
          ...buildCentralErrorLog(error),
          path,
          type,
          user: ctx?.user?.id,
          browser: req.headers['user-agent'],
          input: axInput,
        },
        'civitai-prod'
      );
    } else {
      console.error(`❌ tRPC failed on ${path ?? 'unknown'}`);
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
  // Seed the request-scoped procedure-path context so the transformer's serialize
  // step (an awaited descendant of trpcHandler) can name the offending procedure
  // on an oversized/slow serialize. No-op wrapper when the instrument is disabled.
  await runWithSerializeCtx(serializeCtxFromRequest(req), () => trpcHandler(req, res));
}) as NextApiHandler;
