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
      sizeLimit: '10mb',
    },
  },
};

// export API handler
export default withAxiom(
  createNextApiHandler({
    router: appRouter,
    createContext,
    responseMeta: ({ ctx, type }) => {
      const willEdgeCache = ctx?.cache && !!ctx?.cache.edgeTTL && ctx?.cache.edgeTTL > 0;
      if (willEdgeCache && type === 'query') {
        ctx.res?.removeHeader('Set-Cookie');
        const headers: Record<string, string> = {
          'Cache-Control': [
            'public',
            `max-age=${ctx.cache.browserTTL ?? 0}`,
            `s-maxage=${ctx.cache.edgeTTL}`,
            `stale-while-revalidate=${ctx.cache.staleWhileRevalidate}`,
          ].join(', '),
        };
        if (ctx.cache.tags) headers['Cache-Tag'] = ctx.cache.tags.join(', ');
        return { headers };
      }

      return {};
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
        console.error(`❌ tRPC failed on ${path}`);
        console.error(error);
      }

      // handleTRPCError(error);

      return error;
    },
  })
);
