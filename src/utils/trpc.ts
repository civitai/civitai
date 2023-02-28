// src/utils/trpc.ts
import { QueryClient } from '@tanstack/react-query';
import { httpBatchLink, httpLink, loggerLink, splitLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';

const url = '/api/trpc';

export const trpc = createTRPCNext<AppRouter>({
  config() {
    return {
      queryClient: new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: false,
            staleTime: Infinity,
          },
        },
      }),
      transformer: superjson,
      links: [
        loggerLink({
          enabled: (opts) => isDev || (opts.direction === 'down' && opts.result instanceof Error),
        }),
        splitLink({
          condition: (op) => op.context.skipBatch === true,
          // when condition is true, use normal request
          true: httpLink({ url }),
          // when condition is false, use batching
          false: httpBatchLink({ url, maxURLLength: 2083 }),
        }),
      ],
    };
  },
  ssr: false,
});
