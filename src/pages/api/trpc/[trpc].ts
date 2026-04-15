// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { withAxiom } from '@civitai/next-axiom';
import { isProd } from '~/env/other';
import { createContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
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
  responseMeta: ({ ctx, type }) => {
    const headers: Record<string, string> = {};
    const willEdgeCache = ctx?.cache && !!ctx?.cache.edgeTTL && ctx?.cache.edgeTTL > 0;
    if (willEdgeCache && type === 'query') {
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
          name: error.name,
          code: error.code,
          message: error.message,
          stack: error.stack,
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
export default withAxiom((req, res) => {
  restoreMethodOverride(req);
  return trpcHandler(req, res);
});
