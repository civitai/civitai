// src/utils/trpc.ts
import { QueryClient } from '@tanstack/react-query';
import { httpBatchLink, httpLink, loggerLink, splitLink, TRPCLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';
import { isAuthed } from '~/providers/CivitaiSessionProvider';

const url = '/api/trpc';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: Infinity,
    },
  },
});

const authedCacheBypassLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    if (isAuthed && op.input) (op.input as any).authed = true;
    return next(op);
  };
};

export const trpc = createTRPCNext<AppRouter>({
  config() {
    return {
      queryClient,
      transformer: superjson,
      links: [
        authedCacheBypassLink,
        loggerLink({
          enabled: (opts) => isDev || (opts.direction === 'down' && opts.result instanceof Error),
        }),
        splitLink({
          // condition: (op) => op.context.skipBatch === true,
          condition: (op) => op.context.skipBatch !== false,
          // when condition is true, use normal request
          true: httpLink({ url }),
          // when condition is false, use batching
          false: httpBatchLink({ url, maxURLLength: 2083 }),
          // false: httpLink({ url }), // Let's disable batching for now
        }),
      ],
    };
  },
  ssr: false,
});
