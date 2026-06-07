// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { withAxiom } from '@civitai/next-axiom';
import { isProd } from '~/env/other';
import { createContext } from '~/server/createContext';
import { logToAxiom, safeError } from '~/server/logging/client';
import { appRouter } from '~/server/routers';

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
      if (
        error.code === 'FORBIDDEN' ||
        error.code === 'UNAUTHORIZED' ||
        error.code === 'TOO_MANY_REQUESTS'
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

      await logToAxiom(
        {
          ...safeError(error),
          code: error.code,
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
export default withAxiom(trpcHandler);
