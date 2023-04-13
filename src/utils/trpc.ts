// src/utils/trpc.ts
import { QueryClient } from '@tanstack/react-query';
import { httpBatchLink, HTTPHeaders, httpLink, loggerLink, splitLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';
import { isAuthed } from '~/components/CivitaiWrapped/CivitaiSessionProvider';

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

export const trpc = createTRPCNext<AppRouter>({
  config() {
    const headers = () => {
      const headers: HTTPHeaders = {};
      if (isAuthed) headers['Cache-Control'] = 'no-cache';
      return headers;
    };

    return {
      queryClient,
      transformer: superjson,
      links: [
        loggerLink({
          enabled: (opts) => isDev || (opts.direction === 'down' && opts.result instanceof Error),
        }),
        splitLink({
          condition: (op) => op.context.skipBatch === true,
          // when condition is true, use normal request
          true: httpLink({ headers, url }),
          // when condition is false, use batching
          false: httpBatchLink({ headers, url, maxURLLength: 2083 }),
        }),
      ],
    };
  },
  ssr: false,
});
