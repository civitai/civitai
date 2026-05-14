// src/utils/trpc.ts
import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import type { CreateTRPCProxyClient, TRPCLink } from '@trpc/client';
import { createTRPCProxyClient, httpLink, loggerLink } from '@trpc/client';
import type { CreateTRPCNext } from '@trpc/next';
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
};

const url = '/api/trpc';

/**
 * Max URL length before we convert a GET query to POST.
 * Keeps total header size (URL + cookies) under typical proxy limits (~8KB).
 */
const MAX_GET_URL_LENGTH = 4000;

/**
 * Custom fetch that converts large GET requests to POST with a method override
 * header. This prevents HTTP 431 (Request Header Fields Too Large) when query
 * inputs are large (e.g. whatIfFromGraph with many resources and long prompts).
 *
 * The server-side handler in `[trpc].ts` reads `x-trpc-method-override` and
 * translates the request back to GET so tRPC resolves it as a query — preserving
 * the full query cache on the client.
 */
const largeFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
  if (init?.method === 'GET' && url.length > MAX_GET_URL_LENGTH) {
    const [base, query] = url.split('?', 2);
    const params = new URLSearchParams(query);
    const body = params.get('input');
    // Strip input from URL, keep other params (like batch=1)
    params.delete('input');
    const remaining = params.toString();
    const newUrl = remaining ? `${base}?${remaining}` : base;

    return fetch(newUrl, {
      ...init,
      method: 'POST',
      body,
      headers: {
        ...(init?.headers as Record<string, string>),
        'content-type': 'application/json',
        'x-trpc-method-override': 'GET',
      },
    });
  }
  return fetch(input, init);
};
const headers: RequestHeaders = {
  'x-client-version': process.env.version,
  'x-client-date': Date.now().toString(),
  'x-client': 'web',
};

/**
 * Shared QueryClient config. Used by both the per-request server `QueryClient`
 * (created by `@trpc/next` via `queryClientConfig` below) and the singleton
 * browser `QueryClient` returned by `getQueryClient()` for callsites that
 * import `queryClient` directly.
 */
const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: Infinity,
    },
  },
};

/**
 * Browser-only QueryClient singleton.
 *
 * IMPORTANT: never construct this at module scope. Doing so on the server
 * means every SSR request shares one `QueryCache`, which only ever grows.
 * A heap snapshot from civitai-dp-prod on 2026-05-14 found 11,962 retained
 * `Query` objects on a single pod traceable to a module-scope `QueryClient`.
 *
 * Callsites that import { queryClient } from this module run only in the
 * browser (mutation `onSuccess` callbacks, event handlers, `useEffect`).
 * Touching this on the server will throw to prevent the leak from coming back.
 */
let browserQueryClient: QueryClient | undefined;
function getBrowserQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    throw new Error(
      '[trpc] queryClient was accessed on the server. Use `useQueryClient()` ' +
        'inside a component, or pass `queryClientConfig` to tRPC so a fresh ' +
        'QueryClient is created per request.'
    );
  }
  if (!browserQueryClient) browserQueryClient = new QueryClient(queryClientConfig);
  return browserQueryClient;
}

/**
 * Proxy preserves the existing `import { queryClient } from '~/utils/trpc'`
 * call sites without forcing them to call a function. Property access is
 * lazy, so the singleton is only created when first touched in the browser.
 */
export const queryClient: QueryClient = new Proxy({} as QueryClient, {
  get(_target, prop, receiver) {
    const client = getBrowserQueryClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
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
    return { ...ctx?.req?.headers, ...headers };
  };
}

export const trpcVanilla: CreateTRPCProxyClient<AppRouter> = createTRPCProxyClient<AppRouter>({
  transformer: superjson,
  links: [
    authedCacheBypassLink,
    loggerLink({
      enabled: (opts) =>
        (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
        (opts.direction === 'down' && opts.result instanceof Error),
    }),
    httpLink({
      url,
      fetch: largeFetch,
      headers: getHeaders(),
    }),
  ],
});

export const trpc: CreateTRPCNext<AppRouter, NextPageContext, null> = createTRPCNext<AppRouter>({
  config(opts) {
    const { ctx } = opts;
    const isClient = typeof window !== 'undefined';

    return {
      // On the browser, reuse the same singleton `QueryClient` that direct
      // `import { queryClient }` callsites read/write — otherwise their
      // `setQueriesData`/`cancelQueries` would target a different cache than
      // the one `useQuery` hooks subscribe to.
      //
      // On the server, omit `queryClient` so `@trpc/next` falls through to
      // `new QueryClient(config.queryClientConfig)` per request — the prior
      // module-scope singleton accumulated 11,962 `Query` objects per pod
      // (heap snapshot, civitai-dp-prod, 2026-05-14).
      ...(isClient ? { queryClient: getBrowserQueryClient() } : { queryClientConfig }),
      transformer: superjson,
      links: [
        authedCacheBypassLink,
        loggerLink({
          enabled: (opts) =>
            (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
            (opts.direction === 'down' && opts.result instanceof Error),
        }),
        httpLink({
          url: isClient ? url : `${env.NEXT_PUBLIC_BASE_URL as string}${url}`,
          fetch: isClient ? largeFetch : undefined,
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
