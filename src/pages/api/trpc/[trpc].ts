// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { withAxiom } from 'next-axiom';
import { isDev } from '~/env/other';
import { createContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { handleTRPCError } from '~/server/utils/errorHandling';

const PUBLIC_CACHE_MAX_AGE = 60;
const PUBLIC_CACHE_STALE_WHILE_REVALIDATE = 30;

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
      // only public GET requests are cacheable
      const cacheable = !ctx?.user && type === 'query' && !ctx?.res?.hasHeader('Cache-Control');
      if (cacheable) {
        return {
          headers: {
            'Cache-Control': `public, s-maxage=${PUBLIC_CACHE_MAX_AGE}, stale-while-revalidate=${PUBLIC_CACHE_STALE_WHILE_REVALIDATE}`,
          },
        };
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
