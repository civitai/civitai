// src/utils/trpc.ts
import { QueryClient } from '@tanstack/react-query';
import { httpLink, loggerLink, splitLink, TRPCLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';
import { env } from '~/env/client.mjs';

const url = '/api/trpc';
const headers = {
  'x-client-version': process.env.version,
  'x-client-date': Date.now().toString(),
  'x-client': 'web',
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
      staleTime: Infinity,
    },
  },
});

const authedCacheBypassLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    const isAuthed = typeof window !== undefined ? window.isAuthed : false;
    return next({ ...op, input: isAuthed && op.input ? { ...op.input, authed: true } : op.input });
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
          enabled: (opts) =>
            (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
            (opts.direction === 'down' && opts.result instanceof Error),
        }),
        splitLink({
          // do not batch post requests
          condition: (op) => (op.type === 'query' ? op.context.skipBatch === true : true),
          // when condition is true, use normal request
          true: httpLink({ url, headers }),
          // when condition is false, use batching
          // false: unstable_httpBatchStreamLink({ url, maxURLLength: 2083 }),
          false: httpLink({ url, headers }), // Let's disable batching for now
        }),
      ],
    };
  },
  ssr: false,
});
