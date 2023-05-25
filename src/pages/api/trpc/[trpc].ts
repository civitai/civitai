// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { withAxiom } from 'next-axiom';
import { isDev } from '~/env/other';
import { createContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { handleTRPCError } from '~/server/utils/errorHandling';

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
    // onError: isDev
    //   ? ({ path, error }) => {
    //       console.error(`❌ tRPC failed on ${path}: ${error}`);
    //     }
    //   : undefined,
    onError: ({ error, type, path, input, ctx, req }) => {
      if (isDev) {
        console.error(`❌ tRPC failed on ${path}`);
        console.error(error);
      }
      handleTRPCError(error);
    },
  })
);
