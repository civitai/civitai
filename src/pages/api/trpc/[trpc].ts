// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
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

/**
 * Middleware: translate POST-with-override back to GET for tRPC query resolution.
 * The client sends large queries as POST with `x-trpc-method-override: GET` to
 * avoid HTTP 431. We restore the original method and move the body to `req.query`
 * so tRPC resolves it as a query with full cache support on the client.
 */
function restoreMethodOverride(req: import('next').NextApiRequest) {
  if (req.method === 'POST' && req.headers['x-trpc-method-override'] === 'GET') {
    req.method = 'GET';
    if (req.body != null) {
      const input = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      // req.query already has `trpc` (the path); add `input` so tRPC reads it
      (req.query as Record<string, string>).input = input;
      req.body = undefined;
    }
    // Clean up override headers so they don't confuse downstream handlers
    delete req.headers['x-trpc-method-override'];
    delete req.headers['content-type'];
  }
}

const trpcHandler = createNextApiHandler({
  router: appRouter,
  createContext,
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
      if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED') {
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
//
// withAxiom is overloaded with `(param: NextConfig): NextConfig` declared first.
// With an untyped arrow, TS can't cleanly resolve the API-handler overload
// (Next 16's stricter route types turn the ambiguity into a hard error). Typing
// the params explicitly forces the `AxiomApiHandler` overload, and the async
// body gives an explicit `Promise<void>` return. The result is still asserted to
// NextApiHandler for the generated route-type validator.
export default withAxiom(async (req: NextApiRequest, res: NextApiResponse) => {
  restoreMethodOverride(req);
  await trpcHandler(req, res);
}) as NextApiHandler;
