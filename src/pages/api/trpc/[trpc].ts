// src/pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { env } from '~/env/server.mjs';
import { createContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';

const PUBLIC_CACHE_MAX_AGE = 60;
const PUBLIC_CACHE_STALE_WHILE_REVALIDATE = 30;

// export API handler
export default createNextApiHandler({
  router: appRouter,
  createContext,
  responseMeta: ({ ctx, type }) => {
    // only public GET requests are cacheable
    const cacheable = !ctx?.user && type === 'query';
    if (cacheable) {
      return {
        headers: {
          'Cache-Control': `public, s-maxage=${PUBLIC_CACHE_MAX_AGE}, stale-while-revalidate=${PUBLIC_CACHE_STALE_WHILE_REVALIDATE}`,
        },
      };
    }

    return {};
  },
  onError:
    env.NODE_ENV === 'development'
      ? ({ path, error }) => {
          console.error(`❌ tRPC failed on ${path}: ${error}`);
        }
      : undefined,
});
