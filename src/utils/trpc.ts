// src/utils/trpc.ts
import { QueryClient } from '@tanstack/react-query';
import type { TRPCLink } from '@trpc/client';
import { createTRPCProxyClient, httpLink, loggerLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import type { NextPageContext } from 'next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';
import { env } from '~/env/client';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';

type RequestHeaders = {
  'x-client-date': string;
  'x-client': string;
  'x-client-version'?: string;
  'x-fingerprint'?: string;
};

const url = '/api/trpc';
const headers: RequestHeaders = {
  'x-client-version': process.env.version,
  'x-client-date': Date.now().toString(),
  'x-client': 'web',
};

/** Check if an error is from an aborted request (expected with abortOnUnmount) */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof Error && error.message.includes('aborted')) return true;
  return false;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isAbortError(error)) return false;
        return failureCount < 1;
      },
      staleTime: Infinity,
    },
  },
});

const authedCacheBypassLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    const isAuthed = typeof window !== 'undefined' ? window.isAuthed : false;
    const authed = removeEmpty({ authed: isAuthed || undefined });
    const input = { ...(op.input as any), ...authed };

    return next({ ...op, input });
  };
};

/**
 * Get headers for each request
 * @see https://trpc.io/docs/v10/client/headers
 */
function getHeaders(ctx?: NextPageContext) {
  return function () {
    const mergedHeaders = { ...ctx?.req?.headers, ...headers };
    if (typeof window === 'undefined') return mergedHeaders;
    const fingerprint = window.localStorage.getItem('fingerprint') ?? '';

    return {
      ...mergedHeaders,
      'x-fingerprint': fingerprint ? JSON.parse(fingerprint) : undefined,
    };
  };
}

export const trpcVanilla = createTRPCProxyClient<AppRouter>({
  transformer: superjson,
  links: [
    authedCacheBypassLink,
    loggerLink({
      enabled: (opts) =>
        (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
        (opts.direction === 'down' && opts.result instanceof Error && !isAbortError(opts.result)),
    }),
    httpLink({
      url,
      headers: getHeaders(),
    }),
  ],
});

export const trpc = createTRPCNext<AppRouter>({
  config(opts) {
    const { ctx } = opts;
    const isClient = typeof window !== 'undefined';

    return {
      abortOnUnmount: true,
      queryClient,
      transformer: superjson,
      links: [
        authedCacheBypassLink,
        loggerLink({
          enabled: (opts) =>
            (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
            (opts.direction === 'down' &&
              opts.result instanceof Error &&
              !isAbortError(opts.result)),
        }),
        httpLink({
          url: isClient ? url : `${env.NEXT_PUBLIC_BASE_URL as string}${url}`,
          headers: getHeaders(ctx),
        }),
        // splitLink({
        //   // do not batch post requests
        //   condition: (op) => (op.type === 'query' ? op.context.skipBatch === true : true),
        //   // when condition is true, use normal request
        //   true: httpLink({ url, headers: getHeaders }),
        //   // when condition is false, use batching
        //   // false: unstable_httpBatchStreamLink({ url, maxURLLength: 2083 }),
        //   false: httpLink({ url, headers: getHeaders }), // Let's disable batching for now
        // }),
      ],
    };
  },
  ssr: false,
});

export const handleTRPCError = (
  error: any,
  message = 'There was an error while performing your request'
) => {
  try {
    // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
    const parsedError = JSON.parse(error.message);
    showErrorNotification({
      title: message,
      error: parsedError,
    });
  } catch (e) {
    // Report old error as is:
    showErrorNotification({
      title: message,
      error: new Error(error.message),
    });
  }
};
